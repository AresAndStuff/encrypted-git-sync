/**
 * Settings model (persisted in data.json) and the settings tab.
 *
 * data.json lives inside the vault, so it must never hold secrets: the access
 * token and passphrase go through obsidian/secrets.ts instead. When adding a
 * setting, add it to PluginSettings and DEFAULT_SETTINGS; loadSettings() in
 * main.ts merges stored values over the defaults, so old data.json files keep
 * working.
 */

import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import { DEFAULT_IGNORE_PATTERNS } from "./core/filters";
import { DEFAULT_RETENTION, type CalendarZone, type RetentionPolicy } from "./core/retention";
import type EncryptedGitSyncPlugin from "./main";

export interface PluginSettings {
  /** Random per-vault id, used to namespace secrets and the local Git store. */
  vaultId: string;
  remoteUrl: string;
  branch: string;
  username: string;
  deviceName: string;

  syncOnStartup: boolean;
  /** Minutes between automatic syncs; 0 = off. */
  autoSyncMinutes: number;
  /** Seconds after the last edit before syncing; 0 = off. */
  syncAfterEditSeconds: number;

  syncAttachments: boolean;
  maxFileSizeMB: number;
  ignorePatterns: string[];

  squashEnabled: boolean;
  squashMinCommits: number;
  squashIntervalHours: number;
  retention: RetentionPolicy;
  retentionZone: CalendarZone;

  tombstoneMaxAgeDays: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  vaultId: "",
  remoteUrl: "",
  branch: "encrypted-main",
  username: "",
  deviceName: "",

  syncOnStartup: true,
  autoSyncMinutes: 10,
  syncAfterEditSeconds: 0,

  syncAttachments: false,
  maxFileSizeMB: 20,
  ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],

  squashEnabled: true,
  squashMinCommits: 60,
  squashIntervalHours: 24,
  retention: { ...DEFAULT_RETENTION },
  retentionZone: "local",

  tombstoneMaxAgeDays: 90,
};

