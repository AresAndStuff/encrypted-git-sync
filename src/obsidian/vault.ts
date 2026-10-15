/**
 * VaultIO implementation backed by Obsidian's Vault API.
 *
 * Uses the Vault API (not raw file access) so open editors, the file
 * explorer and other plugins see changes immediately. Deletions go through
 * the user's trash setting. Obsidian's config folder and dot-folders are
 * never included, because the Vault API does not list them.
 */

import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { VaultFile, VaultIO } from "../core/syncEngine";
import { isTextPath } from "../core/merge";
import { bytesEqual, utf8Decode, utf8Encode } from "../core/encoding";

export class ObsidianVault implements VaultIO {
  constructor(
    private readonly app: App,
    private readonly include: (path: string, size: number) => boolean,
  ) {}

  async list(): Promise<VaultFile[]> {
    return this.app.vault
      .getFiles()
      .filter((f) => this.include(f.path, f.stat.size))
      .map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`Not a file: ${path}`);
    return f;
  }

  async read(path: string): Promise<Uint8Array> {
    // Always binary: byte-exact, so hashes match what other devices compute.
    return new Uint8Array(await this.app.vault.readBinary(this.file(path)));
  }

  async write(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    const p = normalizePath(path);
    const options = mtime ? { mtime } : undefined;
    // Text goes through the text API so open editors update in place, but only
    // if it round-trips byte-exactly (valid UTF-8); otherwise write raw bytes.
    const text = isTextPath(p) ? losslessText(data) : null;
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      if (text !== null) await this.app.vault.modify(existing, text, options);
      else await this.app.vault.modifyBinary(existing, toArrayBuffer(data), options);
      return;
    }
    await this.ensureFolder(p);
    if (text !== null) await this.app.vault.create(p, text, options);
    else await this.app.vault.createBinary(p, toArrayBuffer(data), options);
  }

  async delete(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (f) await this.app.fileManager.trashFile(f);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const folder = filePath.slice(0, slash);
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error(`Cannot create folder "${folder}": a file with that name exists.`);
    await this.ensureFolder(folder);
    await this.app.vault.createFolder(folder);
  }
}

function losslessText(data: Uint8Array): string | null {
  const text = utf8Decode(data);
  // A leading BOM may be dropped by the editor; keep such files binary.
  if (text.charCodeAt(0) === 0xfeff) return null;
  return bytesEqual(utf8Encode(text), data) ? text : null;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}
