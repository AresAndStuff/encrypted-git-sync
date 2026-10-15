/**
 * Stores the per-device sync state as a JSON file inside the plugin folder
 * (.obsidian/plugins/encrypted-git-sync/sync-state.json). It contains only
 * paths and hashes of this device's last sync and is never uploaded.
 */

import type { DataAdapter } from "obsidian";
import type { StateStore, SyncState } from "../core/state";

export class PluginFileStateStore implements StateStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string,
  ) {}

  async load(): Promise<SyncState | null> {
    if (!(await this.adapter.exists(this.path))) return null;
    try {
      const state = JSON.parse(await this.adapter.read(this.path)) as SyncState;
      return state.version === 1 ? state : null;
    } catch {
      return null;
    }
  }

  async save(state: SyncState): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await this.adapter.write(tmp, JSON.stringify(state));
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
    await this.adapter.rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
  }
}
