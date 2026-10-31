/**
 * The encrypted "shadow" repository.
 *
 * It is a bare repository (only a .git directory, no working copy): the plugin
 * reads and writes Git objects directly, so ciphertext is never duplicated on
 * disk and nothing ever touches the vault folder. On mobile it lives in
 * IndexedDB via lightning-fs; on desktop the same code runs unchanged.
 *
 * Git is used purely as transport and history. Merging happens in plaintext,
 * in the sync engine.
 *
 * Memory: isomorphic-git loads a whole pack file into memory to read one
 * object from it, and downloads arrive as one buffer. So syncs fetch
 * shallowly (depth 1: only the current snapshot), and only operations that
 * need the history (squash, version history) call deepen(). Phones also
 * compact the local store when it grows (compactIfNeeded). See MAINTAINING.md.
 */

import git, { type AuthCallback, type HttpClient, type PromiseFsClient } from "isomorphic-git";
import { withHeadFallback } from "./headFix";

export interface RemoteConfig {
  url: string;
  branch: string;
  http: HttpClient;
  onAuth?: AuthCallback;
}

export interface CommitRecord {
  oid: string;
  tree: string;
  parent: string | null;
  message: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
}

export class PushRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRejectedError";
  }
}

/** The fs calls used directly; isomorphic-git types them loosely. */
interface DirFs {
  stat(path: string): Promise<{ size: number; isDirectory(): boolean }>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, options: { encoding: "utf8" }): Promise<string>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

/** Git's "infinite" depth: asks the server to remove the shallow boundary. */
const UNSHALLOW_DEPTH = 0x7fffffff;
function dirFs(fs: PromiseFsClient): DirFs {
  return fs.promises as unknown as DirFs;
}

const AUTHOR = { name: "Encrypted Git Sync", email: "sync@encrypted-git-sync.invalid" };
const REMOTE = "origin";

export class ShadowRepo {
  readonly cache: Record<string, unknown> = {};

  constructor(
    readonly fs: PromiseFsClient,
    readonly gitdir: string,
    readonly remote: RemoteConfig,
  ) {}

  private get base() {
    return { fs: this.fs, gitdir: this.gitdir, cache: this.cache };
  }

  private get remoteRef(): string {
    return `refs/remotes/${REMOTE}/${this.remote.branch}`;
  }

  async ensureInitialized(): Promise<void> {
    let initialized = true;
    try {
      await dirFs(this.fs).stat(`${this.gitdir}/HEAD`);
    } catch {
      initialized = false;
    }
    if (!initialized) {
      await mkdirp(this.fs, this.gitdir);
      await git.init({ fs: this.fs, gitdir: this.gitdir, bare: true, defaultBranch: this.remote.branch });
    }
    await git.addRemote({ ...this.base, remote: REMOTE, url: this.remote.url, force: true });
  }

  /**
   * Fetches the sync branch. Returns the remote head, or null if the remote
   * repository or branch is still empty (first sync).
   */
  async fetch(): Promise<string | null> {
    const refs = await git.listServerRefs({
      http: this.remote.http,
      url: this.remote.url,
      onAuth: this.remote.onAuth,
      prefix: `refs/heads/${this.remote.branch}`,
    });
    const head = refs.find((r) => r.ref === `refs/heads/${this.remote.branch}`);
    if (!head) return null;

    let haveIt = true;
    try {
      await git.readCommit({ ...this.base, oid: head.oid });
    } catch {
      haveIt = false;
    }
    if (!haveIt) await this.fetchBranch(1);
    // Record the remote head explicitly. This also covers history rewritten
    // by squashing on another device, which is not a fast-forward.
    await git.writeRef({ ...this.base, ref: this.remoteRef, value: head.oid, force: true });
    // Lets isomorphic-git skip objects the remote already has when pushing a
    // rewritten (squashed) history, instead of re-uploading every blob.
    await git.writeRef({
      ...this.base,
      ref: `refs/remotes/${REMOTE}/HEAD`,
      value: this.remoteRef,
      symbolic: true,
      force: true,
    });
    return head.oid;
  }

