/**
 * Per-device sync state. Stored next to the plugin (never synced), it is the
 * "base" for three-way comparison: what this device last agreed on with the
 * remote.
 */

export interface SyncedFile {
  /** SHA-256 of the plaintext at the last sync. */
  hash: string;
  /** Git oid of the encrypted blob at the last sync; used as the merge base. */
  blob: string;
}

export interface CachedHash {
  mtime: number;
  size: number;
  hash: string;
}

export interface SyncState {
  version: 1;
  /** Remote commit this device last synced with. */
  lastCommit: string | null;
  /** KDF salt of the repository; a change means the repo was re-created. */
  repoSalt: string | null;
  files: Record<string, SyncedFile>;
  /** Avoids re-hashing unchanged files: keyed by path, valid while mtime+size match. */
  hashCache: Record<string, CachedHash>;
  lastSyncAt: number;
  lastSquashAt: number;
}

export function emptyState(): SyncState {
  return {
    version: 1,
    lastCommit: null,
    repoSalt: null,
    files: {},
    hashCache: {},
    lastSyncAt: 0,
    lastSquashAt: 0,
  };
}

export interface StateStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  private state: SyncState | null = null;
  async load(): Promise<SyncState | null> {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(state: SyncState): Promise<void> {
    this.state = structuredClone(state);
  }
}
