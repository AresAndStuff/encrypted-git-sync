/**
 * Version history: list earlier versions and bring them back.
 *
 * Every commit on the sync branch is a full snapshot of the vault (encrypted
 * manifest + blobs), so any kept commit can be read back. Which commits exist
 * depends on squashing (by default: 5 of today, 7 daily, 4 weekly, 12 monthly).
 *
 * Restoring never rewrites history. It writes the old content into the vault
 * as an ordinary local change; the next sync uploads it as a new version.
 * That keeps restores safe for other devices and undoable: the version from
 * before the restore stays in the history, so you can jump back to it.
 *
 * All commits reachable from the branch head are encrypted with the current
 * master key: a passphrase change keeps the key, and a key rotation replaces
 * the whole history. So the session keys can read every listed version.
 */

import { blobPathFor, decryptBytes, sha256Hex, type VaultKeys } from "../core/crypto";
import { decryptManifest, liveFiles, type FileEntry } from "../core/manifest";
import { conflictCopyPath } from "../core/merge";
import { IntegrityError, MANIFEST_PATH, type VaultIO } from "../core/syncEngine";
import type { StateStore } from "../core/state";
import type { ShadowRepo } from "./shadowRepo";

/**
 * Base hash for files a restore brought back. It matches no real content, so
 * the planner sees "changed locally" and uploads the file. Without it, a file
 * restored after being deleted would match the remote tombstone and the
 * anti-resurrection rule in planner.ts would delete it again.
 * readBase() finds no blob for it, so a conflicting edit becomes a copy.
 */
export const RESTORED_BASE_HASH = "restored";

/** Marks restored paths that this device has no base for (see RESTORED_BASE_HASH). */
async function markRestored(stateStore: StateStore | undefined, paths: string[]): Promise<void> {
  if (!stateStore || paths.length === 0) return;
  const state = await stateStore.load();
  if (!state) return;
  for (const path of paths) {
    if (!state.files[path]) state.files[path] = { hash: RESTORED_BASE_HASH, blob: "" };
  }
  await stateStore.save(state);
}

/** One commit on the sync branch. */
export interface VaultVersion {
  oid: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** "sync …", "change passphrase", "rotate encryption key". */
  message: string;
}

/** One distinct content of a single file, as it appeared in the history. */
export interface FileVersion {
  /** Newest commit that has this content (the moment it was last synced as such). */
  oid: string;
  timestamp: number;
  hash: string;
  size: number;
}

/** A decrypted snapshot of one commit: path -> entry, and path -> blob oid. */
interface Snapshot {
  files: Map<string, FileEntry>;
  tree: Map<string, string>;
}

/** All versions, newest first. Fetches first so the list is current. */
export async function listVersions(repo: ShadowRepo): Promise<VaultVersion[]> {
  await repo.ensureInitialized();
  const head = await repo.fetch();
  if (!head) return [];
  const commits = await repo.log(head);
  return commits.map((c) => ({ oid: c.oid, timestamp: c.timestamp, message: c.message.trim() }));
}

async function readSnapshot(repo: ShadowRepo, keys: VaultKeys, oid: string): Promise<Snapshot> {
  const tree = await repo.readTreeMap(oid);
  const manifestOid = tree.get(MANIFEST_PATH);
  if (!manifestOid) throw new IntegrityError(`Version ${oid.slice(0, 7)} has no manifest.`);
  try {
    const manifest = await decryptManifest(keys, await repo.readBlob(manifestOid));
    return { files: liveFiles(manifest), tree };
  } catch (e) {
    if (e instanceof IntegrityError) throw e;
    throw new IntegrityError(`Version ${oid.slice(0, 7)} cannot be decrypted with the current key.`);
  }
}

/** Decrypts one file from a snapshot and checks it against the manifest hash. */
async function readFromSnapshot(repo: ShadowRepo, keys: VaultKeys, snap: Snapshot, path: string): Promise<Uint8Array> {
  const entry = snap.files.get(path);
  if (!entry) throw new IntegrityError(`"${path}" does not exist in this version.`);
  const blobPath = await blobPathFor(keys, path);
  const oid = snap.tree.get(blobPath);
  if (!oid) throw new IntegrityError(`The stored data for "${path}" is missing in this version.`);
  const data = await decryptBytes(keys, await repo.readBlob(oid), blobPath);
  if ((await sha256Hex(data)) !== entry.hash) {
    throw new IntegrityError(`"${path}" in this version does not match its checksum.`);
  }
  return data;
}

