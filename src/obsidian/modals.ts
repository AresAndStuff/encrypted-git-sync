/**
 * Dialogs: unlock / create passphrase, change passphrase or rotate key, and a
 * generic confirmation. Each modal resolves a promise exactly once, with null
 * (or false) when the user closes it without confirming.
 */

import { Modal, Setting, type App } from "obsidian";
import { MIN_PASSPHRASE_LENGTH } from "../core/crypto";

export interface PassphraseResult {
  passphrase: string;
  remember: boolean;
}

/**
 * Asks for the passphrase. For a new repository it asks twice and warns
 * that a lost passphrase cannot be recovered.
 */
export class PassphraseModal extends Modal {
  private passphrase = "";
  private confirm = "";
  private remember = false;
  private settled = false;

  constructor(
    app: App,
    private readonly mode: "unlock" | "create",
    private readonly resolve: (result: PassphraseResult | null) => void,
    private readonly error?: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.mode === "create" ? "Choose an encryption passphrase" : "Unlock encrypted vault sync");

    if (this.mode === "create") {
      contentEl.createEl("p", {
        text:
          "The remote repository is empty. Your notes will be encrypted with this passphrase. " +
          "Use the same passphrase on every device. If you lose it, your synced data cannot be recovered.",
      });
    } else {
      contentEl.createEl("p", {
        text:
          "Enter the passphrase for the encrypted repository. " +
          "If it was changed on another device, enter the new one.",
      });
    }
    if (this.error) contentEl.createEl("p", { text: this.error, cls: "egs-error" });

    new Setting(contentEl).setName("Passphrase").addText((t) => {
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "off";
      t.onChange((v) => (this.passphrase = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && this.mode === "unlock") this.submit();
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    if (this.mode === "create") {
      new Setting(contentEl).setName("Repeat passphrase").addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.onChange((v) => (this.confirm = v));
      });
    }

    new Setting(contentEl)
      .setName("Remember on this device")
      .setDesc("Stores the passphrase in this device's secret storage so you are not asked again after a restart.")
      .addToggle((t) => t.setValue(false).onChange((v) => (this.remember = v)));

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.mode === "create" ? "Create and sync" : "Unlock")
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  private submit(): void {
    const errorEl = this.contentEl.querySelector(".egs-inline-error");
    errorEl?.remove();
    const fail = (msg: string) => this.contentEl.createEl("p", { text: msg, cls: "egs-error egs-inline-error" });

    if (!this.passphrase) return void fail("Please enter a passphrase.");
    if (this.mode === "create") {
      if (this.passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return void fail(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      }
      if (this.passphrase !== this.confirm) return void fail("The passphrases do not match.");
    }
    this.settled = true;
    this.resolve({ passphrase: this.passphrase, remember: this.remember });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}

export function askPassphrase(app: App, mode: "unlock" | "create", error?: string): Promise<PassphraseResult | null> {
  return new Promise((resolve) => new PassphraseModal(app, mode, resolve, error).open());
}

export interface ChangePassphraseInput {
  oldPassphrase: string;
  newPassphrase: string;
  remember: boolean;
}

/**
 * Asks for the current passphrase and a new one (twice). Used for both a
 * passphrase change ("change") and a full key rotation ("rotate"); only the
 * texts differ.
 */
export class ChangePassphraseModal extends Modal {
  private oldPassphrase = "";
  private newPassphrase = "";
  private confirm = "";
  private remember = false;
  private settled = false;

  constructor(
    app: App,
    private readonly resolve: (result: ChangePassphraseInput | null) => void,
    private readonly mode: "change" | "rotate" = "change",
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    if (this.mode === "rotate") {
      this.setTitle("Rotate encryption key");
      contentEl.createEl("p", {
        text:
          "Creates a new encryption key, re-encrypts every synced file with it and replaces the remote " +
          "history with a single version. Use this if your passphrase may have leaked.",
      });
      contentEl.createEl("p", {
        text:
          "Older versions are removed from the remote. Other devices keep working after entering the new " +
          "passphrase. For a hard guarantee, also move to a new remote repository (see the README).",
        cls: "setting-item-description",
      });
    } else {
      this.renderChangeIntro();
    }
    this.renderFields();
  }

  private renderChangeIntro(): void {
    const { contentEl } = this;
    this.setTitle("Change encryption passphrase");
    contentEl.createEl("p", {
      text:
        "Your notes stay encrypted with the same key; only the passphrase that protects it changes. " +
        "Other devices will ask for the new passphrase on their next sync.",
    });
    contentEl.createEl("p", {
      text:
        "Older versions in the history can still be opened with the old passphrase. " +
        "If the old passphrase was leaked, use \"Rotate encryption key\" instead.",
      cls: "setting-item-description",
    });
  }

  private renderFields(): void {
    const { contentEl } = this;

    const password = (name: string, set: (v: string) => void) =>
      new Setting(contentEl).setName(name).addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.onChange(set);
      });
    password("Current passphrase", (v) => (this.oldPassphrase = v));
    password("New passphrase", (v) => (this.newPassphrase = v));
    password("Repeat new passphrase", (v) => (this.confirm = v));

    new Setting(contentEl)
      .setName("Remember on this device")
      .addToggle((t) => t.setValue(false).onChange((v) => (this.remember = v)));

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.mode === "rotate" ? "Rotate key" : "Change passphrase")
          .setCta()
          .onClick(() => this.submit()),
      );
  }

  private submit(): void {
    this.contentEl.querySelector(".egs-inline-error")?.remove();
    const fail = (msg: string) => this.contentEl.createEl("p", { text: msg, cls: "egs-error egs-inline-error" });

    if (!this.oldPassphrase) return void fail("Enter the current passphrase.");
    if (this.newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
      return void fail(`Use at least ${MIN_PASSPHRASE_LENGTH} characters for the new passphrase.`);
    }
    if (this.newPassphrase !== this.confirm) return void fail("The new passphrases do not match.");
    if (this.newPassphrase === this.oldPassphrase) return void fail("The new passphrase is the same as the current one.");

    this.settled = true;
    this.resolve({ oldPassphrase: this.oldPassphrase, newPassphrase: this.newPassphrase, remember: this.remember });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}

export function askChangePassphrase(app: App, mode: "change" | "rotate" = "change"): Promise<ChangePassphraseInput | null> {
  return new Promise((resolve) => new ChangePassphraseModal(app, resolve, mode).open());
}

export class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => {
            this.settled = true;
            this.resolve(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }
}

export function confirm(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, title, message, confirmText, resolve).open());
}
