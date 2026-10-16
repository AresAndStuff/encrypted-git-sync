/** In-memory VaultIO for tests. Each write bumps a fake mtime. */
import type { VaultFile, VaultIO } from "../../src/core/syncEngine";
import { utf8Decode, utf8Encode } from "../../src/core/encoding";

/** In-memory vault standing in for Obsidian's vault in tests. */
export class MemoryVault implements VaultIO {
  private files = new Map<string, { data: Uint8Array; mtime: number }>();
  private clock = 1_700_000_000_000;

  set(path: string, text: string): void {
    this.files.set(path, { data: utf8Encode(text), mtime: ++this.clock });
  }

  get(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? utf8Decode(f.data) : undefined;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async list(): Promise<VaultFile[]> {
    return [...this.files].map(([path, f]) => ({ path, size: f.data.length, mtime: f.mtime }));
  }
  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`No such file: ${path}`);
    return f.data;
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, { data: new Uint8Array(data), mtime: ++this.clock });
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