/** Content of `path` at version `oid`, or null if the file did not exist then. */
export async function readFileAt(
  repo: ShadowRepo,
  keys: VaultKeys,
  oid: string,
  path: string,
): Promise<Uint8Array | null> {
  const snap = await readSnapshot(repo, keys, oid);
  return snap.files.has(path) ? readFromSnapshot(repo, keys, snap, path) : null;
}

/**
 * The distinct contents `path` had, newest first. Consecutive versions with
 * the same content are collapsed; each entry points at the newest commit
 * holding that content. Versions where the file did not exist are skipped.
 */
export async function fileHistory(
  repo: ShadowRepo,
  keys: VaultKeys,
  path: string,
  versions?: VaultVersion[],
): Promise<FileVersion[]> {
  const all = versions ?? (await listVersions(repo));
  const out: FileVersion[] = [];
  let previousHash: string | null = null;
  for (const v of all) {
    const entry = (await readSnapshot(repo, keys, v.oid)).files.get(path);
    const hash = entry?.hash ?? null;
    if (entry && hash !== previousHash) {
      out.push({ oid: v.oid, timestamp: v.timestamp, hash: entry.hash, size: entry.size });
    }
    previousHash = hash;
  }
  return out;
}

/**
 * Writes the content `path` had at version `oid` into the vault, either over
 * the current file or as a separate copy ("Note (version 2026-10-20 1403).md").
 * Returns the path written.
 */
export async function restoreFile(
  repo: ShadowRepo,
  keys: VaultKeys,
  vault: VaultIO,
  oid: string,
  path: string,
  options: { asCopy?: boolean; timestamp?: number; stateStore?: StateStore } = {},
): Promise<string> {
  const data = await readFileAt(repo, keys, oid, path);
  if (!data) throw new IntegrityError(`"${path}" does not exist in this version.`);
  let target = path;
  if (options.asCopy) {
    const existing = new Set((await vault.list()).map((f) => f.path));
    target = conflictCopyPath(path, new Date(options.timestamp ?? Date.now()), "", (p) => existing.has(p), "version");
  }
  await vault.write(target, data);
  await markRestored(options.stateStore, [target]);
  return target;
}

export interface VaultRestorePlan {
  /** Files that will be created or overwritten with their old content. */
  write: string[];
  /** Synced files that did not exist in that version; they go to the trash. */
  remove: string[];
  /** Files that already match. */
  unchanged: number;
}

/**
 * What restoring the whole vault to `oid` would change. Only looks at files
 * that take part in sync (VaultIO.list is already filtered), so ignored files
 * and Obsidian's config folder are never touched.
 */
export async function planVaultRestore(
  repo: ShadowRepo,
  keys: VaultKeys,
  vault: VaultIO,
  oid: string,
): Promise<VaultRestorePlan> {
  const snap = await readSnapshot(repo, keys, oid);
  const local = new Map<string, string>();
  for (const f of await vault.list()) local.set(f.path, await sha256Hex(await vault.read(f.path)));

  const plan: VaultRestorePlan = { write: [], remove: [], unchanged: 0 };
  for (const [path, entry] of snap.files) {
    if (local.get(path) === entry.hash) plan.unchanged++;
    else plan.write.push(path);
  }
  for (const path of local.keys()) if (!snap.files.has(path)) plan.remove.push(path);
  plan.write.sort();
  plan.remove.sort();
  return plan;
}

/**
 * Restores the whole vault to version `oid` (as computed by planVaultRestore).
 * Removed files go through VaultIO.delete, which in Obsidian uses the trash.
 */
export async function restoreVault(
  repo: ShadowRepo,
  keys: VaultKeys,
  vault: VaultIO,
  oid: string,
  plan?: VaultRestorePlan,
  options: { stateStore?: StateStore; onProgress?: (message: string) => void } = {},
): Promise<VaultRestorePlan> {
  const p = plan ?? (await planVaultRestore(repo, keys, vault, oid));
  const snap = await readSnapshot(repo, keys, oid);
  // Decrypt and verify everything first, so a damaged version changes nothing.
  const contents = new Map<string, Uint8Array>();
  for (const path of p.write) contents.set(path, await readFromSnapshot(repo, keys, snap, path));

  let done = 0;
  for (const [path, data] of contents) {
    if (++done % 50 === 1) options.onProgress?.(`Restoring ${done}/${contents.size}…`);
    // No old mtime: the sync's hash cache keys on mtime+size, and reusing an
    // old mtime could hide this change from the next sync.
    await vault.write(path, data);
  }
  for (const path of p.remove) await vault.delete(path);
  await markRestored(options.stateStore, p.write);
  return p;
}
