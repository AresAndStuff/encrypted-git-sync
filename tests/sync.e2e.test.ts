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

const ITER = 1_000;

function keyProvider(passphrase: string): KeyProvider {
  return {
    unlock: (meta: RepoMeta) => unlockRepo(meta, passphrase),
    create: () => createRepoMeta(passphrase, ITER),
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

  constructor(
    url: string,
    name: string,
    passphrase = "pw",
    clock = { now: Date.UTC(2026, 9, 15, 12) },
    extra: Partial<SyncOptions> = {},
    RepoClass: typeof ShadowRepo = ShadowRepo,
  ) {
    this.clock = clock;
    this.repo = new RepoClass(nodeFs, join(work, `${name}-${++counter}.git`), { url, branch: "main", http });
    this.engine = new SyncEngine(this.repo, this.vault, keyProvider(passphrase), this.state, {
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
