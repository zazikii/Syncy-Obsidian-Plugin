import { type App, Notice, PluginSettingTab, Setting, type TextAreaComponent } from "obsidian";
import type SyncyPlugin from "../main";
import { errorMessage } from "../util/errors";
import { askPassphrase } from "./modals";

export class SyncySettingTab extends PluginSettingTab {
  private readonly plugin: SyncyPlugin;
  private selectedVaultId = "";
  private password = "";
  private newVaultName = "";
  private createEncrypted = false;
  private passphrase = "";

  constructor(app: App, plugin: SyncyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  refresh(): void {
    if (this.containerEl.isShown()) this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("syncy-settings");

    containerEl.createEl("h2", { text: "Syncy" });
    this.renderSummary(containerEl);
    this.renderConnection(containerEl);
    this.renderVault(containerEl);
    this.renderEncryption(containerEl);
    this.renderSync(containerEl);
    this.renderAdvanced(containerEl);
  }

  private renderSummary(containerEl: HTMLElement): void {
    const settings = this.plugin.data.settings;
    const linked = this.plugin.remoteVaults.find((vault) => vault.id === settings.vaultId);
    const card = containerEl.createDiv({ cls: "syncy-card" });
    card.createDiv({
      cls: "syncy-card-title",
      text: this.plugin.api?.hasSession() ? "Connected" : "Not connected",
    });

    const rows: Array<[string, string]> = [];
    if (this.plugin.api?.hasSession()) {
      rows.push(["Account", this.plugin.data.session?.user.email ?? settings.email]);
      rows.push(["Server", this.plugin.api?.getServerUrl() ?? settings.serverUrl]);
    }
    if (settings.vaultId) {
      rows.push(["Linked vault", linked?.name ?? settings.vaultName ?? settings.vaultId]);
      rows.push([
        "Encryption",
        linked?.e2ee
          ? this.plugin.isVaultUnlocked()
            ? "End-to-end encrypted (unlocked)"
            : "End-to-end encrypted (locked)"
          : "Server-readable",
      ]);
      rows.push(["Pending changes", String(this.plugin.pendingCount())]);
    }
    rows.push([
      "Last sync",
      this.plugin.lastSyncAt() ? new Date(this.plugin.lastSyncAt()!).toLocaleString() : "Never",
    ]);

    for (const [label, value] of rows) {
      const row = card.createDiv({ cls: "syncy-card-row" });
      row.createSpan({ cls: "syncy-card-label", text: label });
      row.createSpan({ cls: "syncy-card-value", text: value });
    }

    new Setting(containerEl).addButton((button) => {
      button.setButtonText("Refresh account").onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.refreshAccount();
          this.refresh();
        } catch (error) {
          new Notice(`Syncy: ${errorMessage(error)}`, 9000);
        } finally {
          button.setDisabled(false);
        }
      });
    });
  }

  private renderConnection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Connection" });
    const settings = this.plugin.data.settings;

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        this.plugin.api?.hasSession()
          ? "Sign out to change the server or account."
          : "Base URL of your Syncy server, without /v1.",
      )
      .addText((text) => {
        text
          .setPlaceholder("https://sync.example.com")
          .setValue(settings.serverUrl)
          .setDisabled(this.plugin.api?.hasSession() ?? false)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ serverUrl: value });
          });
      });

    new Setting(containerEl)
      .setName("Email")
      .setDesc("Account email on the server.")
      .addText((text) => {
        text
          .setPlaceholder("you@example.com")
          .setValue(settings.email)
          .setDisabled(this.plugin.api?.hasSession() ?? false)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ email: value });
          });
      });

    if (!this.plugin.api?.hasSession()) {
      new Setting(containerEl)
        .setName("Password")
        .setDesc("Used once to sign in. It is not stored by the plugin.")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("Account password").onChange((value) => {
            this.password = value;
          });
        });
    }

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used for new sign-ins and reconnects.")
      .addText((text) => {
        text
          .setPlaceholder("Obsidian on my laptop")
          .setValue(settings.deviceName)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ deviceName: value });
          });
      });

    if (this.plugin.api?.hasSession()) {
      new Setting(containerEl)
        .setName("Session")
        .setDesc("Refresh the account and vault list, or sign out.")
        .addButton((button) => {
          button.setButtonText("Refresh account").onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.refreshAccount();
              this.refresh();
            } catch (error) {
              new Notice(`Syncy: ${errorMessage(error)}`, 9000);
            } finally {
              button.setDisabled(false);
            }
          });
        })
        .addButton((button) => {
          button.setButtonText("Sign out").onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.signOut();
              this.refresh();
            } catch (error) {
              new Notice(`Syncy: ${errorMessage(error)}`, 9000);
            } finally {
              button.setDisabled(false);
            }
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Sign in")
        .setDesc("Sign in to the configured server.")
        .addButton((button) => {
          button
            .setButtonText("Sign in")
            .setCta()
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.connect(settings.email, this.password);
                this.password = "";
                new Notice("Syncy signed in.");
                this.refresh();
              } catch (error) {
                new Notice(`Syncy: ${errorMessage(error)}`, 9000);
              } finally {
                button.setDisabled(false);
              }
            });
        });
    }
  }

  private renderVault(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Vault" });
    const settings = this.plugin.data.settings;

    if (!this.plugin.api?.hasSession()) {
      containerEl.createEl("p", {
        cls: "syncy-hint",
        text: "Sign in first to list remote vaults.",
      });
      return;
    }

    if (!this.plugin.remoteVaults.some((vault) => vault.id === this.selectedVaultId)) {
      this.selectedVaultId = settings.vaultId ?? this.plugin.remoteVaults[0]?.id ?? "";
    }

    const dropdownSetting = new Setting(containerEl)
      .setName("Remote vault")
      .setDesc("Choose the server vault to link to this Obsidian vault.")
      .addDropdown((dropdown) => {
        for (const vault of this.plugin.remoteVaults) {
          const label = `${vault.name}${vault.e2ee ? " (E2EE)" : ""} · ${vault.role}`;
          dropdown.addOption(vault.id, label);
        }
        if (this.plugin.remoteVaults.length === 0) {
          dropdown.addOption("", "No vaults yet");
        }
        dropdown.setValue(this.selectedVaultId);
        dropdown.setDisabled(this.plugin.remoteVaults.length === 0);
        dropdown.onChange((value) => {
          this.selectedVaultId = value;
        });
      });

    if (this.plugin.remoteVaults.length === 0) {
      dropdownSetting.setDesc("Create a vault below, then link it.");
    }

    new Setting(containerEl)
      .setName("Link this vault")
      .setDesc(
        "Links this Obsidian vault to the selected server vault. Existing local files are uploaded and server files are downloaded.",
      )
      .addButton((button) => {
        button
          .setButtonText(settings.vaultId ? "Relink" : "Link")
          .setCta()
          .setDisabled(!this.selectedVaultId)
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const linked = await this.plugin.linkVault(this.selectedVaultId);
              if (linked) new Notice("Syncy linked the vault and started syncing.");
              this.refresh();
            } catch (error) {
              new Notice(`Syncy: ${errorMessage(error)}`, 9000);
            } finally {
              button.setDisabled(false);
            }
          });
      })
      .addButton((button) => {
        if (!settings.vaultId) return;
        button.setButtonText("Unlink").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.unlinkVault();
            new Notice("Syncy unlinked the vault. Remote data was not touched.", 5000);
            this.refresh();
          } catch (error) {
            new Notice(`Syncy: ${errorMessage(error)}`, 9000);
          } finally {
            button.setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("New vault name")
      .setDesc("Create a new vault on the server and link it to this Obsidian vault.")
      .addText((text) => {
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.newVaultName)
          .onChange((value) => {
            this.newVaultName = value;
          });
      });

    new Setting(containerEl)
      .setName("End-to-end encryption")
      .setDesc("Encrypt file contents and paths on this device. The server stores ciphertext only.")
      .addToggle((toggle) => {
        toggle.setValue(this.createEncrypted).onChange((value) => {
          this.createEncrypted = value;
        });
      });

    new Setting(containerEl)
      .setName("Create and link vault")
      .setDesc(
        "Creates the vault on the server. You will be asked for an E2EE passphrase if encryption is enabled.",
      )
      .addButton((button) => {
        button
          .setButtonText("Create vault")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const name = this.newVaultName.trim() || this.app.vault.getName();
              const created = await this.plugin.createVault(name, this.createEncrypted);
              if (created) {
                this.newVaultName = "";
                new Notice(`Syncy created "${name}".`, 5000);
              }
              this.refresh();
            } catch (error) {
              new Notice(`Syncy: ${errorMessage(error)}`, 9000);
            } finally {
              button.setDisabled(false);
            }
          });
      });
  }

  private renderEncryption(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Encryption" });
    const settings = this.plugin.data.settings;

    if (!settings.vaultId) {
      containerEl.createEl("p", {
        cls: "syncy-hint",
        text: "Link a vault to manage its encryption key.",
      });
      return;
    }

    if (!this.plugin.isLinkedVaultEncrypted()) {
      containerEl.createEl("p", {
        cls: "syncy-hint",
        text: "This vault is not end-to-end encrypted. The server can read its contents.",
      });
      return;
    }

    const unlocked = this.plugin.isVaultUnlocked();
    containerEl.createEl("p", {
      cls: "syncy-hint",
      text: unlocked
        ? "The vault key is unlocked on this device."
        : "The vault is locked. Enter the E2EE passphrase to sync.",
    });

    new Setting(containerEl)
      .setName("E2EE passphrase")
      .setDesc("Never sent to the server.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Passphrase").onChange((value) => {
          this.passphrase = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void this.unlockVault();
          }
        });
      })
      .addButton((button) => {
        button
          .setButtonText(unlocked ? "Unlock again" : "Unlock")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.unlockVault();
            } finally {
              button.setDisabled(false);
            }
          });
      });

    new Setting(containerEl)
      .setName("Remember key on this device")
      .setDesc(
        "Stores the unlocked vault key in this plugin's local data.json. Disable for stricter security.",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.rememberVaultKey).onChange(async (value) => {
          await this.plugin.setRememberVaultKey(value);
          this.refresh();
        });
      });

    if (this.plugin.data.vaultKeys[settings.vaultId]) {
      new Setting(containerEl)
        .setName("Forget saved key")
        .setDesc("Removes the saved vault key from this device.")
        .addButton((button) => {
          button
            .setButtonText("Forget key")
            .setWarning()
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.forgetVaultKey();
                this.refresh();
              } catch (error) {
                new Notice(`Syncy: ${errorMessage(error)}`, 9000);
              } finally {
                button.setDisabled(false);
              }
            });
        });
    }
  }

  private async unlockVault(): Promise<void> {
    let passphrase = this.passphrase;
    if (!passphrase) {
      const asked = await askPassphrase(
        this.app,
        "Unlock encrypted vault",
        "Enter the E2EE passphrase for this vault.",
        false,
      );
      if (asked === null) return;
      passphrase = asked;
    }
    try {
      const unlocked = await this.plugin.unlockVault(passphrase);
      if (unlocked) {
        this.passphrase = "";
        new Notice("Syncy unlocked the encrypted vault.");
        this.refresh();
      }
    } catch (error) {
      new Notice(`Syncy: ${errorMessage(error)}`, 9000);
    }
  }

  private renderSync(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Sync" });
    const settings = this.plugin.data.settings;

    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Turn local file sync on or off for the linked vault.")
      .addToggle((toggle) => {
        toggle.setValue(settings.syncEnabled).onChange(async (value) => {
          await this.plugin.updateSettings({ syncEnabled: value }, true);
          this.refresh();
        });
      });

    new Setting(containerEl)
      .setName("Real-time notifications")
      .setDesc("Keep a WebSocket open so remote changes sync immediately.")
      .addToggle((toggle) => {
        toggle.setValue(settings.realtime).onChange(async (value) => {
          await this.plugin.updateSettings({ realtime: value }, true);
          this.refresh();
        });
      });

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync as soon as Obsidian opens.")
      .addToggle((toggle) => {
        toggle.setValue(settings.syncOnStartup).onChange(async (value) => {
          await this.plugin.updateSettings({ syncOnStartup: value }, true);
        });
      });

    new Setting(containerEl)
      .setName("Polling interval")
      .setDesc(
        "Seconds between periodic checks. 0 disables the timer; real-time notifications still pull changes.",
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "86400";
        text.setValue(String(settings.intervalSeconds));
        text.onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          await this.plugin.updateSettings({
            intervalSeconds: Math.max(0, Math.min(86_400, parsed)),
          });
        });
        text.inputEl.addEventListener("blur", async () => {
          const parsed = Number.parseInt(text.inputEl.value, 10);
          const seconds = Number.isFinite(parsed) ? Math.max(0, Math.min(86_400, parsed)) : 30;
          text.setValue(String(seconds));
          await this.plugin.updateSettings({ intervalSeconds: seconds }, true);
        });
      });

    new Setting(containerEl)
      .setName("Sync Obsidian configuration")
      .setDesc(
        "Syncs .obsidian settings, themes, snippets and installed plugins, except workspace files.",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.syncConfig).onChange(async (value) => {
          await this.plugin.updateSettings({ syncConfig: value }, true);
        });
      });

    new Setting(containerEl)
      .setName("Sync workspace layout")
      .setDesc(
        "Workspace layouts are usually device-specific. Enable only if you want them shared.",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.syncWorkspace).onChange(async (value) => {
          await this.plugin.updateSettings({ syncWorkspace: value }, true);
        });
      });

    new Setting(containerEl)
      .setName("Sync community plugin data")
      .setDesc(
        "Plugin data.json files can contain API keys and tokens. Prefer an E2EE vault if you enable this.",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.syncPluginData).onChange(async (value) => {
          await this.plugin.updateSettings({ syncPluginData: value }, true);
        });
      });

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc(
        "One vault-relative glob per line. Supports *, ** and ?. Changes apply when the field loses focus.",
      )
      .addTextArea((area: TextAreaComponent) => {
        area.setValue(settings.excludePatterns.join("\n"));
        area.inputEl.rows = 4;
        area.onChange(async (value) => {
          const patterns = parsePatterns(value);
          await this.plugin.updateSettings({ excludePatterns: patterns });
        });
        area.inputEl.addEventListener("blur", async () => {
          const patterns = parsePatterns(area.inputEl.value);
          await this.plugin.updateSettings({ excludePatterns: patterns }, true);
        });
      });

    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("Run a sync now or rebuild local state from the server.")
      .addButton((button) => {
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.syncNow();
              this.refresh();
            } finally {
              button.setDisabled(false);
            }
          });
      })
      .addButton((button) => {
        button.setButtonText("Full resync").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.fullResync();
            this.refresh();
          } finally {
            button.setDisabled(false);
          }
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Reset local state")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.resetLocalState();
              this.refresh();
            } finally {
              button.setDisabled(false);
            }
          });
      });
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Advanced" });
    const info = this.plugin.serverInfo;
    const settings = this.plugin.data.settings;

    new Setting(containerEl)
      .setName("Server version")
      .setDesc(info ? `${info.name} ${info.version} · API v${info.apiVersion}` : "Not loaded");
    new Setting(containerEl)
      .setName("Device ID")
      .setDesc(this.plugin.data.deviceId ?? "Assigned on first sign-in");
    new Setting(containerEl)
      .setName("Sync cursor")
      .setDesc(settings.vaultId ? String(this.plugin.cursor()) : "No vault linked");
    new Setting(containerEl)
      .setName("Maximum blob size")
      .setDesc(
        info ? `${Math.round(info.maxBlobBytes / (1024 * 1024))} MiB` : "Uses the server default",
      );
  }
}

function parsePatterns(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
