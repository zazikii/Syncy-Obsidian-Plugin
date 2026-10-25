import { type App, Modal } from "obsidian";

class PassphraseModal extends Modal {
  private readonly title: string;
  private readonly description: string;
  private readonly requireConfirmation: boolean;
  private readonly resolve: (value: string | null) => void;
  private value = "";
  private confirmation = "";
  private settled = false;

  constructor(
    app: App,
    title: string,
    description: string,
    requireConfirmation: boolean,
    resolve: (value: string | null) => void,
  ) {
    super(app);
    this.title = title;
    this.description = description;
    this.requireConfirmation = requireConfirmation;
    this.resolve = resolve;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.description, cls: "syncy-modal-description" });

    const passwordLabel = this.contentEl.createEl("label", {
      text: "E2EE passphrase",
      cls: "syncy-field-label",
    });
    const password = passwordLabel.createEl("input", {
      type: "password",
      cls: "syncy-text-input",
      attr: { autocomplete: "new-password" },
    });
    password.focus();
    password.addEventListener("input", () => {
      this.value = password.value;
    });

    let confirmation: HTMLInputElement | null = null;
    if (this.requireConfirmation) {
      const confirmLabel = this.contentEl.createEl("label", {
        text: "Repeat passphrase",
        cls: "syncy-field-label",
      });
      confirmation = confirmLabel.createEl("input", {
        type: "password",
        cls: "syncy-text-input",
        attr: { autocomplete: "new-password" },
      });
      confirmation.addEventListener("input", () => {
        this.confirmation = confirmation!.value;
      });
    }

    const errorEl = this.contentEl.createDiv({ cls: "syncy-modal-error" });
    const submit = () => {
      errorEl.setText("");
      if (!this.value) {
        errorEl.setText("Enter a passphrase.");
        return;
      }
      if (this.requireConfirmation && this.value.length < 8) {
        errorEl.setText("Use at least 8 characters.");
        return;
      }
      if (this.requireConfirmation && this.value !== this.confirmation) {
        errorEl.setText("The passphrases do not match.");
        return;
      }
      this.finish(this.value);
    };

    const buttons = this.contentEl.createDiv({ cls: "syncy-modal-buttons" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(null));
    const confirm = buttons.createEl("button", {
      text: this.requireConfirmation ? "Set passphrase" : "Unlock",
      cls: "mod-cta",
    });
    confirm.addEventListener("click", submit);

    for (const input of [password, confirmation].filter(
      (item): item is HTMLInputElement => item !== null,
    )) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
    }
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

export function askPassphrase(
  app: App,
  title: string,
  description: string,
  requireConfirmation = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    new PassphraseModal(app, title, description, requireConfirmation, resolve).open();
  });
}

class ConfirmModal extends Modal {
  private readonly title: string;
  private readonly message: string;
  private readonly confirmText: string;
  private readonly resolve: (value: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    title: string,
    message: string,
    confirmText: string,
    resolve: (value: boolean) => void,
  ) {
    super(app);
    this.title = title;
    this.message = message;
    this.confirmText = confirmText;
    this.resolve = resolve;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.message, cls: "syncy-modal-description" });

    const buttons = this.contentEl.createDiv({ cls: "syncy-modal-buttons" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));
    const confirm = buttons.createEl("button", { text: this.confirmText, cls: "mod-warning" });
    confirm.addEventListener("click", () => this.finish(true));
    confirm.focus();
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

export function confirmAction(
  app: App,
  title: string,
  message: string,
  confirmText: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, message, confirmText, resolve).open();
  });
}
