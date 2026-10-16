/**
 * Sync engine: fetch -> decrypt manifest -> three-way plan -> apply -> push.
 *
 * Platform-neutral: the vault, the key source and the state store are passed
 * in as interfaces, so the same engine runs inside Obsidian and in tests.
 */

import {
  blobPathFor,
  decryptBytes,
  encryptBytes,
  parseRepoMeta,
  repoIdOf,
  isSameRepository,
  sha256Hex,
  type RepoMeta,
  type VaultKeys,
} from "./crypto";
import { utf8Decode, utf8Encode } from "./encoding";
import {
  decryptManifest,
  emptyManifest,
  encryptManifest,
  pruneTombstones,
  type FileEntry,
  type Manifest,
} from "./manifest";
import { conflictCopyPath, isTextPath, mergeText } from "./merge";
import { planSync, summarizePlan, type SyncAction } from "./planner";
import { emptyState, type StateStore, type SyncState } from "./state";
import { PushRejectedError, type ShadowRepo } from "../git/shadowRepo";

export const META_PATH = "meta.json";
export const MANIFEST_PATH = "manifest.enc";
export const README_PATH = "README.md";

export const REPO_README = `# Encrypted vault

This repository is managed by the Encrypted Git Sync plugin for Obsidian.
All notes, file names and folder names are encrypted (AES-256-GCM).
Without the passphrase, the contents cannot be read.

Do not edit files here by hand. To recover notes without Obsidian, use the
recovery tool that ships with the plugin (dist/recover.mjs).
`;

export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
}

export interface VaultIO {
  /** All files that should take part in sync (already filtered). */
  list(): Promise<VaultFile[]>;
  read(path: string): Promise<Uint8Array>;
  /** Creates parent folders as needed. */
  write(path: string, data: Uint8Array, mtime?: number): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface KeyProvider {
  /** Existing repository: derive keys from the passphrase and verify them. */
  unlock(meta: RepoMeta): Promise<VaultKeys>;
  /** Empty remote: create a new repository key. */
  create(): Promise<{ meta: RepoMeta; keys: VaultKeys }>;
}

export interface SyncOptions {
  deviceName: string;
  tombstoneMaxAgeDays: number;
  /**
   * Called before deleting many files at once (a common symptom of a wrong
   * vault, an emptied folder or a broken remote). Return false to abort.
   */
  confirmMassDeletion?: (info: { local: number; remote: number; total: number }) => Promise<boolean>;
  /** Fraction of tracked files above which confirmMassDeletion is asked. */
  massDeletionThreshold: number;
  maxAttempts: number;
  now?: () => number;
  onProgress?: (message: string) => void;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  deviceName: "",
  tombstoneMaxAgeDays: 90,
  massDeletionThreshold: 0.5,
  maxAttempts: 3,
};

export interface SyncResult {
  summary: Record<SyncAction["type"], number>;
  conflicts: string[];
  merged: string[];
  pushed: boolean;
  head: string | null;
  attempts: number;
}

export class SyncAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncAbortedError";
  }
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

interface RemoteSnapshot {
  head: string | null;
  tree: Map<string, string>;
  meta: RepoMeta;
  keys: VaultKeys;
  manifest: Manifest;
  isNew: boolean;
}

export class SyncEngine {
  private readonly options: SyncOptions;

  constructor(
    private readonly repo: ShadowRepo,
    private readonly vault: VaultIO,
    private readonly keyProvider: KeyProvider,
    private readonly stateStore: StateStore,
    options: Partial<SyncOptions> = {},
  ) {
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...options };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private progress(message: string): void {
    this.options.onProgress?.(message);
  }

