/**
 * Secrets (access token, optionally the passphrase) are kept out of data.json,
 * which lives inside the vault folder and may end up in backups or other
 * sync tools. Uses Obsidian's SecretStorage (1.11.4+) when available, else
 * the vault-specific localStorage. Both stay on this device only.
 */

import type { App } from "obsidian";

interface SecretStorageLike {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

export class Secrets {
  constructor(
    private readonly app: App,
    private readonly vaultId: string,
  ) {}

  private get store(): SecretStorageLike | null {
    const s = (this.app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
    return s && typeof s.getSecret === "function" ? s : null;
  }

  private id(name: string): string {
    return `encrypted-git-sync-${name}-${this.vaultId}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
  }

  get(name: "token" | "passphrase"): string | null {
    const store = this.store;
    if (store) {
      const v = store.getSecret(this.id(name));
      if (v) return v;
    }
    const v: unknown = this.app.loadLocalStorage(this.id(name));
    return typeof v === "string" && v ? v : null;
  }

  set(name: "token" | "passphrase", value: string | null): void {
    const store = this.store;
    if (store) {
      store.setSecret(this.id(name), value ?? "");
      this.app.saveLocalStorage(this.id(name), null);
    } else {
      this.app.saveLocalStorage(this.id(name), value || null);
    }
  }

  /** Where secrets are kept, for display in settings. */
  describe(): string {
    return this.store ? "Obsidian secret storage on this device" : "this device's local storage";
  }
}
