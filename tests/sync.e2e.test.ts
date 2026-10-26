/**
 * End-to-end: several "devices" sync through a real Git smart-HTTP server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as nodeFs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "isomorphic-git/http/node";
import { createRepoMeta, unlockRepo, WrongPassphraseError, type RepoMeta } from "../src/core/crypto";
import { MemoryStateStore } from "../src/core/state";
import { SyncAbortedError, SyncEngine, type KeyProvider, type SyncOptions } from "../src/core/syncEngine";
import { ShadowRepo } from "../src/git/shadowRepo";
import { squashHistory } from "../src/git/squash";
import { DEFAULT_RETENTION } from "../src/core/retention";
import { startGitServer, type TestGitServer } from "./helpers/gitServer";
import { MemoryVault } from "./helpers/memoryVault";
import { createFormat1Meta } from "./helpers/legacy";
import { changeRepoPassphrase } from "../src/git/changePassphrase";
import { rotateRepoKey, RotationRacedError } from "../src/git/rotateKey";
import { fileHistory, listVersions, planVaultRestore, readFileAt, restoreFile, restoreVault } from "../src/git/history";
import { parseRepoMeta } from "../src/core/crypto";

const ITER = 1_000;

function keyProvider(passphrase: string | (() => string), format1 = false): KeyProvider {
  const pass = typeof passphrase === "function" ? passphrase : () => passphrase;
  return {
    unlock: (meta: RepoMeta) => unlockRepo(meta, pass()),
    create: () => (format1 ? createFormat1Meta(pass(), ITER) : createRepoMeta(pass(), ITER)),
  };
}

let server: TestGitServer;
let work: string;
let counter = 0;

beforeAll(async () => {
  server = await startGitServer();
  work = mkdtempSync(join(tmpdir(), "egs-devices-"));
});
afterAll(async () => {
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

class Device {
  vault = new MemoryVault();
  state = new MemoryStateStore();
  repo: ShadowRepo;
  engine: SyncEngine;
  clock: { now: number };
  passphrase: string;

  constructor(
    url: string,
    name: string,
    passphrase = "pw",
    clock = { now: Date.UTC(2026, 9, 15, 12) },
    extra: Partial<SyncOptions> & { format1?: boolean } = {},
    RepoClass: typeof ShadowRepo = ShadowRepo,
  ) {
    this.clock = clock;
    this.repo = new RepoClass(nodeFs, join(work, `${name}-${++counter}.git`), { url, branch: "main", http });
    this.passphrase = passphrase;
    this.engine = new SyncEngine(this.repo, this.vault, keyProvider(() => this.passphrase, extra.format1 ?? false), this.state, {
      deviceName: name,
      now: () => this.clock.now,
      ...extra,
    });
  }
  sync() {
    return this.engine.sync();
  }
}

function newRemote(): string {
  const name = `vault-${++counter}.git`;
  server.createBareRepo(name);
  return name;
}

describe("two devices", () => {
  it("syncs, merges, handles conflicts and deletions, and leaks no plaintext", async () => {
    const name = newRemote();
    const url = server.url(name);
    const clock = { now: Date.UTC(2026, 9, 15, 12) };
    const a = new Device(url, "laptop", "pw", clock);
    const b = new Device(url, "phone", "pw", clock);

    a.vault.set("Therapie/Termin mit Dr. Müller.md", "# Termin\n\nDienstag 10 Uhr\n");
    a.vault.set("Ideas.md", "one\ntwo\nthree\n");
    const first = await a.sync();
    expect(first.pushed).toBe(true);
    expect(first.summary.upload).toBe(2);

    // The Git host sees neither names nor content.
    const clone = join(work, `inspect-${counter}`);
    execFileSync("git", ["clone", "--quiet", join(server.root, name), clone]);
    const listing = execFileSync("git", ["-C", clone, "ls-files"]).toString();
    expect(listing).not.toMatch(/Therapie|Müller|Ideas/);
    expect(listing).toMatch(/^blobs\//m);
    const grep = execFileSync("sh", ["-c", `grep -rl "Dienstag" ${clone} || true`]).toString();
    expect(grep).toBe("");

    // Second device pulls everything.
    await b.sync();
    expect(b.vault.paths()).toEqual(["Ideas.md", "Therapie/Termin mit Dr. Müller.md"]);
    expect(b.vault.get("Ideas.md")).toBe("one\ntwo\nthree\n");

    // Non-overlapping edits on both devices merge cleanly.
    clock.now += 60_000;
    a.vault.set("Ideas.md", "ONE\ntwo\nthree\n");
    b.vault.set("Ideas.md", "one\ntwo\nthree\nfour\n");
    await a.sync();
    const merged = await b.sync();
    expect(merged.merged).toEqual(["Ideas.md"]);
    expect(b.vault.get("Ideas.md")).toBe("ONE\ntwo\nthree\nfour\n");
    await a.sync();
    expect(a.vault.get("Ideas.md")).toBe("ONE\ntwo\nthree\nfour\n");

    // Competing edits of the same line produce a conflict copy, nothing is lost.
    clock.now += 60_000;
    a.vault.set("Ideas.md", "ONE (laptop)\ntwo\nthree\nfour\n");
    b.vault.set("Ideas.md", "ONE (phone)\ntwo\nthree\nfour\n");
    await a.sync();
    const conflicted = await b.sync();
    expect(conflicted.conflicts).toHaveLength(1);
    const copy = conflicted.conflicts[0];
    expect(copy).toMatch(/^Ideas \(conflict .* phone\)\.md$/);
    expect(b.vault.get("Ideas.md")).toBe("ONE (phone)\ntwo\nthree\nfour\n");
    expect(b.vault.get(copy)).toBe("ONE (laptop)\ntwo\nthree\nfour\n");
    await a.sync();
    expect(a.vault.get("Ideas.md")).toBe("ONE (phone)\ntwo\nthree\nfour\n");
    expect(a.vault.get(copy)).toBe("ONE (laptop)\ntwo\nthree\nfour\n");

    // Deletion propagates.
    b.vault.remove(copy);
    await b.sync();
    await a.sync();
    expect(a.vault.get(copy)).toBeUndefined();

    // A sync with no changes pushes nothing.
    const idle = await a.sync();
    expect(idle.pushed).toBe(false);
  });

  it("refuses a wrong passphrase", async () => {
    const url = server.url(newRemote());
    const a = new Device(url, "a", "right");
    a.vault.set("x.md", "x");
    await a.sync();
    const c = new Device(url, "c", "wrong");
    await expect(c.sync()).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(c.vault.paths()).toEqual([]);
  });

  it("retries when another device pushes during sync", async () => {
    const url = server.url(newRemote());
    const a = new Device(url, "a");
    a.vault.set("shared.md", "base\n");
    await a.sync();
    const other = new Device(url, "other");
    await other.sync();

    let raced = false;
    class RacingRepo extends ShadowRepo {
      async push(oid: string, force = false) {
        if (!raced) {
          raced = true;
          other.vault.set("from-other.md", "hello\n");
          await other.sync();
        }
        return super.push(oid, force);
      }
    }
    const b = new Device(url, "b", "pw", undefined, {}, RacingRepo);
    b.vault.set("from-b.md", "hi\n");
    const result = await b.sync();
    expect(result.attempts).toBe(2);
    expect(b.vault.paths()).toEqual(["from-b.md", "from-other.md", "shared.md"]);
    await a.sync();
    expect(a.vault.paths()).toEqual(["from-b.md", "from-other.md", "shared.md"]);
  });

  it("asks before mass deletion and does nothing if declined", async () => {
    const url = server.url(newRemote());
    const a = new Device(url, "a");
    for (let i = 0; i < 20; i++) a.vault.set(`n${i}.md`, `note ${i}`);
    await a.sync();
    for (let i = 0; i < 20; i++) a.vault.remove(`n${i}.md`);
    await expect(a.sync()).rejects.toBeInstanceOf(SyncAbortedError);

    const b = new Device(url, "b");
    await b.sync();
    expect(b.vault.paths()).toHaveLength(20);
  });

  it("does not delete local files when the remote is wiped and re-created", async () => {
    const name = newRemote();
    const url = server.url(name);
    const a = new Device(url, "a");
    a.vault.set("keep.md", "important");
    await a.sync();

    rmSync(join(server.root, name), { recursive: true, force: true });
    server.createBareRepo(name);
    const result = await a.sync();
    expect(result.summary.deleteLocal).toBe(0);
    expect(result.summary.upload).toBe(1);
    expect(a.vault.get("keep.md")).toBe("important");
  });

  it("does not resurrect a deleted note from a stale copy on a new device", async () => {
    const url = server.url(newRemote());
    const a = new Device(url, "a");
    a.vault.set("old.md", "obsolete");
    a.vault.set("live.md", "live");
    await a.sync();
    a.vault.remove("old.md");
    await a.sync();

    const restored = new Device(url, "restored-from-backup");
    restored.vault.set("old.md", "obsolete");
    await restored.sync();
    expect(restored.vault.paths()).toEqual(["live.md"]);
  });
});

describe("passphrase change", () => {
  const OLD = "old passphrase 1";
  const NEW = "new passphrase 22";

  async function remoteMeta(name: string) {
    const json = execFileSync("git", ["-C", join(server.root, name), "show", "main:meta.json"]).toString();
    return parseRepoMeta(json);
  }

  for (const format1 of [false, true]) {
    it(`changes it on one device; others switch without re-syncing${format1 ? " (format 1 repo)" : ""}`, async () => {
      const name = newRemote();
      const url = server.url(name);
      const a = new Device(url, "a", OLD, undefined, { format1 });
      const b = new Device(url, "b", OLD, undefined, { format1 });
      a.vault.set("Notes/one.md", "one\n");
      a.vault.set("Notes/two.md", "two\n");
      await a.sync();
      await b.sync();
      const before = await remoteMeta(name);
      expect(before.format).toBe(format1 ? 1 : 2);

      if (format1) {
        // State files written by 0.1.0 named the repository id "repoSalt".
        const legacy = (await b.state.load())! as unknown as Record<string, unknown>;
        legacy.repoSalt = legacy.repoId;
        delete legacy.repoId;
        await b.state.save(legacy as never);
      }

      const result = await changeRepoPassphrase(a.repo, OLD, NEW, { iterations: ITER });
      expect(result.upgraded).toBe(format1);

      const after = await remoteMeta(name);
      expect(after.format).toBe(2);
      expect(after.repoId ?? after.kdf.salt).toBe(before.repoId ?? before.kdf.salt);
      const changed = execFileSync("git", ["-C", join(server.root, name), "diff", "--name-only", "main~1", "main"])
        .toString()
        .trim();
      expect(changed).toBe("meta.json");

      // b still has the old passphrase: refused, and nothing is touched.
      b.vault.set("Notes/one.md", "one, edited on b\n");
      await expect(b.sync()).rejects.toBeInstanceOf(WrongPassphraseError);
      expect(b.vault.get("Notes/one.md")).toBe("one, edited on b\n");

      // With the new passphrase b continues exactly where it was: no reset,
      // no conflict copies, only its own edit goes out.
      b.passphrase = NEW;
      const resumed = await b.sync();
      expect(resumed.conflicts).toEqual([]);
      expect(resumed.summary.upload).toBe(1);
      expect(resumed.summary.download).toBe(0);

      a.passphrase = NEW;
      await a.sync();
      expect(a.vault.get("Notes/one.md")).toBe("one, edited on b\n");

      // A brand-new device needs the new passphrase.
      const c = new Device(url, "c", OLD);
      await expect(c.sync()).rejects.toBeInstanceOf(WrongPassphraseError);
      c.passphrase = NEW;
      await c.sync();
      expect(c.vault.paths()).toEqual(["Notes/one.md", "Notes/two.md"]);
    });
  }

  it("refuses a wrong current passphrase and leaves the remote unchanged", async () => {
    const name = newRemote();
    const a = new Device(server.url(name), "a", OLD);
    a.vault.set("x.md", "x");
    await a.sync();
    const head = execFileSync("git", ["-C", join(server.root, name), "rev-parse", "main"]).toString();
    await expect(changeRepoPassphrase(a.repo, "not the passphrase", NEW, { iterations: ITER })).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    expect(execFileSync("git", ["-C", join(server.root, name), "rev-parse", "main"]).toString()).toBe(head);
  });

  it("retries if another device pushes during the change", async () => {
    const url = server.url(newRemote());
    const a = new Device(url, "a", OLD);
    a.vault.set("x.md", "x");
    await a.sync();
    const other = new Device(url, "other", OLD);
    await other.sync();

    let raced = false;
    class RacingRepo extends ShadowRepo {
      async push(oid: string, force = false) {
        if (!raced) {
          raced = true;
          other.vault.set("y.md", "y");
          await other.sync();
        }
        return super.push(oid, force);
      }
    }
    const changer = new Device(url, "changer", OLD, undefined, {}, RacingRepo);
    await changeRepoPassphrase(changer.repo, OLD, NEW, { iterations: ITER });

    a.passphrase = NEW;
    await a.sync();
    expect(a.vault.paths()).toEqual(["x.md", "y.md"]);
  });
});

describe("key rotation", () => {
  const OLD = "old passphrase 1";
  const NEW = "new passphrase 22";
  const git = (name: string, ...args: string[]) =>
    execFileSync("git", ["-C", join(server.root, name), ...args]).toString().trim();

  for (const format1 of [false, true]) {
    it(`re-encrypts everything, drops history, and other devices continue${format1 ? " (format 1 repo)" : ""}`, async () => {
      const name = newRemote();
      const url = server.url(name);
      const a = new Device(url, "a", OLD, undefined, { format1 });
      const b = new Device(url, "b", OLD, undefined, { format1 });
      a.vault.set("Notes/one.md", "one\n");
      a.vault.set("Notes/two.md", "two\n");
      a.vault.set("gone.md", "deleted later\n");
      await a.sync();
      a.vault.remove("gone.md");
      await a.sync();
      await b.sync();
      const oldBlobs = git(name, "ls-tree", "-r", "--name-only", "main").split("\n").filter((p) => p.startsWith("blobs/"));
      const oldMeta = parseRepoMeta(git(name, "show", "main:meta.json"));

      const result = await rotateRepoKey(a.repo, OLD, NEW, { iterations: ITER, stateStore: a.state });
      expect(result.files).toBe(2);

      // One commit, every blob path new, old passphrase useless.
      expect(git(name, "rev-list", "--count", "main")).toBe("1");
      const newBlobs = git(name, "ls-tree", "-r", "--name-only", "main").split("\n").filter((p) => p.startsWith("blobs/"));
      expect(newBlobs).toHaveLength(2);
      expect(newBlobs.some((p) => oldBlobs.includes(p))).toBe(false);
      const meta = parseRepoMeta(git(name, "show", "main:meta.json"));
      expect(meta.format).toBe(2);
      expect(meta.previousRepoIds?.[0]).toBe(oldMeta.repoId ?? oldMeta.kdf.salt);
      await expect(unlockRepo(meta, OLD)).rejects.toBeInstanceOf(WrongPassphraseError);

      // The rotating device continues without any work.
      a.passphrase = NEW;
      const again = await a.sync();
      expect(again.pushed).toBe(false);
      expect(again.summary.download + again.summary.upload).toBe(0);

      // Another device: refused with the old passphrase, then resumes with its
      // state intact (no downloads, no conflicts); its pending edit goes out,
      // and the tombstone still prevents "gone.md" from coming back.
      b.vault.set("Notes/two.md", "two, edited on b\n");
      await expect(b.sync()).rejects.toBeInstanceOf(WrongPassphraseError);
      b.passphrase = NEW;
      const resumed = await b.sync();
      expect(resumed.conflicts).toEqual([]);
      expect(resumed.summary.download).toBe(0);
      expect(resumed.summary.upload).toBe(1);
      await a.sync();
      expect(a.vault.get("Notes/two.md")).toBe("two, edited on b\n");

      const fresh = new Device(url, "fresh", NEW);
      fresh.vault.set("gone.md", "deleted later\n");
      await fresh.sync();
      expect(fresh.vault.paths()).toEqual(["Notes/one.md", "Notes/two.md"]);
    });
  }

  it("aborts without changes if another device pushed meanwhile", async () => {
    const name = newRemote();
    const url = server.url(name);
    const a = new Device(url, "a", OLD);
    a.vault.set("x.md", "x");
    await a.sync();
    const other = new Device(url, "other", OLD);
    await other.sync();

    class RacingRepo extends ShadowRepo {
      raced = false;
      async peekRemoteHead() {
        if (!this.raced) {
          this.raced = true;
          other.vault.set("y.md", "y");
          await other.sync();
        }
        return super.peekRemoteHead();
      }
    }
    const rotator = new Device(url, "rotator", OLD, undefined, {}, RacingRepo);
    const before = git(name, "rev-parse", "main");
    await expect(rotateRepoKey(rotator.repo, OLD, NEW, { iterations: ITER })).rejects.toBeInstanceOf(RotationRacedError);
    // Only the other device's commit landed; the old key still works.
    expect(git(name, "rev-parse", "main~1")).toBe(before);
    await a.sync();
    expect(a.vault.paths()).toEqual(["x.md", "y.md"]);
  });
});

describe("version history", () => {
  const PASS = "history passphrase";
  const keysOf = async (d: Device) => {
    const head = (await d.repo.fetch())!;
    const tree = await d.repo.readTreeMap(head);
    return unlockRepo(parseRepoMeta(new TextDecoder().decode(await d.repo.readBlob(tree.get("meta.json")!))), PASS);
  };

  it("lists file versions and restores one, as a new version other devices receive", async () => {
    const url = server.url(newRemote());
    const clock = { now: Date.UTC(2026, 9, 20, 9) };
    const a = new Device(url, "a", PASS, clock);
    const b = new Device(url, "b", PASS, clock);

    a.vault.set("plan.md", "v1\n");
    a.vault.set("other.md", "x\n");
    await a.sync();
    clock.now += 3_600_000;
    a.vault.set("other.md", "y\n"); // plan.md unchanged in this version
    await a.sync();
    clock.now += 3_600_000;
    a.vault.set("plan.md", "v2\n");
    await a.sync();
    clock.now += 3_600_000;
    a.vault.set("plan.md", "v3\n");
    await a.sync();
    await b.sync();

    const keys = await keysOf(a);
    const versions = await listVersions(a.repo);
    expect(versions).toHaveLength(4);
    expect(versions[0].timestamp).toBeGreaterThan(versions[3].timestamp);

    const history = await fileHistory(a.repo, keys, "plan.md", versions);
    const contents = await Promise.all(
      history.map(async (v) => new TextDecoder().decode((await readFileAt(a.repo, keys, v.oid, "plan.md"))!)),
    );
    expect(contents).toEqual(["v3\n", "v2\n", "v1\n"]); // v1 appears once despite two commits

    // Restore v1 as a copy, then over the file.
    const copy = await restoreFile(a.repo, keys, a.vault, history[2].oid, "plan.md", {
      asCopy: true,
      timestamp: history[2].timestamp,
      stateStore: a.state,
    });
    expect(copy).toMatch(/^plan \(version \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    expect(a.vault.get(copy)).toBe("v1\n");
    await restoreFile(a.repo, keys, a.vault, history[2].oid, "plan.md", { stateStore: a.state });
    expect(a.vault.get("plan.md")).toBe("v1\n");

    // The restore syncs like any edit; history grows, nothing is rewritten.
    clock.now += 60_000;
    await a.sync();
    expect(await listVersions(a.repo)).toHaveLength(5);
    await b.sync();
    expect(b.vault.get("plan.md")).toBe("v1\n");
    expect(b.vault.get(copy)).toBe("v1\n");
  });

  it("restores the whole vault, including deleted and later-added files, and can jump back", async () => {
    const url = server.url(newRemote());
    const clock = { now: Date.UTC(2026, 9, 20, 9) };
    const a = new Device(url, "a", PASS, clock);
    const b = new Device(url, "b", PASS, clock);

    a.vault.set("keep.md", "old\n");
    a.vault.set("Folder/deleted-later.md", "bring me back\n");
    await a.sync();
    clock.now += 86_400_000;
    a.vault.set("keep.md", "new\n");
    a.vault.remove("Folder/deleted-later.md");
    a.vault.set("added-later.md", "added\n");
    await a.sync();
    await b.sync();

    const keys = await keysOf(a);
    const [latest, old] = await listVersions(a.repo);

    const plan = await planVaultRestore(a.repo, keys, a.vault, old.oid);
    expect(plan.write).toEqual(["Folder/deleted-later.md", "keep.md"]);
    expect(plan.remove).toEqual(["added-later.md"]);

    await restoreVault(a.repo, keys, a.vault, old.oid, plan, { stateStore: a.state });
    expect(a.vault.paths()).toEqual(["Folder/deleted-later.md", "keep.md"]);
    expect(a.vault.get("keep.md")).toBe("old\n");

    clock.now += 60_000;
    await a.sync();
    await b.sync();
    expect(b.vault.paths()).toEqual(["Folder/deleted-later.md", "keep.md"]);

    // Jump back to the state before the restore.
    await restoreVault(a.repo, keys, a.vault, latest.oid, undefined, { stateStore: a.state });
    clock.now += 60_000;
    await a.sync();
    await b.sync();
    expect(b.vault.paths()).toEqual(["added-later.md", "keep.md"]);
    expect(b.vault.get("keep.md")).toBe("new\n");
  });

  it("still reads versions from before a passphrase change", async () => {
    const url = server.url(newRemote());
    const a = new Device(url, "a", PASS);
    a.vault.set("n.md", "before\n");
    await a.sync();
    await changeRepoPassphrase(a.repo, PASS, "another passphrase", { iterations: ITER });
    a.passphrase = "another passphrase";
    const head = (await a.repo.fetch())!;
    const tree = await a.repo.readTreeMap(head);
    const keys = await unlockRepo(
      parseRepoMeta(new TextDecoder().decode(await a.repo.readBlob(tree.get("meta.json")!))),
      "another passphrase",
    );
    const versions = await listVersions(a.repo);
    expect(versions[0].message).toBe("change passphrase");
    expect(new TextDecoder().decode((await readFileAt(a.repo, keys, versions[1].oid, "n.md"))!)).toBe("before\n");
  });
});

describe("recovery tool", () => {
  it("decrypts a plain git clone without Obsidian", async () => {
    const name = newRemote();
    const a = new Device(server.url(name), "a", "recover me please");
    a.vault.set("Deep/Folder/Ü note.md", "unicode ✓\n");
    a.vault.set("top.md", "top\n");
    await a.sync();

    const { build } = await import("esbuild");
    const cli = join(work, "recover.mjs");
    await build({
      entryPoints: ["src/cli/recover.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: cli,
      logLevel: "silent",
    });
    const clone = join(work, `recover-clone-${counter}`);
    const out = join(work, `recovered-${counter}`);
    execFileSync("git", ["clone", "--quiet", "--branch", "main", join(server.root, name), clone]);
    const log = execFileSync("node", [cli, clone, out], {
      env: { ...process.env, EGS_PASSPHRASE: "recover me please" },
    }).toString();
    expect(JSON.parse(nodeFs.readFileSync(join(clone, "meta.json"), "utf8")).format).toBe(2);
    expect(log).toMatch(/Restored 2 file/);
    expect(nodeFs.readFileSync(join(out, "Deep/Folder/Ü note.md"), "utf8")).toBe("unicode ✓\n");

    expect(() =>
      execFileSync("node", [cli, clone, join(work, "nope")], {
        env: { ...process.env, EGS_PASSPHRASE: "wrong" },
        stdio: "pipe",
      }),
    ).toThrow();
  });
});

describe("history squashing", () => {
  it("applies the retention policy and other devices keep syncing", async () => {
    const name = newRemote();
    const url = server.url(name);
    const clock = { now: Date.UTC(2025, 6, 1, 9) };
    const a = new Device(url, "a", "pw", clock);
    const b = new Device(url, "b", "pw", clock);

    // An edit every ~2.5 days for 15 months, then a busy last week.
    let n = 0;
    const edit = async () => {
      a.vault.set("journal.md", `entry ${++n}\n`);
      await a.sync();
    };
    while (clock.now < Date.UTC(2026, 9, 8, 12)) {
      await edit();
      clock.now += 60 * 3_600_000;
    }
    while (clock.now < Date.UTC(2026, 9, 15, 18)) {
      await edit();
      clock.now += 7 * 3_600_000;
    }
    await b.sync();
    const before = (await a.repo.log((await a.repo.fetch())!)).length;
    expect(before).toBe(n);

    const result = await squashHistory(a.repo, {
      policy: DEFAULT_RETENTION,
      zone: "utc",
      now: clock.now,
      minCommits: 50,
    });
    expect(result.status).toBe("squashed");
    if (result.status !== "squashed") return;
    expect(result.after).toBeLessThanOrEqual(29);

    // The server's history is the squashed one and is a valid Git repository.
    const count = execFileSync("git", ["-C", join(server.root, name), "rev-list", "--count", "main"]).toString().trim();
    expect(Number(count)).toBe(result.after);
    execFileSync("git", ["-C", join(server.root, name), "fsck", "--strict", "--no-dangling"]);

    // Both devices continue as usual on the rewritten history.
    b.vault.set("journal.md", "after squash from b\n");
    clock.now += 60_000;
    await b.sync();
    await a.sync();
    expect(a.vault.get("journal.md")).toBe("after squash from b\n");

    // A brand-new device can start from the squashed history.
    const c = new Device(url, "c", "pw", clock);
    await c.sync();
    expect(c.vault.get("journal.md")).toBe("after squash from b\n");
  });
});