  /**
   * Downloads the sync branch. depth 1 = only the newest snapshot (plus
   * nothing we already have); UNSHALLOW_DEPTH = the full history. Servers
   * without shallow support get a normal, full fetch.
   */
  private async fetchBranch(depth: number): Promise<void> {
    const args = {
      ...this.base,
      http: withHeadFallback(this.remote.http, this.remote.branch),
      onAuth: this.remote.onAuth,
      remote: REMOTE,
      ref: this.remote.branch,
      remoteRef: this.remote.branch,
      singleBranch: true,
      tags: false,
    };
    try {
      await git.fetch({ ...args, depth });
    } catch (e) {
      if ((e as { code?: string }).code !== "RemoteCapabilityError") throw e;
      await git.fetch(args);
    }
  }

  /** Commits whose parents are not stored locally (Git's "shallow" file). */
  async shallowCommits(): Promise<Set<string>> {
    try {
      const text = await dirFs(this.fs).readFile(`${this.gitdir}/shallow`, { encoding: "utf8" });
      return new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /**
   * Downloads the full history of the sync branch, if it is not local yet.
   * Needed before reading old versions or rewriting history (squash).
   * Costs memory proportional to the history size, so it only runs on demand.
   */
  async deepen(): Promise<void> {
    if ((await this.shallowCommits()).size === 0) return;
    await this.fetchBranch(UNSHALLOW_DEPTH);
  }

  /** Number and total size of local pack files. */
  async packStats(): Promise<{ count: number; bytes: number }> {
    const dir = `${this.gitdir}/objects/pack`;
    let names: string[] = [];
    try {
      names = await dirFs(this.fs).readdir(dir);
    } catch {
      return { count: 0, bytes: 0 };
    }
    let count = 0;
    let bytes = 0;
    for (const name of names) {
      if (!name.endsWith(".pack")) continue;
      count++;
      bytes += (await dirFs(this.fs).stat(`${dir}/${name}`)).size;
    }
    return { count, bytes };
  }

  /**
   * Deletes the local store when it has grown well beyond the current
   * snapshot (many small packs, or old history). The next sync re-downloads
   * just the current snapshot. Only safe between syncs: everything local is
   * either pushed or a leftover of a failed attempt.
   * Returns true if the store was deleted.
   */
  async compactIfNeeded(snapshotBytes: number, maxPacks = 20): Promise<boolean> {
    const { count, bytes } = await this.packStats();
    const tooBig = bytes > 2 * snapshotBytes + 16 * 1024 * 1024;
    if (count <= maxPacks && !tooBig) return false;
    await removeRecursive(this.fs, this.gitdir);
    for (const key of Object.keys(this.cache)) delete this.cache[key];
    await this.ensureInitialized();
    return true;
  }

  /** Current remote head as advertised by the server, without downloading objects. */
  async peekRemoteHead(): Promise<string | null> {
    const refs = await git.listServerRefs({
      http: this.remote.http,
      url: this.remote.url,
      onAuth: this.remote.onAuth,
      prefix: `refs/heads/${this.remote.branch}`,
    });
    return refs.find((r) => r.ref === `refs/heads/${this.remote.branch}`)?.oid ?? null;
  }

  async hasObject(oid: string): Promise<boolean> {
    try {
      await git.readBlob({ ...this.base, oid });
      return true;
    } catch {
      return false;
    }
  }

  /** All files of a commit as path -> blob oid. */
  async readTreeMap(commitOid: string): Promise<Map<string, string>> {
    const { commit } = await git.readCommit({ ...this.base, oid: commitOid });
    const out = new Map<string, string>();
    const walk = async (treeOid: string, prefix: string) => {
      const { tree } = await git.readTree({ ...this.base, oid: treeOid });
      for (const entry of tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === "tree") await walk(entry.oid, path);
        else if (entry.type === "blob") out.set(path, entry.oid);
      }
    };
    await walk(commit.tree, "");
    return out;
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    const { blob } = await git.readBlob({ ...this.base, oid });
    return blob;
  }

  async writeBlob(data: Uint8Array): Promise<string> {
    return git.writeBlob({ ...this.base, blob: data });
  }

  /** Builds nested tree objects from a flat path -> blob oid map. */
  async writeTreeMap(files: ReadonlyMap<string, string>): Promise<string> {
    interface Dir {
      blobs: Map<string, string>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { blobs: new Map(), dirs: new Map() };
    for (const [path, oid] of files) {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.dirs.get(part);
        if (!next) {
          next = { blobs: new Map(), dirs: new Map() };
          dir.dirs.set(part, next);
        }
        dir = next;
      }
      dir.blobs.set(parts[parts.length - 1], oid);
    }
    const write = async (dir: Dir): Promise<string> => {
      const tree: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
      for (const [name, sub] of dir.dirs) tree.push({ mode: "040000", path: name, oid: await write(sub), type: "tree" });
      for (const [name, oid] of dir.blobs) tree.push({ mode: "100644", path: name, oid, type: "blob" });
      return git.writeTree({ ...this.base, tree });
    };
    return write(root);
  }

  async writeCommit(tree: string, parent: string | null, message: string, timestamp: number): Promise<string> {
    const signature = { ...AUTHOR, timestamp: Math.floor(timestamp / 1000), timezoneOffset: 0 };
    return git.writeCommit({
      ...this.base,
      commit: {
        tree,
        parent: parent ? [parent] : [],
        author: signature,
        committer: signature,
        message: message.endsWith("\n") ? message : `${message}\n`,
      },
    });
  }

  async readCommit(oid: string): Promise<CommitRecord> {
    const { commit } = await git.readCommit({ ...this.base, oid });
    return {
      oid,
      tree: commit.tree,
      parent: commit.parent[0] ?? null,
      message: commit.message,
      timestamp: commit.committer.timestamp * 1000,
    };
  }

  /**
   * First-parent history, newest first. Stops at the shallow boundary, so on a
   * shallow store it returns only what is local; call deepen() first when the
   * whole history matters.
   */
  async log(head: string): Promise<CommitRecord[]> {
    const shallow = await this.shallowCommits();
    const out: CommitRecord[] = [];
    let oid: string | null = head;
    while (oid) {
      const c: CommitRecord = await this.readCommit(oid);
      out.push(c);
      oid = shallow.has(c.oid) ? null : c.parent;
    }
    return out;
  }

  /**
   * Pushes `oid` to the sync branch. A non-forced push fails with
   * PushRejectedError if another device pushed in the meantime.
   */
  async push(oid: string, force = false): Promise<void> {
    const localRef = `refs/heads/${this.remote.branch}`;
    await git.writeRef({ ...this.base, ref: localRef, value: oid, force: true });
    let result;
    try {
      result = await git.push({
        ...this.base,
        http: this.remote.http,
        onAuth: this.remote.onAuth,
        remote: REMOTE,
        ref: this.remote.branch,
        remoteRef: this.remote.branch,
        force,
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "PushRejectedError" || /not a simple fast-forward|rejected|fetch first/i.test(err.message ?? "")) {
        throw new PushRejectedError(err.message ?? "Push rejected");
      }
      throw e;
    }
    if (!result.ok) {
      const detail = Object.values(result.refs ?? {})
        .map((r) => r.error)
        .filter(Boolean)
        .join("; ");
      throw new PushRejectedError(detail || result.error || "Push rejected by the server");
    }
    await git.writeRef({ ...this.base, ref: this.remoteRef, value: oid, force: true });
  }
}

async function removeRecursive(fs: PromiseFsClient, path: string): Promise<void> {
  let stat;
  try {
    stat = await dirFs(fs).stat(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of await dirFs(fs).readdir(path)) await removeRecursive(fs, `${path}/${name}`);
    await dirFs(fs).rmdir(path);
  } else {
    await dirFs(fs).unlink(path);
  }
}

async function mkdirp(fs: PromiseFsClient, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let current = dir.startsWith("/") ? "" : ".";
  for (const part of parts) {
    current = `${current}/${part}`;
    try {
      await dirFs(fs).mkdir(current);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
    }
  }
}
