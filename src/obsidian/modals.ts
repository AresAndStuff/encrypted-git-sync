import { Modal, Setting, type App } from "obsidian";

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
      contentEl.createEl("p", { text: "Enter the passphrase for the encrypted repository." });
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
      if (this.passphrase.length < 12) return void fail("Use at least 12 characters.");
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
