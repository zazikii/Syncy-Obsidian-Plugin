import { type App, Modal, Notice, type TFile } from "obsidian";
import { CryptoError } from "../crypto";
import type SyncyPlugin from "../main";
import type { Version } from "../types";
import { errorMessage } from "../util/errors";
import { sha256Hex } from "../util/hash";
import { confirmAction } from "./modals";

export async function openHistoryModal(plugin: SyncyPlugin, file: TFile): Promise<void> {
  if (!plugin.api?.hasSession()) {
    new Notice("Sign in to Syncy first.");
    return;
  }
  if (!plugin.data.settings.vaultId) {
    new Notice("Link a Syncy vault first.");
    return;
  }
  const fileId = plugin.engine?.getFileId(file.path);
  if (!fileId) {
    new Notice("This file is not synced with Syncy yet.");
    return;
  }
  if (plugin.isLinkedVaultEncrypted() && !plugin.getCurrentVaultCrypto()) {
    new Notice("Unlock the encrypted vault before browsing its version history.");
    return;
  }
  new HistoryModal(plugin.app, plugin, file, fileId).open();
}

class HistoryModal extends Modal {
  private readonly plugin: SyncyPlugin;
  private readonly file: TFile;
  private readonly fileId: string;
  private listEl!: HTMLElement;
  private versions: Version[] = [];
  private readonly decryptedPaths = new Map<string, string>();
  private nextCursor: number | null = null;
  private loading = false;

  constructor(app: App, plugin: SyncyPlugin, file: TFile, fileId: string) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.fileId = fileId;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("syncy-history-modal");
    this.contentEl.createEl("h2", { text: "Version history" });
    this.contentEl.createEl("p", {
      cls: "syncy-modal-description",
      text: this.file.path,
    });
    this.listEl = this.contentEl.createDiv({ cls: "syncy-version-list" });
    void this.loadPage();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private vaultId(): string {
    return this.plugin.data.settings.vaultId!;
  }

  private async loadPage(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.renderLoading();
    try {
      const page = await this.plugin.api!.getVersions(this.vaultId(), this.fileId, {
        cursor: this.nextCursor,
        limit: 25,
      });
      this.versions.push(...page.versions);
      this.nextCursor = page.nextCursor;
      await this.decryptPaths(page.versions);
      this.render();
    } catch (error) {
      this.listEl.empty();
      this.listEl.createEl("p", {
        cls: "syncy-modal-error",
        text: errorMessage(error),
      });
    } finally {
      this.loading = false;
    }
  }

  private renderLoading(): void {
    this.listEl.empty();
    this.listEl.createEl("p", { cls: "syncy-hint", text: "Loading versions…" });
  }

  private render(): void {
    this.listEl.empty();
    if (this.versions.length === 0) {
      this.listEl.createEl("p", {
        cls: "syncy-hint",
        text: "No versions stored on the server yet.",
      });
      return;
    }

    for (const version of this.versions) {
      const row = this.listEl.createDiv({ cls: "syncy-version-row" });
      const info = row.createDiv({ cls: "syncy-version-info" });
      info.createDiv({
        cls: "syncy-version-date",
        text: new Date(version.createdAt).toLocaleString(),
      });
      const meta = info.createDiv({ cls: "syncy-version-meta" });
      meta.createSpan({ text: `Revision ${version.revision}` });
      meta.createSpan({ text: formatBytes(version.size) });
      info.createDiv({ cls: "syncy-version-path", text: this.displayPath(version) });

      const actions = row.createDiv({ cls: "syncy-version-actions" });
      if (version.kind === "file" && version.hash) {
        const preview = actions.createEl("button", { text: "Preview" });
        preview.addEventListener("click", () => {
          void this.preview(version);
        });
      }
      const restore = actions.createEl("button", { text: "Restore", cls: "mod-warning" });
      restore.addEventListener("click", () => {
        void this.restore(version);
      });
    }

    if (this.nextCursor !== null) {
      const more = this.listEl.createEl("button", {
        cls: "syncy-load-more",
        text: "Load older versions",
      });
      more.addEventListener("click", () => {
        void this.loadPage();
      });
    }
  }

  private async decryptPaths(versions: Version[]): Promise<void> {
    const crypto = this.plugin.getCurrentVaultCrypto();
    if (!crypto) return;
    for (const version of versions) {
      if (!version.encrypted) continue;
      try {
        this.decryptedPaths.set(version.id, await crypto.decryptPath(version.path));
      } catch {
        this.decryptedPaths.set(version.id, "(could not decrypt path)");
      }
    }
  }

  private displayPath(version: Version): string {
    if (!version.encrypted) return version.path;
    return this.decryptedPaths.get(version.id) ?? "(encrypted path)";
  }

  private async fetchVersionContent(version: Version): Promise<string> {
    if (!version.hash) throw new Error("This version has no stored content");
    const bytes = await this.plugin.api!.downloadBlob(this.vaultId(), version.hash);
    const actual = await sha256Hex(bytes);
    if (actual !== version.hash)
      throw new Error("The downloaded version failed its integrity check");
    let plaintext: ArrayBuffer = bytes;
    if (version.encrypted) {
      const crypto = this.plugin.getCurrentVaultCrypto();
      if (!crypto) throw new Error("Unlock the encrypted vault first");
      try {
        const decrypted = await crypto.decryptContent(bytes, version.fileId);
        const copy = new Uint8Array(decrypted.byteLength);
        copy.set(decrypted);
        plaintext = copy.buffer;
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        throw new Error("Could not decrypt this version");
      }
    }

    const sample = new Uint8Array(plaintext, 0, Math.min(8192, plaintext.byteLength));
    for (const byte of sample) {
      if (byte === 0) throw new Error("This version is binary and cannot be previewed as text");
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(plaintext);
    return text.length > 400_000 ? `${text.slice(0, 400_000)}\n\n…preview truncated…` : text;
  }

  private async preview(version: Version): Promise<void> {
    try {
      const text = await this.fetchVersionContent(version);
      new VersionPreviewModal(this.app, text, version).open();
    } catch (error) {
      new Notice(`Syncy: ${errorMessage(error)}`, 9000);
    }
  }

  private async restore(version: Version): Promise<void> {
    const confirmed = await confirmAction(
      this.app,
      "Restore this version",
      `Restore the version from ${new Date(version.createdAt).toLocaleString()} as a new change? The current content remains in version history.`,
      "Restore",
    );
    if (!confirmed) return;
    try {
      const result = await this.plugin.api!.restoreVersion(this.vaultId(), this.fileId, version.id);
      if (result.hasConflicts) {
        new Notice(
          "Syncy could not restore this version because the path or revision changed. Run a sync and try again.",
          9000,
        );
        return;
      }
      new Notice("Syncy restored the version. Syncing now.", 5000);
      this.close();
      void this.plugin.syncNow();
    } catch (error) {
      new Notice(`Syncy: ${errorMessage(error)}`, 9000);
    }
  }
}

class VersionPreviewModal extends Modal {
  private readonly text: string;
  private readonly version: Version;

  constructor(app: App, text: string, version: Version) {
    super(app);
    this.text = text;
    this.version = version;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("syncy-preview-modal");
    this.contentEl.createEl("h2", { text: "Version preview" });
    this.contentEl.createEl("p", {
      cls: "syncy-modal-description",
      text: `${new Date(this.version.createdAt).toLocaleString()} · revision ${this.version.revision}`,
    });
    const pre = this.contentEl.createEl("pre", { cls: "syncy-preview-content" });
    pre.setText(this.text);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
