/**
 * Phones crashed (out of memory) because every sync downloaded and loaded the
 * whole history. These tests pin the fix: syncs fetch only the current
 * snapshot, history is downloaded only on demand, and a phone's local store is
 * compacted when it grows. Sizes are measured as bytes stored locally, which is
 * what ends up in memory when isomorphic-git reads a pack.
 */

import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: async (req: { url: string; method: string; headers: Record<string, string>; contentType?: string; body?: ArrayBuffer }) => {
    const headers = { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) };
    const res = await fetch(req.url, { method: req.method, headers, body: req.body });
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), arrayBuffer: await res.arrayBuffer() };
  },
}));

import "../src/polyfills";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import LightningFS from "@isomorphic-git/lightning-fs";
import nodeHttp from "isomorphic-git/http/node";
import type { PromiseFsClient } from "isomorphic-git";
import { createRepoMeta, unlockRepo } from "../src/core/crypto";
import { MemoryStateStore } from "../src/core/state";
import { SyncEngine, type KeyProvider } from "../src/core/syncEngine";
import { ShadowRepo } from "../src/git/shadowRepo";
import { listVersions } from "../src/git/history";
import { squashHistory } from "../src/git/squash";
import { DEFAULT_RETENTION } from "../src/core/retention";
import { obsidianHttp } from "../src/obsidian/http";
import { startGitServer, type TestGitServer } from "./helpers/gitServer";
import { MemoryVault } from "./helpers/memoryVault";

const PASS = "memory test passphrase";
const keys: KeyProvider = { unlock: (m) => unlockRepo(m, PASS), create: () => createRepoMeta(PASS, 1_000) };
const MB = 1_000_000;

let server: TestGitServer;
let work: string;
let n = 0;
beforeAll(async () => {
  server = await startGitServer();
  work = mkdtempSync(join(tmpdir(), "egs-mem-"));
});
afterAll(async () => {
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

/** A desktop that has written 20 versions of a 1 MB attachment (~20 MB history, ~1 MB current). */
async function repoWithHistory() {
  const name = `mem-${++n}.git`;
  server.createBareRepo(name);
  const url = server.url(name);
  const vault = new MemoryVault();
  const repo = new ShadowRepo(nodeFs, join(work, `desk-${n}.git`), { url, branch: "main", http: nodeHttp });
  const desk = new SyncEngine(repo, vault, keys, new MemoryStateStore(), { now: () => Date.now() });
  for (let i = 0; i < 20; i++) {
    await vault.write("photo.bin", randomBytes(MB));
    vault.set("note.md", `version ${i}\n`);
    await desk.sync();
  }
  return { url, desk, vault, repo };
}

function phone(url: string, compact = true) {
  const lfs = new LightningFS(`phone-${++n}`, { wipe: true });
  const repo = new ShadowRepo({ promises: lfs.promises } as unknown as PromiseFsClient, "/p.git", {
    url,
    branch: "main",
    http: obsidianHttp,
  });
  const vault = new MemoryVault();
  const engine = new SyncEngine(repo, vault, keys, new MemoryStateStore(), { compactLocalRepo: compact });
  return { repo, vault, engine };
}

describe("phone memory", () => {
  it("syncs download only the current snapshot, not the history", async () => {
    const { url, vault: deskVault, desk } = await repoWithHistory();
    const p = phone(url);
    await p.engine.sync();
    expect((await p.vault.read("photo.bin")).length).toBe(MB);
    expect((await p.repo.packStats()).bytes).toBeLessThan(3 * MB); // history is ~20 MB

    // Follow-up syncs add only what changed.
    await deskVault.write("photo.bin", randomBytes(MB));
    await desk.sync();
    await p.engine.sync();
    expect((await p.repo.packStats()).bytes).toBeLessThan(5 * MB);
  });

  it("downloads the full history only when version history is opened", async () => {
    const { url } = await repoWithHistory();
    const p = phone(url);
    await p.engine.sync();
    expect((await p.repo.shallowCommits()).size).toBe(1);
    const versions = await listVersions(p.repo);
    expect(versions).toHaveLength(20);
    expect((await p.repo.shallowCommits()).size).toBe(0);
  });

  it("compacts a phone store that holds old history (e.g. from plugin 0.4.0 and older)", async () => {
    const { url } = await repoWithHistory();
    const p = phone(url);
    await p.engine.sync();
    await p.repo.deepen(); // simulate the old behaviour: full history stored locally
    expect((await p.repo.packStats()).bytes).toBeGreaterThan(15 * MB);

    const before = p.vault.paths();
    const result = await p.engine.sync();
    expect(result.summary.download + result.summary.upload + result.summary.deleteLocal).toBe(0);
    expect((await p.repo.packStats()).bytes).toBe(0); // wiped after the sync

    await p.engine.sync(); // re-downloads just the snapshot, nothing changes in the vault
    expect(p.vault.paths()).toEqual(before);
    expect((await p.repo.packStats()).bytes).toBeLessThan(3 * MB);
  });

  it("squashing from a shallow store downloads the history first and loses nothing", async () => {
    const { url } = await repoWithHistory();
    const p = phone(url, false);
    await p.engine.sync();
    const now = Date.now() + 86_400_000;
    const result = await squashHistory(p.repo, { policy: DEFAULT_RETENTION, zone: "utc", now, minCommits: 2 });
    // All 20 commits are from "yesterday": only the last one of that day is kept.
    expect(result).toMatchObject({ status: "squashed", before: 20, after: 1 });
  });
});
