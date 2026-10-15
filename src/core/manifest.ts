/**
 * The manifest maps real vault paths to content hashes. It is stored
 * compressed and encrypted as manifest.enc, so the Git host never learns
 * file names, folder structure or which files changed together.
 *
 * Blob locations are not stored: they are derived from the path with
 * HMAC (see blobPathFor), which keeps the manifest small.
 */

import { deflate, inflate } from "pako";
import { decryptBytes, encryptBytes, type VaultKeys } from "./crypto";
import { utf8Decode, utf8Encode } from "./encoding";

export const MANIFEST_VERSION = 1;
export const MANIFEST_AAD = "egs:manifest";

export interface FileEntry {
  deleted?: false;
  /** SHA-256 (hex) of the plaintext content. */
  hash: string;
  size: number;
  /** Modification time in ms, carried across devices. */
  mtime: number;
}

/**
 * Remembers that a file was deleted. Lets a device with no sync history
 * (for example a fresh install restored from an old backup) recognise
 * a file as deleted instead of re-uploading it.
 */
export interface Tombstone {
  deleted: true;
  /** Hash of the last content before deletion. */
  hash: string;
  deletedAt: number;
}

export type ManifestEntry = FileEntry | Tombstone;

export interface Manifest {
  version: number;
  updatedAt: number;
  files: Record<string, ManifestEntry>;
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, updatedAt: 0, files: {} };
}

export async function encryptManifest(keys: VaultKeys, manifest: Manifest): Promise<Uint8Array> {
  const sorted: Record<string, ManifestEntry> = {};
  for (const path of Object.keys(manifest.files).sort()) sorted[path] = manifest.files[path];
  const json = JSON.stringify({ ...manifest, files: sorted });
  return encryptBytes(keys, deflate(utf8Encode(json)), MANIFEST_AAD);
}

export async function decryptManifest(keys: VaultKeys, data: Uint8Array): Promise<Manifest> {
  const plain = await decryptBytes(keys, data, MANIFEST_AAD);
  const manifest = JSON.parse(utf8Decode(inflate(plain))) as Manifest;
  if (manifest.version > MANIFEST_VERSION) {
    throw new Error(`Manifest version ${manifest.version} is newer than this plugin supports. Update the plugin.`);
  }
  return manifest;
}

/** Live (non-deleted) entries only. */
export function liveFiles(manifest: Manifest): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!entry.deleted) out.set(path, entry);
  }
  return out;
}

/** Drops tombstones older than maxAgeDays. Returns the number removed. */
export function pruneTombstones(manifest: Manifest, now: number, maxAgeDays: number): number {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.deleted && entry.deletedAt < cutoff) {
      delete manifest.files[path];
      removed++;
    }
  }
  return removed;
}
