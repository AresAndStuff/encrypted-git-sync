/**
 * Exercises the exact stack the plugin uses inside Obsidian (mobile too):
 * lightning-fs on IndexedDB for the shadow repo, and the requestUrl-based
 * HTTP adapter. Obsidian's requestUrl is replaced by a fetch-based stand-in.
 */

import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: async (req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    contentType?: string;
    body?: ArrayBuffer;
  }) => {
    const headers = { ...req.headers, ...(req.contentType ? { "content-type": req.contentType } : {}) };
    const res = await fetch(req.url, { method: req.method, headers, body: req.body });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      arrayBuffer: await res.arrayBuffer(),
    };
  },
}));

import "../src/polyfills";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import LightningFS from "@isomorphic-git/lightning-fs";
import nodeHttp from "isomorphic-git/http/node";
import type { PromiseFsClient } from "isomorphic-git";
import { createRepoMeta, unlockRepo } from "../src/core/crypto";
import { MemoryStateStore } from "../src/core/state";
import { SyncEngine, type KeyProvider } from "../src/core/syncEngine";
import { ShadowRepo } from "../src/git/shadowRepo";
import { obsidianHttp } from "../src/obsidian/http";
import { startGitServer, type TestGitServer } from "./helpers/gitServer";
import { MemoryVault } from "./helpers/memoryVault";

const keys: KeyProvider = {
  unlock: (meta) => unlockRepo(meta, "a long passphrase"),
  create: () => createRepoMeta("a long passphrase", 1_000),
};

let server: TestGitServer;
let work: string;
beforeAll(async () => {
  server = await startGitServer();
  work = mkdtempSync(join(tmpdir(), "egs-mobile-"));
});
afterAll(async () => {
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

describe("Obsidian stack (lightning-fs + requestUrl)", () => {
  it("syncs with a desktop device in both directions", async () => {
    server.createBareRepo("m.git");
    const url = server.url("m.git");

    const lfs = new LightningFS("egs-test-phone", { wipe: true });
    const phoneVault = new MemoryVault();
    const phone = new SyncEngine(
      new ShadowRepo({ promises: lfs.promises } as unknown as PromiseFsClient, "/abc.git", {
        url,
        branch: "encrypted-main",
        http: obsidianHttp,
      }),
      phoneVault,
      keys,
      new MemoryStateStore(),
      { deviceName: "phone" },
    );

    const desktopVault = new MemoryVault();
    const desktop = new SyncEngine(
      new ShadowRepo(nodeFs, join(work, "desktop.git"), { url, branch: "encrypted-main", http: nodeHttp }),
      desktopVault,
      keys,
      new MemoryStateStore(),
      { deviceName: "desktop" },
    );

    phoneVault.set("Mobile/idea.md", "written on the phone\n");
    const binary = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    await phoneVault.write("Mobile/photo.bin", binary);
    expect((await phone.sync()).pushed).toBe(true);

    await desktop.sync();
    expect(desktopVault.get("Mobile/idea.md")).toBe("written on the phone\n");
    expect(await desktopVault.read("Mobile/photo.bin")).toEqual(binary);

    desktopVault.set("Desktop/reply.md", "answered on the desktop\n");
    await desktop.sync();
    await phone.sync();
    expect(phoneVault.get("Desktop/reply.md")).toBe("answered on the desktop\n");
  });
});