  async sync(): Promise<SyncResult> {
    await this.repo.ensureInitialized();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        const result = await this.syncOnce();
        return { ...result, attempts: attempt };
      } catch (e) {
        if (!(e instanceof PushRejectedError)) throw e;
        lastError = e;
        this.progress("Remote changed during sync, retrying…");
      }
    }
    throw new Error(
      `Sync failed after ${this.options.maxAttempts} attempts because the remote kept changing: ${String(lastError)}`,
    );
  }

  private async loadRemote(): Promise<RemoteSnapshot> {
    this.progress("Fetching…");
    const head = await this.repo.fetch();
    if (!head) {
      const { meta, keys } = await this.keyProvider.create();
      return { head: null, tree: new Map(), meta, keys, manifest: emptyManifest(), isNew: true };
    }
    const tree = await this.repo.readTreeMap(head);
    const metaOid = tree.get(META_PATH);
    const manifestOid = tree.get(MANIFEST_PATH);
    if (!metaOid || !manifestOid) {
      throw new SyncAbortedError(
        "The remote branch exists but is not an Encrypted Git Sync repository (meta.json or manifest.enc missing). " +
          "Use an empty repository or a dedicated branch.",
      );
    }
    const meta = parseRepoMeta(utf8Decode(await this.repo.readBlob(metaOid)));
    const keys = await this.keyProvider.unlock(meta);
    const manifest = await decryptManifest(keys, await this.repo.readBlob(manifestOid));
    return { head, tree, meta, keys, manifest, isNew: false };
  }

  private async scanLocal(state: SyncState): Promise<Map<string, { hash: string; file: VaultFile }>> {
    this.progress("Scanning vault…");
    const files = await this.vault.list();
    const out = new Map<string, { hash: string; file: VaultFile }>();
    const cache: SyncState["hashCache"] = {};
    for (const file of files) {
      const cached = state.hashCache[file.path];
      let hash: string;
      if (cached && cached.mtime === file.mtime && cached.size === file.size) {
        hash = cached.hash;
      } else {
        hash = await sha256Hex(await this.vault.read(file.path));
      }
      cache[file.path] = { mtime: file.mtime, size: file.size, hash };
      out.set(file.path, { hash, file });
    }
    state.hashCache = cache;
    return out;
  }

  /**
   * One sync attempt. Steps, in order:
   *   1. Load this device's state (the "base") and the remote (fetch, unlock, manifest).
   *   2. Detect a wiped/re-created remote and drop the base if so.
   *   3. Hash the vault (cached by mtime+size) and plan per file (planner.ts).
   *   4. Ask before mass deletions.
   *   5. Apply actions: vault writes happen immediately, remote changes are
   *      collected into a new tree.
   *   6. If the remote changed: encrypt the manifest, commit, push.
   *      A rejected push throws PushRejectedError and sync() retries from 1.
   *   7. Save the new base state (only after a successful push).
   * Vault writes in step 5 are safe to repeat on retry: the next attempt sees
   * them as local state that already matches the remote.
   */
  private async syncOnce(): Promise<Omit<SyncResult, "attempts">> {
    const state = (await this.stateStore.load()) ?? emptyState();
    const remote = await this.loadRemote();
    const { keys } = remote;

    // Safety: if the remote was wiped or re-created, the old base would make
    // every local file look "deleted remotely". Start from an empty base.
    // Older state files stored the salt, which equals the id of format 1 repos.
    const knownRepo = state.repoId ?? state.repoSalt ?? null;
    const remoteReset =
      (remote.isNew && state.lastCommit !== null) ||
      // A key rotation changes the id but lists the old one: not a reset.
      (knownRepo !== null && !isSameRepository(remote.meta, knownRepo));
    if (remoteReset) {
      this.progress("Remote repository was re-created; treating this device as new.");
      state.files = {};
    }

    const local = await this.scanLocal(state);
    const base = new Map(Object.entries(state.files).map(([p, f]) => [p, f.hash]));
    const remoteEntries = new Map(Object.entries(remote.manifest.files));
    const actions = planSync({
      base,
      local: new Map([...local].map(([p, v]) => [p, v.hash])),
      remote: remoteEntries,
    });

    const deletesLocal = actions.filter((a) => a.type === "deleteLocal").length;
    const deletesRemote = actions.filter((a) => a.type === "deleteRemote").length;
    const tracked = Math.max(base.size, local.size, 1);
    if (
      deletesLocal + deletesRemote > 10 &&
      (deletesLocal + deletesRemote) / tracked > this.options.massDeletionThreshold
    ) {
      const ok = this.options.confirmMassDeletion
        ? await this.options.confirmMassDeletion({ local: deletesLocal, remote: deletesRemote, total: tracked })
        : false;
      if (!ok) {
        throw new SyncAbortedError(
          `Sync stopped: it would delete ${deletesLocal} local and ${deletesRemote} remote files. Nothing was changed.`,
        );
      }
    }

    // JSON copy instead of structuredClone (missing on iOS before 15.4).
    const manifest = JSON.parse(JSON.stringify(remote.manifest)) as Manifest;
    const tree = new Map(remote.tree);
    const now = this.now();
    let remoteChanged = remote.isNew;
    const conflicts: string[] = [];
    const merged: string[] = [];

    const readRemote = async (path: string): Promise<{ data: Uint8Array; oid: string }> => {
      const entry = manifest.files[path] as FileEntry | undefined;
      const blobPath = await blobPathFor(keys, path);
      const oid = remote.tree.get(blobPath);
      if (!entry || entry.deleted || !oid) throw new IntegrityError(`Remote blob for "${path}" is missing.`);
      const data = await decryptBytes(keys, await this.repo.readBlob(oid), blobPath);
      if ((await sha256Hex(data)) !== entry.hash) {
        throw new IntegrityError(`Content of "${path}" does not match the manifest hash.`);
      }
      return { data, oid };
    };

    const upload = async (path: string, data: Uint8Array, mtime: number): Promise<void> => {
      const blobPath = await blobPathFor(keys, path);
      const hash = await sha256Hex(data);
      const oid = await this.repo.writeBlob(await encryptBytes(keys, data, blobPath));
      tree.set(blobPath, oid);
      manifest.files[path] = { hash, size: data.length, mtime };
      state.files[path] = { hash, blob: oid };
      remoteChanged = true;
    };

    const writeLocal = async (path: string, data: Uint8Array, mtime?: number): Promise<void> => {
      await this.vault.write(path, data, mtime);
      delete state.hashCache[path];
    };

    // The merge base is this device's last synced blob. It may be missing
    // (squashed away) or encrypted with a pre-rotation key; then there is no
    // base and a conflicting edit falls back to a conflict copy.
    const readBase = async (path: string): Promise<Uint8Array | null> => {
      const blob = state.files[path]?.blob;
      if (!blob || !(await this.repo.hasObject(blob))) return null;
      try {
        return await decryptBytes(keys, await this.repo.readBlob(blob), await blobPathFor(keys, path));
      } catch {
        return null;
      }
    };

    this.progress(`Applying ${actions.filter((a) => a.type !== "adopt").length} changes…`);
    for (const action of actions) {
      const { path } = action;
      switch (action.type) {
        case "adopt": {
          const oid = remote.tree.get(await blobPathFor(keys, path));
          if (oid) state.files[path] = { hash: action.hash, blob: oid };
          break;
        }
        case "forget":
          delete state.files[path];
          break;
        case "download": {
          const { data, oid } = await readRemote(path);
          const entry = manifest.files[path] as FileEntry;
          await writeLocal(path, data, entry.mtime);
          state.files[path] = { hash: entry.hash, blob: oid };
          break;
        }
        case "deleteLocal":
          if (await this.vault.exists(path)) await this.vault.delete(path);
          delete state.files[path];
          delete state.hashCache[path];
          break;
        case "upload": {
          const data = await this.vault.read(path);
          await upload(path, data, local.get(path)?.file.mtime ?? now);
          break;
        }
        case "deleteRemote": {
          const blobPath = await blobPathFor(keys, path);
          tree.delete(blobPath);
          const lastHash = state.files[path]?.hash ?? (manifest.files[path] as FileEntry | undefined)?.hash ?? "";
          manifest.files[path] = { deleted: true, hash: lastHash, deletedAt: now };
          delete state.files[path];
          remoteChanged = true;
          break;
        }
        case "merge": {
          const localData = await this.vault.read(path);
          const theirs = await readRemote(path);
          const baseData = isTextPath(path) ? await readBase(path) : null;
          const outcome = baseData
            ? mergeText(utf8Decode(baseData), utf8Decode(localData), utf8Decode(theirs.data))
            : ({ clean: false } as const);

          if (outcome.clean) {
            const mergedData = utf8Encode(outcome.text);
            await writeLocal(path, mergedData);
            await upload(path, mergedData, now);
            merged.push(path);
          } else {
            // Keep the local version in place; save the remote one beside it.
            const existing = new Set([...local.keys(), ...Object.keys(manifest.files)]);
            const copyPath = conflictCopyPath(path, new Date(now), this.options.deviceName, (p) => existing.has(p));
            await writeLocal(copyPath, theirs.data);
            await upload(copyPath, theirs.data, now);
            await upload(path, localData, local.get(path)?.file.mtime ?? now);
            conflicts.push(copyPath);
          }
          break;
        }
      }
    }

    if (pruneTombstones(manifest, now, this.options.tombstoneMaxAgeDays) > 0) remoteChanged = true;

    let head = remote.head;
    let pushed = false;
    if (remoteChanged) {
      this.progress("Encrypting and pushing…");
      manifest.updatedAt = now;
      tree.set(MANIFEST_PATH, await this.repo.writeBlob(await encryptManifest(keys, manifest)));
      if (remote.isNew) {
        tree.set(META_PATH, await this.repo.writeBlob(utf8Encode(JSON.stringify(remote.meta, null, 2) + "\n")));
        tree.set(README_PATH, await this.repo.writeBlob(utf8Encode(REPO_README)));
      }
      const treeOid = await this.repo.writeTreeMap(tree);
      head = await this.repo.writeCommit(treeOid, remote.head, `sync ${new Date(now).toISOString()}`, now);
      await this.repo.push(head);
      pushed = true;
    }

    state.lastCommit = head;
    state.repoId = repoIdOf(remote.meta);
    delete state.repoSalt;
    state.lastSyncAt = now;
    await this.stateStore.save(state);

    return { summary: summarizePlan(actions), conflicts, merged, pushed, head };
  }
}
