/**
 * Plugin entry point: wires the platform-neutral core (src/core, src/git) to
 * Obsidian. Owns the session key, the busy flag, timers and all user-facing
 * notices.
 *
 * Conventions:
 *   - Every operation that touches the remote sets `busy` first, so syncs,
 *     squashes, passphrase changes and key rotations never overlap.
 *   - `keys` is the unlocked master key for this session, cached by repoId.
 *     A passphrase change keeps the repoId (no re-prompt); a key rotation
 *     changes it (other devices are re-prompted).
 *   - Background syncs are "quiet": offline errors only show in the status bar.
 */

import "./polyfills";

import { Notice, Plugin, type TAbstractFile } from "obsidian";
import LightningFS from "@isomorphic-git/lightning-fs";
import type { AuthCallback, PromiseFsClient } from "isomorphic-git";

import { createRepoMeta, repoIdOf, unlockRepo, WrongPassphraseError, type RepoMeta, type VaultKeys } from "./core/crypto";
import { toHex } from "./core/encoding";
import { createPathFilter } from "./core/filters";
import { emptyState } from "./core/state";
import { SyncAbortedError, SyncEngine, type KeyProvider, type SyncResult } from "./core/syncEngine";
import { ShadowRepo } from "./git/shadowRepo";
import { squashHistory } from "./git/squash";
import { changeRepoPassphrase } from "./git/changePassphrase";
import { rotateRepoKey, RotationRacedError } from "./git/rotateKey";
import { obsidianHttp } from "./obsidian/http";
import { askChangePassphrase, askPassphrase, confirm } from "./obsidian/modals";
import { Secrets } from "./obsidian/secrets";
import { PluginFileStateStore } from "./obsidian/stateStore";
import { ObsidianVault } from "./obsidian/vault";
import { DEFAULT_SETTINGS, EncryptedGitSyncSettingTab, type PluginSettings } from "./settings";

export default class EncryptedGitSyncPlugin extends Plugin {
  settings!: PluginSettings;
  secrets!: Secrets;

  private keys: VaultKeys | null = null;
  private lfs: LightningFS | null = null;
  private stateStore!: PluginFileStateStore;
  private statusEl: HTMLElement | null = null;
  private busy = false;
  private pending = false;
  private autoSyncTimer: number | null = null;
  private editTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.secrets = new Secrets(this.app, this.settings.vaultId);
    this.stateStore = new PluginFileStateStore(this.app.vault.adapter, `${this.manifest.dir}/sync-state.json`);

    this.statusEl = this.addStatusBarItem();
    this.setStatus("Encrypted sync: idle");

    this.addRibbonIcon("refresh-cw", "Encrypted sync now", () => void this.runSync());

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({ id: "squash-history", name: "Squash history now", callback: () => void this.runSquash(true) });
    this.addCommand({
      id: "change-passphrase",
      name: "Change encryption passphrase",
      callback: () => void this.changePassphrase(),
    });
    this.addCommand({
      id: "rotate-encryption-key",
      name: "Rotate encryption key (re-encrypt everything)",
      callback: () => void this.rotateKey(),
    });
    this.addCommand({
      id: "forget-passphrase",
      name: "Forget passphrase on this device",
      callback: () => {
        this.forgetPassphrase();
        new Notice("Passphrase forgotten on this device.");
      },
    });
    this.addCommand({
      id: "reset-local-state",
      name: "Reset this device's sync state",
      callback: () => void this.resetLocalState(),
    });