export class EncryptedGitSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: EncryptedGitSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    // --- Remote ---------------------------------------------------------
    new Setting(containerEl).setName("Remote repository").setHeading();

    new Setting(containerEl)
      .setName("Repository URL")
      .setDesc("HTTPS URL of an empty, ideally private repository, e.g. https://github.com/you/vault-sync.git")
      .addText((t) =>
        t
          .setPlaceholder("https://github.com/you/vault-sync.git")
          .setValue(s.remoteUrl)
          .onChange(async (v) => {
            s.remoteUrl = v.trim();
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch that holds the encrypted data.")
      .addText((t) =>
        t.setValue(s.branch).onChange(async (v) => {
          s.branch = v.trim() || DEFAULT_SETTINGS.branch;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your Git host username. For GitHub any non-empty value works with a token; GitLab accepts \"oauth2\".")
      .addText((t) =>
        t
          .setPlaceholder("Username")
          .setValue(s.username)
          .onChange(async (v) => {
            s.username = v.trim();
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Access token")
      .setDesc(
        `Personal access token with read/write access to the repository. Stored in ${this.plugin.secrets.describe()}, not in the vault.`,
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(this.plugin.secrets.get("token") ? "•••••••• (saved)" : "paste token")
          .onChange((v) => this.plugin.secrets.set("token", v.trim() || null));
      });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in conflict copies, e.g. \"Note (conflict 2026-10-15 0741 phone).md\".")
      .addText((t) =>
        t.setValue(s.deviceName).onChange(async (v) => {
          s.deviceName = v.trim();
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Checks that the repository is reachable with these credentials.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          try {
            new Notice(await this.plugin.testConnection());
          } catch (e) {
            new Notice(`Connection failed: ${(e as Error).message}`, 10_000);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    // --- Encryption -----------------------------------------------------
    new Setting(containerEl).setName("Encryption").setHeading();

    const remembered = !!this.plugin.secrets.get("passphrase");
    new Setting(containerEl)
      .setName("Passphrase")
      .setDesc(
        remembered
          ? "Remembered on this device."
          : this.plugin.isUnlocked()
            ? "Unlocked for this session."
            : "You will be asked for it on the next sync.",
      )
      .addButton((b) =>
        b.setButtonText("Change").onClick(async () => {
          await this.plugin.changePassphrase();
          this.display();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Forget on this device").onClick(() => {
          this.plugin.forgetPassphrase();
          new Notice("Passphrase forgotten on this device.");
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Rotate encryption key")
      .setDesc(
        "Re-encrypts everything with a new key and removes the old history from the remote. " +
          "Use this if your passphrase may have leaked.",
      )
      .addButton((b) =>
        b
          .setButtonText("Rotate key")
          .setWarning()
          .onClick(async () => {
            await this.plugin.rotateKey();
            this.display();
          }),
      );

    // --- Schedule -------------------------------------------------------
    new Setting(containerEl).setName("When to sync").setHeading();

    new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await save();
      }),
    );

    new Setting(containerEl)
      .setName("Automatic sync interval (minutes)")
      .setDesc("Set to 0 to turn it off.")
      .addText((t) =>
        numberInput(t.inputEl, s.autoSyncMinutes, 0, async (v) => {
          s.autoSyncMinutes = v;
          await save();
          this.plugin.scheduleAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("Sync after editing (seconds)")
      .setDesc("Syncs this many seconds after you stop editing. Set to 0 to turn it off. Debouncing keeps the history small.")
      .addText((t) =>
        numberInput(t.inputEl, s.syncAfterEditSeconds, 0, async (v) => {
          s.syncAfterEditSeconds = v;
          await save();
        }),
      );

    // --- Files ----------------------------------------------------------
    new Setting(containerEl).setName("Files").setHeading();

    new Setting(containerEl)
      .setName("Sync attachments")
      .setDesc("Off: only notes (.md) and canvases. On: all files up to the size limit.")
      .addToggle((t) =>
        t.setValue(s.syncAttachments).onChange(async (v) => {
          s.syncAttachments = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Maximum file size in megabytes")
      .setDesc("Larger files are skipped. Set to 0 for no limit (not recommended; most Git hosts reject files over 100 megabytes).")
      .addText((t) =>
        numberInput(t.inputEl, s.maxFileSizeMB, 0, async (v) => {
          s.maxFileSizeMB = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc(`One glob per line, relative to the vault root. Example: Private/** or *.pdf. The ${this.app.vault.configDir} folder is never synced.`)
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.addClass("egs-textarea");
        t.setValue(s.ignorePatterns.join("\n")).onChange(async (v) => {
          s.ignorePatterns = v.split("\n").map((l) => l.trim()).filter(Boolean);
          await save();
        });
      });

    // --- History --------------------------------------------------------
    new Setting(containerEl).setName("History").setHeading();

    new Setting(containerEl)
      .setName("Squash history automatically")
      .setDesc(
        "Keeps the repository small by thinning out old versions: several versions of today, " +
          "one per day, per week and per month. Older versions are removed for good.",
      )
      .addToggle((t) =>
        t.setValue(s.squashEnabled).onChange(async (v) => {
          s.squashEnabled = v;
          await save();
        }),
      );

    const retention = (name: string, desc: string, key: keyof RetentionPolicy) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          numberInput(t.inputEl, s.retention[key], 0, async (v) => {
            s.retention[key] = v;
            await save();
          }),
        );
    retention("Versions of today", "Newest versions kept from the current day.", "keepToday");
    retention("Daily versions", "Last version of each of the last N days.", "keepDaily");
    retention("Weekly versions", "Last version of each of the last N weeks.", "keepWeekly");
    retention("Monthly versions", "Last version of each of the last N months.", "keepMonthly");

    new Setting(containerEl)
      .setName("Squash when history exceeds (commits)")
      .addText((t) =>
        numberInput(t.inputEl, s.squashMinCommits, 2, async (v) => {
          s.squashMinCommits = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Squash history now")
      .setDesc("Applies the retention rules immediately.")
      .addButton((b) =>
        b
          .setButtonText("Squash now")
          .setWarning()
          .onClick(() => this.plugin.runSquash(true)),
      );

    // --- Maintenance ----------------------------------------------------
    new Setting(containerEl).setName("Maintenance").setHeading();

    new Setting(containerEl)
      .setName("Reset this device's sync state")
      .setDesc(
        "Forgets what this device last synced and clears its local copy of the encrypted repository. " +
          "The next sync treats this device as new: nothing is deleted, differences become conflict copies.",
      )
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(() => this.plugin.resetLocalState()),
      );
  }
}

function numberInput(input: HTMLInputElement, value: number, min: number, onChange: (v: number) => Promise<void>): void {
  input.type = "number";
  input.min = String(min);
  input.value = String(value);
  input.addEventListener("change", () => {
    const v = Math.max(min, Math.floor(Number(input.value)));
    input.value = String(v);
    if (Number.isFinite(v)) void onChange(v);
  });
}
