/**
 * Key rotation: re-encrypts the whole repository with a brand-new master key
 * and replaces the history with a single commit.
 *
 * Use this when the old passphrase (or a device) may be compromised. A plain
 * passphrase change (changePassphrase.ts) is not enough in that case: old
 * commits keep the old meta.json, and the old passphrase still unwraps the
 * old master key from it.
 *
 * What happens:
 *   1. Fetch, unlock with the current passphrase, decrypt the manifest.
 *   2. Decrypt every live file, verify its hash, re-encrypt it with the new
 *      key under its new (HMAC-derived) blob path.
 *   3. Write a new meta.json (new salt, new master key, new repoId, the old
 *      repoId listed in previousRepoIds) and a re-encrypted manifest.
 *   4. Commit with no parent, check nobody pushed meanwhile, force-push.
 *   5. Update this device's sync state to the new blobs.
 *
 * Other devices notice on their next sync: their cached key and remembered
 * passphrase no longer fit, so they ask for the new passphrase. Because the
 * old repoId is listed in previousRepoIds and plaintext hashes are unchanged,
 * they keep their sync state and nothing is re-downloaded.
 *
 * Limits: the Git host may keep the old, now unreachable objects for a while
 * (GitHub can still serve them by commit id). For a hard guarantee, delete
 * the remote repository and push to a new one; see the README.
 */

import {
  blobPathFor,
  createRotatedMeta,
  decryptBytes,
  encryptBytes,
  parseRepoMeta,
  sha256Hex,
  unlockRepo,
  type RepoMeta,
  type VaultKeys,
} from "../core/crypto";
import { utf8Decode, utf8Encode } from "../core/encoding";
import { decryptManifest, encryptManifest } from "../core/manifest";
import type { StateStore } from "../core/state";
import { IntegrityError, MANIFEST_PATH, META_PATH, README_PATH, REPO_README } from "../core/syncEngine";
import type { ShadowRepo } from "./shadowRepo";

export interface RotateKeyOptions {
  /** PBKDF2 iterations for the new passphrase (default: the current default). */
  iterations?: number;
  now?: () => number;
  /** This device's sync state; updated to the new blobs after a successful push. */
  stateStore?: StateStore;
  onProgress?: (message: string) => void;
}

export interface RotateKeyResult {
  head: string;
  meta: RepoMeta;
  keys: VaultKeys;
  /** Number of files re-encrypted. */
  files: number;
}

/** Another device pushed while we were re-encrypting. Nothing was changed. */
export class RotationRacedError extends Error {
  constructor() {
    super("Another device synced during key rotation. Nothing was changed; please try again.");
    this.name = "RotationRacedError";
  }
}

export async function rotateRepoKey(
  repo: ShadowRepo,
  oldPassphrase: string,
  newPassphrase: string,
  options: RotateKeyOptions = {},
): Promise<RotateKeyResult> {
  const now = options.now ?? (() => Date.now());
  const progress = options.onProgress ?? (() => undefined);
  await repo.ensureInitialized();

  // 1. Current state of the remote, readable with the old key.
  progress("Fetching…");
  const head = await repo.fetch();
  if (!head) throw new Error("The remote repository is empty. Sync once before rotating the key.");
  const tree = await repo.readTreeMap(head);
  const metaOid = tree.get(META_PATH);
  const manifestOid = tree.get(MANIFEST_PATH);
  if (!metaOid || !manifestOid) {
    throw new Error("meta.json or manifest.enc is missing; this does not look like an Encrypted Git Sync repository.");
  }
  const oldMeta = parseRepoMeta(utf8Decode(await repo.readBlob(metaOid)));
  const oldKeys = await unlockRepo(oldMeta, oldPassphrase); // throws WrongPassphraseError
  const manifest = await decryptManifest(oldKeys, await repo.readBlob(manifestOid));

  // 2. New key, then re-encrypt every live file. Tombstones carry no content.
  const { meta, keys } = await createRotatedMeta(oldMeta, newPassphrase, options.iterations, new Date(now()));
  const newTree = new Map<string, string>();
  const newBlobs = new Map<string, { hash: string; blob: string }>();
  const live = Object.entries(manifest.files).filter(([, e]) => !e.deleted);

  let done = 0;
  for (const [path, entry] of live) {
    if (++done % 50 === 1) progress(`Re-encrypting ${done}/${live.length}…`);
    const oldBlobPath = await blobPathFor(oldKeys, path);
    const oid = tree.get(oldBlobPath);
    if (!oid) throw new IntegrityError(`Remote blob for "${path}" is missing; rotation aborted, nothing was changed.`);
    const data = await decryptBytes(oldKeys, await repo.readBlob(oid), oldBlobPath);
    // Never carry corrupted data into the new history.
    if ((await sha256Hex(data)) !== entry.hash) {
      throw new IntegrityError(`Content of "${path}" does not match the manifest; rotation aborted.`);
    }
    const newBlobPath = await blobPathFor(keys, path);
    const newOid = await repo.writeBlob(await encryptBytes(keys, data, newBlobPath));
    newTree.set(newBlobPath, newOid);
    newBlobs.set(path, { hash: entry.hash, blob: newOid });
  }

  // 3. Metadata, manifest and the plaintext README.
  manifest.updatedAt = now();
  newTree.set(MANIFEST_PATH, await repo.writeBlob(await encryptManifest(keys, manifest)));
  newTree.set(META_PATH, await repo.writeBlob(utf8Encode(JSON.stringify(meta, null, 2) + "\n")));
  newTree.set(README_PATH, await repo.writeBlob(utf8Encode(REPO_README)));

  // 4. Orphan commit (no parent) drops all history that the old key can open.
  const commit = await repo.writeCommit(await repo.writeTreeMap(newTree), null, "rotate encryption key", now());
  progress("Pushing…");
  // Lease check: a push by another device since step 1 would be lost by the
  // force-push below. isomorphic-git has no --force-with-lease, so check here.
  if ((await repo.peekRemoteHead()) !== head) throw new RotationRacedError();
  await repo.push(commit, true);

  // 5. Point this device's base state at the new blobs so it does not see a reset.
  if (options.stateStore) {
    const state = await options.stateStore.load();
    if (state) {
      for (const [path, synced] of Object.entries(state.files)) {
        const fresh = newBlobs.get(path);
        if (fresh && fresh.hash === synced.hash) synced.blob = fresh.blob;
      }
      state.repoId = meta.repoId ?? null;
      delete state.repoSalt;
      state.lastCommit = commit;
      await options.stateStore.save(state);
    }
  }

  return { head: commit, meta, keys, files: live.length };
}