    this.addSettingTab(new EncryptedGitSyncSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const onChange = (file: TAbstractFile) => this.onVaultChange(file);
      this.registerEvent(this.app.vault.on("modify", onChange));
      this.registerEvent(this.app.vault.on("create", onChange));
      this.registerEvent(this.app.vault.on("delete", onChange));
      this.registerEvent(this.app.vault.on("rename", onChange));

      this.scheduleAutoSync();
      if (this.settings.syncOnStartup && this.isConfigured()) void this.runSync({ quiet: true });
    });
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    if (this.editTimer !== null) window.clearTimeout(this.editTimer);
    this.keys = null;
  }

  // --- Settings ---------------------------------------------------------

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginSettings>;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      retention: { ...DEFAULT_SETTINGS.retention, ...(data.retention ?? {}) },
      ignorePatterns: data.ignorePatterns ?? [...DEFAULT_SETTINGS.ignorePatterns],
    };
    if (!this.settings.vaultId) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      this.settings.vaultId = toHex(bytes);
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isConfigured(): boolean {
    return /^https?:\/\//.test(this.settings.remoteUrl);
  }

  isUnlocked(): boolean {
    return this.keys !== null;
  }

  // --- Building blocks --------------------------------------------------

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  private gitFs(): PromiseFsClient {
    if (!this.lfs) this.lfs = new LightningFS(`encrypted-git-sync-${this.settings.vaultId}`);
    return { promises: this.lfs.promises };
  }

  private createRepo(): ShadowRepo {
    const onAuth: AuthCallback = () => {
      const token = this.secrets.get("token");
      if (!token) return { cancel: true };
      return { username: this.settings.username || "oauth2", password: token };
    };
    return new ShadowRepo(this.gitFs(), `/${this.settings.vaultId}.git`, {
      url: this.settings.remoteUrl,
      branch: this.settings.branch,
      http: obsidianHttp,
      onAuth,
    });
  }

  private keyProvider(): KeyProvider {
    return {
      unlock: async (meta: RepoMeta) => {
        // Same master key (a passphrase change keeps it): no need to ask again.
        if (this.keys && this.keys.repoId === repoIdOf(meta)) return this.keys;
        this.keys = null;

        const remembered = this.secrets.get("passphrase");
        if (remembered) {
          try {
            this.keys = await this.derive(() => unlockRepo(meta, remembered));
            return this.keys;
          } catch (e) {
            if (!(e instanceof WrongPassphraseError)) throw e;
            this.secrets.set("passphrase", null);
          }
        }

        let error: string | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          const answer = await askPassphrase(this.app, "unlock", error);
          if (!answer) throw new SyncAbortedError("Sync cancelled: the passphrase is needed to decrypt the vault.");
          try {
            this.keys = await this.derive(() => unlockRepo(meta, answer.passphrase));
            if (answer.remember) this.secrets.set("passphrase", answer.passphrase);
            return this.keys;
          } catch (e) {
            if (!(e instanceof WrongPassphraseError)) throw e;
            error = "Wrong passphrase. Please try again.";
          }
        }
        throw new WrongPassphraseError();
      },
      create: async () => {
        const answer = await askPassphrase(this.app, "create");
        if (!answer) throw new SyncAbortedError("Sync cancelled: no passphrase chosen.");
        const result = await this.derive(() => createRepoMeta(answer.passphrase));
        this.keys = result.keys;
        if (answer.remember) this.secrets.set("passphrase", answer.passphrase);
        return result;
      },
    };
  }

  /** Key derivation takes about a second (intentionally); show that something is happening. */
  private async derive<T>(fn: () => Promise<T>): Promise<T> {
    this.setStatus("Encrypted sync: deriving key…");
    const notice = new Notice("Deriving encryption key…", 0);
    try {
      return await fn();
    } finally {
      notice.hide();
    }
  }

  private createEngine(repo: ShadowRepo): SyncEngine {
    const s = this.settings;
    const filter = createPathFilter({
      ignorePatterns: s.ignorePatterns,
      syncAttachments: s.syncAttachments,
      maxFileSizeMB: s.maxFileSizeMB,
    });
    return new SyncEngine(repo, new ObsidianVault(this.app, filter), this.keyProvider(), this.stateStore, {
      deviceName: s.deviceName,
      tombstoneMaxAgeDays: s.tombstoneMaxAgeDays,
      onProgress: (msg) => this.setStatus(`Encrypted sync: ${msg}`),
      confirmMassDeletion: ({ local, remote, total }) =>
        confirm(
          this.app,
          "Delete many files?",
          `This sync would delete ${local} file(s) in this vault and ${remote} file(s) on the remote ` +
            `(out of ${total}). This can happen after moving the vault or if the remote was changed. Continue?`,
          "Delete and sync",
        ),
    });
  }

  // --- Sync -------------------------------------------------------------

  private onVaultChange(file: TAbstractFile): void {
    // Ignore config changes and the plugin's own writes during a sync.
    if (this.busy || file.path.startsWith(this.app.vault.configDir)) return;
    const seconds = this.settings.syncAfterEditSeconds;
    if (seconds <= 0 || !this.isConfigured()) return;
    if (this.editTimer !== null) window.clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => {
      this.editTimer = null;
      void this.runSync({ quiet: true });
    }, seconds * 1000);
  }

  scheduleAutoSync(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncTimer = window.setInterval(() => {
        if (this.isConfigured()) void this.runSync({ quiet: true });
      }, minutes * 60_000);
    }
  }

  async runSync(options: { quiet?: boolean } = {}): Promise<void> {
    if (!this.isConfigured()) {
      if (!options.quiet) new Notice("Encrypted sync: set the repository URL in the plugin settings first.");
      return;
    }
    if (!this.secrets.get("token")) {
      if (!options.quiet) new Notice("Encrypted sync: add an access token in the plugin settings first.");
      return;
    }
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.setStatus("Encrypted sync: syncing…");
    try {
      const repo = this.createRepo();
      const result = await this.createEngine(repo).sync();
      this.reportResult(result, !!options.quiet);
      await this.maybeSquash(repo);
      this.setStatus(`Encrypted sync: ${formatTime(new Date())}`);
    } catch (e) {
      this.reportError(e, !!options.quiet);
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        void this.runSync({ quiet: true });
      }
    }
  }

  private reportResult(result: SyncResult, quiet: boolean): void {
    const { summary, conflicts, merged } = result;
    const parts: string[] = [];
    const down = summary.download + summary.deleteLocal;
    const up = summary.upload + summary.deleteRemote;
    if (down) parts.push(`${down} in`);
    if (up) parts.push(`${up} out`);
    if (merged.length) parts.push(`${merged.length} merged`);

    if (conflicts.length) {
      new Notice(
        `Encrypted sync: ${conflicts.length} conflict(s). Both versions were kept:\n${conflicts.join("\n")}`,
        15_000,
      );
    } else if (!quiet) {
      new Notice(parts.length ? `Encrypted sync: ${parts.join(", ")}.` : "Encrypted sync: everything up to date.");
    }
  }

  private reportError(e: unknown, quiet: boolean): void {
    console.error("[encrypted-git-sync]", e);
    const message = (e as Error)?.message ?? String(e);
    this.setStatus("Encrypted sync: failed");
    if (e instanceof SyncAbortedError) {
      new Notice(`Encrypted sync: ${message}`, 10_000);
      return;
    }
    const offline = /network|failed to fetch|ENOTFOUND|ECONNREFUSED|timed out|ERR_INTERNET/i.test(message);
    if (quiet && offline) return; // background sync while offline: status bar is enough
    new Notice(`Encrypted sync failed: ${message}`, 10_000);
  }

  // --- History squashing ------------------------------------------------

  private async maybeSquash(repo: ShadowRepo): Promise<void> {
    if (!this.settings.squashEnabled) return;
    const state = (await this.stateStore.load()) ?? emptyState();
    if (Date.now() - state.lastSquashAt < this.settings.squashIntervalHours * 3_600_000) return;
    try {
      this.setStatus("Encrypted sync: tidying history…");
      const result = await squashHistory(repo, {
        policy: this.settings.retention,
        zone: this.settings.retentionZone,
        now: Date.now(),
        minCommits: this.settings.squashMinCommits,
      });
      if (result.status !== "raced") {
        const latest = (await this.stateStore.load()) ?? state;
        latest.lastSquashAt = Date.now();
        await this.stateStore.save(latest);
      }
    } catch (e) {
      // Squashing is housekeeping; a failure must not fail the sync.
      console.warn("[encrypted-git-sync] squash failed", e);
    }
  }

  async runSquash(manual: boolean): Promise<void> {
    if (!this.isConfigured()) return;
    if (this.busy) {
      new Notice("Encrypted sync is busy; try again in a moment.");
      return;
    }
    if (
      manual &&
      !(await confirm(
        this.app,
        "Squash history now?",
        "Older versions outside the retention rules will be removed from the remote permanently. Current notes are not affected.",
        "Squash",
      ))
    ) {
      return;
    }
    this.busy = true;
    try {
      // Sync first so nothing local is left behind, then rewrite.
      const repo = this.createRepo();
      await this.createEngine(repo).sync();
      const result = await squashHistory(repo, {
        policy: this.settings.retention,
        zone: this.settings.retentionZone,
        now: Date.now(),
        minCommits: 2,
      });
      const msg =
        result.status === "squashed"
          ? `History squashed: ${result.before} → ${result.after} versions.`
          : result.status === "raced"
            ? "Another device synced at the same time; nothing changed. Try again."
            : "Nothing to squash.";
      new Notice(`Encrypted sync: ${msg}`);
      if (result.status === "squashed") {
        const state = (await this.stateStore.load()) ?? emptyState();
        state.lastSquashAt = Date.now();
        await this.stateStore.save(state);
      }
    } catch (e) {
      this.reportError(e, false);
    } finally {
      this.busy = false;
    }
  }

  // --- Maintenance ------------------------------------------------------

  async changePassphrase(): Promise<void> {
    if (!this.isConfigured() || !this.secrets.get("token")) {
      new Notice("Encrypted sync: set the repository URL and access token first.");
      return;
    }
    if (this.busy) {
      new Notice("Encrypted sync is busy; try again in a moment.");
      return;
    }
    const input = await askChangePassphrase(this.app);
    if (!input) return;

    this.busy = true;
    const notice = new Notice("Changing passphrase…", 0);
    try {
      const result = await changeRepoPassphrase(this.createRepo(), input.oldPassphrase, input.newPassphrase, {
        onProgress: (msg) => this.setStatus(`Encrypted sync: ${msg}`),
      });
      // The master key is unchanged, so this session stays unlocked.
      this.keys = result.keys;
      this.secrets.set("passphrase", input.remember ? input.newPassphrase : null);
      this.setStatus("Encrypted sync: passphrase changed");
      new Notice(
        "Encrypted sync: passphrase changed. Other devices will ask for the new passphrase on their next sync.",
        10_000,
      );
    } catch (e) {
      if (e instanceof WrongPassphraseError) {
        this.setStatus("Encrypted sync: idle");
        new Notice("Encrypted sync: the current passphrase is wrong. Nothing was changed.", 10_000);
      } else {
        this.reportError(e, false);
      }
    } finally {
      notice.hide();
      this.busy = false;
    }
  }

  /**
   * Full key rotation (see git/rotateKey.ts). Syncs first so this device's
   * edits are in the remote and its base state is current, then re-encrypts.
   */
  async rotateKey(): Promise<void> {
    if (!this.isConfigured() || !this.secrets.get("token")) {
      new Notice("Encrypted sync: set the repository URL and access token first.");
      return;
    }
    if (this.busy) {
      new Notice("Encrypted sync is busy; try again in a moment.");
      return;
    }
    const input = await askChangePassphrase(this.app, "rotate");
    if (!input) return;

    this.busy = true;
    const notice = new Notice("Rotating encryption key…", 0);
    try {
      const repo = this.createRepo();
      await this.createEngine(repo).sync();
      const result = await rotateRepoKey(repo, input.oldPassphrase, input.newPassphrase, {
        stateStore: this.stateStore,
        onProgress: (msg) => this.setStatus(`Encrypted sync: ${msg}`),
      });
      this.keys = result.keys;
      this.secrets.set("passphrase", input.remember ? input.newPassphrase : null);
      this.setStatus("Encrypted sync: key rotated");
      new Notice(
        `Encrypted sync: key rotated, ${result.files} file(s) re-encrypted. ` +
          "Other devices will ask for the new passphrase on their next sync.",
        15_000,
      );
    } catch (e) {
      if (e instanceof WrongPassphraseError) {
        this.setStatus("Encrypted sync: idle");
        new Notice("Encrypted sync: the current passphrase is wrong. Nothing was changed.", 10_000);
      } else if (e instanceof RotationRacedError) {
        this.setStatus("Encrypted sync: idle");
        new Notice(`Encrypted sync: ${e.message}`, 10_000);
      } else {
        this.reportError(e, false);
      }
    } finally {
      notice.hide();
      this.busy = false;
    }
  }

  forgetPassphrase(): void {
    this.keys = null;
    this.secrets.set("passphrase", null);
  }

  async resetLocalState(): Promise<void> {
    if (this.busy) {
      new Notice("Encrypted sync is busy; try again in a moment.");
      return;
    }
    const ok = await confirm(
      this.app,
      "Reset sync state?",
      "This device will forget its sync history and local repository cache. Your notes are not touched. " +
        "The next sync compares everything again; differences become conflict copies.",
      "Reset",
    );
    if (!ok) return;
    await this.stateStore.clear();
    this.lfs = new LightningFS(`encrypted-git-sync-${this.settings.vaultId}`, { wipe: true });
    this.keys = null;
    new Notice("Encrypted sync: local state reset.");
  }

  async testConnection(): Promise<string> {
    if (!this.isConfigured()) throw new Error("Set the repository URL first.");
    if (!this.secrets.get("token")) throw new Error("Add an access token first.");
    const head = await this.createRepo().peekRemoteHead();
    return head
      ? `Connected. Branch "${this.settings.branch}" exists.`
      : `Connected. Branch "${this.settings.branch}" is empty; the first sync will set it up.`;
  }
}

function formatTime(d: Date): string {
  return `synced ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
