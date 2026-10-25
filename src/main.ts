import { type Menu, Notice, normalizePath, Platform, Plugin, TFile } from "obsidian";
import { SyncyApi } from "./api";
import {
  generateVaultKey,
  unwrapVaultKey,
  VaultCrypto,
  vaultKeyFromBase64,
  vaultKeyToBase64,
  wrapVaultKey,
} from "./crypto";
import {
  DEFAULT_SETTINGS,
  mergePluginData,
  normalizeServerUrl,
  type PluginData,
  type SyncySettings,
} from "./data";
import { RealtimeClient } from "./realtime";
import { SyncStateStore } from "./state";
import { type EngineStatus, SyncEngine } from "./sync/engine";
import type { ServerInfo, Vault } from "./types";
import { openHistoryModal } from "./ui/history";
import { askPassphrase, confirmAction } from "./ui/modals";
import { SyncySettingTab } from "./ui/settingsTab";
import { AuthLostError, errorMessage } from "./util/errors";
import { buildExcludePatterns, compileExcludes } from "./util/glob";

export default class SyncyPlugin extends Plugin {
  data: PluginData = mergePluginData(null);
  api: SyncyApi | null = null;
  engine: SyncEngine | null = null;
  realtime: RealtimeClient | null = null;
  remoteVaults: Vault[] = [];
  serverInfo: ServerInfo | null = null;

  private stateStore: SyncStateStore | null = null;
  private statusBarEl!: HTMLElement;
  private settingsTab: SyncySettingTab | null = null;
  private vaultCryptos = new Map<string, VaultCrypto>();
  private vaultKeyBytes = new Map<string, Uint8Array>();
  private bootstrapTimer: number | null = null;

  async onload(): Promise<void> {
    this.data = mergePluginData(await this.loadData());

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("syncy-status");
    this.setStatus("Not signed in", "idle");

    this.addSettingTab(new SyncySettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Syncy: sync now", () => {
      void this.syncNow();
    });

    this.registerCommands();
    this.registerVaultEvents();
    this.registerFileMenu();

    this.api = this.createApi();
    if (this.api.hasSession()) {
      this.setStatus("Connecting", "idle");
      void this.bootstrap();
    }
  }

  onunload(): void {
    if (this.bootstrapTimer !== null) window.clearTimeout(this.bootstrapTimer);
    this.realtime?.stop();
    this.realtime = null;
    const engine = this.engine;
    this.engine = null;
    if (engine) void engine.stopAndWait();
    if (this.stateStore) void this.stateStore.flush();
  }

  private createApi(): SyncyApi {
    const serverUrl = normalizeServerUrl(this.data.settings.serverUrl);
    const api = new SyncyApi(serverUrl, {
      saveSession: async (session) => {
        this.data.session = session;
        this.data.deviceId = session.deviceId;
        await this.saveData(this.data);
      },
      clearSession: async () => {
        this.data.session = null;
        await this.saveData(this.data);
      },
      onAuthLost: (message) => {
        void this.handleAuthLost(message);
      },
    });
    if (this.data.session && normalizeServerUrl(this.data.session.serverUrl) === serverUrl) {
      void api.restoreSession(this.data.session);
    }
    return api;
  }

  private async bootstrap(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      this.serverInfo = await api.getInfo();
      this.remoteVaults = await api.getVaults();
      if (this.data.settings.vaultId) {
        const exists = this.remoteVaults.some((vault) => vault.id === this.data.settings.vaultId);
        if (!exists) {
          this.data.settings.vaultId = null;
          this.data.settings.vaultName = "";
          await this.saveData(this.data);
          this.setStatus("Vault not available", "paused");
          return;
        }
        await this.setupLinkedVault();
      } else {
        this.setStatus("Signed in", "idle");
      }
      this.settingsTab?.refresh();
    } catch (error) {
      if (error instanceof AuthLostError) return;
      this.setStatus(`Offline: ${errorMessage(error)}`, "error");
      this.bootstrapTimer = window.setTimeout(() => {
        this.bootstrapTimer = null;
        if (this.api?.hasSession()) void this.bootstrap();
      }, 30_000);
    }
  }

  async connect(email: string, password: string): Promise<void> {
    const serverUrl = normalizeServerUrl(this.data.settings.serverUrl);
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new Error("Enter a valid server URL, for example https://sync.example.com");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("The server URL must start with http:// or https://");
    }
    if (!email.trim()) throw new Error("Enter your account email");
    if (!password) throw new Error("Enter your account password");

    await this.stopLinked();
    if (this.data.session && normalizeServerUrl(this.data.session.serverUrl) !== serverUrl) {
      this.data.session = null;
    }
    this.data.settings.serverUrl = serverUrl;
    this.data.settings.email = email.trim();
    await this.saveData(this.data);

    this.api = this.createApi();
    const api = this.api;
    this.serverInfo = await api.getInfo();
    const deviceName = this.deviceName();
    const session = await api.login(email.trim(), password, {
      ...(this.data.deviceId ? { id: this.data.deviceId } : {}),
      name: deviceName,
      platform: platformName(),
    });
    this.data.deviceId = session.deviceId;
    await this.saveData(this.data);
    this.remoteVaults = await api.getVaults();

    if (this.data.settings.vaultId) {
      const exists = this.remoteVaults.some((vault) => vault.id === this.data.settings.vaultId);
      if (exists) {
        await this.setupLinkedVault();
      } else {
        this.data.settings.vaultId = null;
        this.data.settings.vaultName = "";
        await this.saveData(this.data);
      }
    }
    if (!this.data.settings.vaultId) this.setStatus("Signed in", "idle");
    this.settingsTab?.refresh();
  }

  async signOut(): Promise<void> {
    const confirmed = await confirmAction(
      this.app,
      "Sign out of Syncy",
      "Sync stops on this device until you sign in again. Local files and pending changes stay on disk.",
      "Sign out",
    );
    if (!confirmed) return;
    await this.stopLinked();
    if (this.api) await this.api.logout();
    this.data.session = null;
    await this.saveData(this.data);
    this.remoteVaults = [];
    this.setStatus("Signed out", "idle");
    this.settingsTab?.refresh();
  }

  async refreshAccount(): Promise<void> {
    if (!this.api?.hasSession()) return;
    this.serverInfo = await this.api.getInfo();
    this.remoteVaults = await this.api.getVaults();
    const linked = this.remoteVaults.find((vault) => vault.id === this.data.settings.vaultId);
    if (linked) {
      this.data.settings.vaultName = linked.name;
      await this.saveData(this.data);
    }
    this.settingsTab?.refresh();
  }

  async createVault(name: string, e2ee: boolean): Promise<boolean> {
    const api = this.requireApi();
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a vault name");

    let vault: Vault;
    if (e2ee) {
      const passphrase = await askPassphrase(
        this.app,
        "Create encrypted vault",
        "Choose an E2EE passphrase. It is never sent to the server and cannot be recovered by the server if you lose it.",
        true,
      );
      if (passphrase === null) return false;
      const key = generateVaultKey();
      const envelope = await wrapVaultKey(key, passphrase);
      vault = await api.createVault({ name: trimmed, e2ee: true, keyEnvelope: envelope });
      await this.storeVaultCrypto(vault.id, key);
    } else {
      vault = await api.createVault({ name: trimmed, e2ee: false });
    }

    this.remoteVaults = await api.getVaults();
    const linked = await this.linkVault(vault.id);
    if (linked) new Notice(`Syncy created and linked "${vault.name}".`);
    return linked;
  }

  async linkVault(vaultId: string): Promise<boolean> {
    const api = this.requireApi();
    const vault = await api.getVault(vaultId);

    if (vault.e2ee) {
      const existing = await this.getVaultCrypto(vaultId);
      if (!existing) {
        if (!vault.keyEnvelope) {
          throw new Error(
            "This encrypted vault has no key envelope for your account. Ask the owner to share the key.",
          );
        }
        const passphrase = await askPassphrase(
          this.app,
          "Unlock encrypted vault",
          "Enter the E2EE passphrase to unlock this vault on this device.",
          false,
        );
        if (passphrase === null) return false;
        const key = await unwrapVaultKey(vault.keyEnvelope, passphrase);
        await this.storeVaultCrypto(vaultId, key);
      }
    }

    await this.stopLinked();
    this.data.settings.vaultId = vault.id;
    this.data.settings.vaultName = vault.name;
    await this.saveData(this.data);
    await this.setupLinkedVault();
    this.settingsTab?.refresh();
    return true;
  }

  async unlinkVault(): Promise<void> {
    await this.stopLinked();
    this.data.settings.vaultId = null;
    this.data.settings.vaultName = "";
    await this.saveData(this.data);
    this.setStatus("No vault linked", "idle");
    this.settingsTab?.refresh();
  }

  async unlockVault(passphrase?: string): Promise<boolean> {
    const api = this.requireApi();
    const vaultId = this.data.settings.vaultId;
    if (!vaultId) throw new Error("Link a vault first");
    const vault = await api.getVault(vaultId);
    if (!vault.e2ee) return true;
    if (!vault.keyEnvelope) {
      throw new Error(
        "This encrypted vault has no key envelope for your account. Ask the owner to share the key.",
      );
    }

    let secret = passphrase;
    if (secret === undefined) {
      secret =
        (await askPassphrase(
          this.app,
          "Unlock encrypted vault",
          "Enter the E2EE passphrase for this vault.",
          false,
        )) ?? undefined;
    }
    if (!secret) return false;

    const key = await unwrapVaultKey(vault.keyEnvelope, secret);
    await this.storeVaultCrypto(vaultId, key);
    await this.stopLinked();
    await this.setupLinkedVault();
    this.settingsTab?.refresh();
    return true;
  }

  async setRememberVaultKey(value: boolean): Promise<void> {
    this.data.settings.rememberVaultKey = value;
    const vaultId = this.data.settings.vaultId;
    if (!value) {
      this.data.vaultKeys = {};
    } else if (vaultId) {
      const bytes = this.vaultKeyBytes.get(vaultId);
      if (bytes) {
        this.data.vaultKeys[vaultId] = { key: vaultKeyToBase64(bytes), savedAt: Date.now() };
      }
    }
    await this.saveData(this.data);
  }

  async forgetVaultKey(): Promise<void> {
    const vaultId = this.data.settings.vaultId;
    if (!vaultId) return;
    const confirmed = await confirmAction(
      this.app,
      "Forget the saved vault key",
      "The key is removed from this device. You will need the E2EE passphrase to unlock the vault again.",
      "Forget key",
    );
    if (!confirmed) return;
    this.vaultCryptos.delete(vaultId);
    this.vaultKeyBytes.delete(vaultId);
    delete this.data.vaultKeys[vaultId];
    await this.saveData(this.data);
    await this.stopLinked();
    this.setStatus("Encrypted vault locked", "paused");
    this.settingsTab?.refresh();
  }

  isVaultUnlocked(): boolean {
    const vaultId = this.data.settings.vaultId;
    if (!vaultId) return false;
    if (this.vaultCryptos.has(vaultId)) return true;
    return this.data.vaultKeys[vaultId] !== undefined;
  }

  isLinkedVaultEncrypted(): boolean {
    const linked = this.remoteVaults.find((vault) => vault.id === this.data.settings.vaultId);
    return linked?.e2ee ?? false;
  }

  getCurrentVaultCrypto(): VaultCrypto | null {
    const vaultId = this.data.settings.vaultId;
    if (!vaultId) return null;
    return this.vaultCryptos.get(vaultId) ?? null;
  }

  async syncNow(): Promise<void> {
    if (!this.api?.hasSession()) {
      new Notice("Sign in to Syncy first.");
      return;
    }
    if (!this.engine) {
      new Notice("Link a Syncy vault in the plugin settings first.");
      return;
    }
    await this.engine.syncNow();
  }

  async fullResync(): Promise<void> {
    if (!this.engine) {
      new Notice("Link a Syncy vault first.");
      return;
    }
    const confirmed = await confirmAction(
      this.app,
      "Run a full resync",
      "Syncy re-reads the complete server snapshot. Local files that are not excluded and are not on the server are uploaded. This can take a while for large vaults.",
      "Start full resync",
    );
    if (!confirmed) return;
    await this.engine.requestFullResync();
    new Notice("Syncy finished the full resync.", 4000);
  }

  async resetLocalState(): Promise<void> {
    const confirmed = await confirmAction(
      this.app,
      "Reset local sync state",
      "Syncy forgets its local file IDs, revisions and cursors, then rebuilds them from the server. Your files are not deleted.",
      "Reset state",
    );
    if (!confirmed) return;
    if (this.engine) {
      this.engine.resetState();
      await this.engine.requestFullResync();
    } else if (this.stateStore) {
      this.stateStore.reset(true);
      await this.stateStore.flush();
    }
    new Notice("Syncy reset its local sync state.", 4000);
  }

  async updateSettings(patch: Partial<SyncySettings>, restart = false): Promise<void> {
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings, ...patch };
    await this.saveData(this.data);
    if (restart && this.data.settings.vaultId && this.api?.hasSession()) {
      await this.stopLinked();
      if (this.data.settings.syncEnabled) {
        await this.setupLinkedVault();
      } else {
        this.setStatus("Sync disabled", "paused");
      }
    }
  }

  pendingCount(): number {
    return this.stateStore?.state.pending ? Object.keys(this.stateStore.state.pending).length : 0;
  }

  lastSyncAt(): number | null {
    return this.stateStore?.state.lastSyncAt ?? null;
  }

  cursor(): number {
    return this.stateStore?.state.cursor ?? 0;
  }

  openHistory(file: TFile): void {
    void openHistoryModal(this, file);
  }

  private async setupLinkedVault(): Promise<void> {
    if (!this.api?.hasSession()) return;
    const vaultId = this.data.settings.vaultId;
    if (!vaultId) return;

    await this.stopLinked();

    let vault: Vault;
    try {
      vault = await this.api.getVault(vaultId);
    } catch (error) {
      this.setStatus(`Could not load vault: ${errorMessage(error)}`, "error");
      return;
    }
    this.data.settings.vaultName = vault.name;
    await this.saveData(this.data);

    if (vault.e2ee) {
      const crypto = await this.getVaultCrypto(vault.id);
      if (!crypto) {
        this.setStatus("Encrypted vault locked", "paused");
        return;
      }
    }

    const state = await SyncStateStore.load(
      this.app.vault.adapter,
      this.pluginDirectory(),
      vault.id,
    );
    this.stateStore = state;
    const excluded = compileExcludes(
      buildExcludePatterns({
        syncConfig: this.data.settings.syncConfig,
        syncWorkspace: this.data.settings.syncWorkspace,
        syncPluginData: this.data.settings.syncPluginData,
        extraPatterns: this.data.settings.excludePatterns,
      }),
    );

    const engine = new SyncEngine({
      app: this.app,
      api: this.api,
      vaultId: vault.id,
      e2ee: vault.e2ee,
      vaultCrypto: vault.e2ee ? await this.getVaultCrypto(vault.id) : null,
      state,
      intervalSeconds: this.data.settings.intervalSeconds,
      syncOnStartup: this.data.settings.syncOnStartup,
      isExcluded: excluded,
      maxBlobBytes: () => this.serverInfo?.maxBlobBytes ?? 512 * 1024 * 1024,
      onStatus: (status) => {
        if (this.engine === engine) this.renderStatus(status);
      },
      notify: (message) => {
        new Notice(message, 7000);
      },
      onAuthLost: (message) => {
        void this.handleAuthLost(message);
      },
      onVaultUnavailable: (message) => {
        void this.handleVaultUnavailable(message);
      },
    });
    this.engine = engine;

    if (this.data.settings.syncEnabled) {
      engine.start();
      if (this.data.settings.realtime) {
        const realtime = new RealtimeClient(this.api, vault.id, {
          onVaultChanged: (_revision, originDeviceId) => {
            engine.notifyRemoteChange(originDeviceId);
          },
          onVaultDeleted: () => {
            void this.handleVaultUnavailable("This vault was deleted on the server.");
          },
          onMembershipChanged: () => {
            void this.handleVaultUnavailable(
              "Your access to this vault changed. Link it again if you still have access.",
            );
          },
          onConnected: () => {
            engine.notifyRemoteChange(null);
          },
          onAuthLost: (message) => {
            void this.handleAuthLost(message);
          },
        });
        this.realtime = realtime;
        realtime.start();
      }
    } else {
      this.setStatus("Sync disabled", "paused");
    }

    this.settingsTab?.refresh();
  }

  private async stopLinked(): Promise<void> {
    this.realtime?.stop();
    this.realtime = null;
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.stopAndWait();
    if (this.stateStore) {
      await this.stateStore.flush().catch(() => undefined);
      this.stateStore = null;
    }
  }

  private async handleAuthLost(message: string): Promise<void> {
    await this.stopLinked();
    this.setStatus(message || "Signed out", "paused");
    new Notice(`Syncy: ${message || "Signed out. Sign in again."}`, 9000);
    this.settingsTab?.refresh();
  }

  private async handleVaultUnavailable(message: string): Promise<void> {
    await this.stopLinked();
    this.setStatus(message, "error");
    new Notice(`Syncy: ${message}`, 9000);
    this.settingsTab?.refresh();
  }

  private async getVaultCrypto(vaultId: string): Promise<VaultCrypto | null> {
    const cached = this.vaultCryptos.get(vaultId);
    if (cached) return cached;

    const stored = this.data.vaultKeys[vaultId];
    if (!stored) return null;
    try {
      const bytes = vaultKeyFromBase64(stored.key);
      const crypto = await VaultCrypto.fromKey(bytes);
      this.vaultCryptos.set(vaultId, crypto);
      this.vaultKeyBytes.set(vaultId, bytes);
      return crypto;
    } catch {
      delete this.data.vaultKeys[vaultId];
      await this.saveData(this.data);
      return null;
    }
  }

  private async storeVaultCrypto(vaultId: string, key: Uint8Array): Promise<void> {
    this.vaultCryptos.set(vaultId, await VaultCrypto.fromKey(key));
    this.vaultKeyBytes.set(vaultId, key);
    if (this.data.settings.rememberVaultKey) {
      this.data.vaultKeys[vaultId] = {
        key: vaultKeyToBase64(key),
        savedAt: Date.now(),
      };
    } else {
      delete this.data.vaultKeys[vaultId];
    }
    await this.saveData(this.data);
  }

  private deviceName(): string {
    const configured = this.data.settings.deviceName.trim();
    if (configured) return configured;
    return `Obsidian (${platformName()})`;
  }

  private pluginDirectory(): string {
    return normalizePath(
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
    );
  }

  private requireApi(): SyncyApi {
    if (!this.api?.hasSession()) {
      throw new Error("Sign in to Syncy first");
    }
    return this.api;
  }

  private registerCommands(): void {
    this.addCommand({
      id: "syncy-sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow();
      },
    });
    this.addCommand({
      id: "syncy-full-resync",
      name: "Full resync",
      callback: () => {
        void this.fullResync();
      },
    });
    this.addCommand({
      id: "syncy-reset-local-state",
      name: "Reset local sync state",
      callback: () => {
        void this.resetLocalState();
      },
    });
    this.addCommand({
      id: "syncy-history",
      name: "Version history for the current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const eligible = file instanceof TFile && this.engine?.getFileId(file.path) !== null;
        if (checking) return eligible;
        if (file && eligible) this.openHistory(file);
        return true;
      },
    });
    this.addCommand({
      id: "syncy-sign-out",
      name: "Sign out",
      callback: () => {
        void this.signOut();
      },
    });
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.engine?.handleCreateOrModify(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.engine?.handleCreateOrModify(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.engine?.handleDelete(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.engine?.handleRename(file.path, oldPath);
      }),
    );
  }

  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (!(file instanceof TFile)) return;
        if (!this.engine?.getFileId(file.path)) return;
        menu.addItem((item) => {
          item
            .setTitle("Syncy: version history")
            .setIcon("history")
            .onClick(() => this.openHistory(file));
        });
      }),
    );
  }

  private renderStatus(status: EngineStatus): void {
    const labels: Record<EngineStatus["phase"], string> = {
      idle: "idle",
      syncing: "syncing",
      synced: "synced",
      error: "error",
      paused: "paused",
    };
    const last = status.lastSyncAt
      ? `Last sync: ${new Date(status.lastSyncAt).toLocaleString()}`
      : "Not synced yet";
    this.setStatus(labels[status.phase], status.phase, `${status.message}\n${last}`);
  }

  private setStatus(text: string, state: string, tooltip?: string): void {
    this.statusBarEl.setText(`Syncy: ${text}`);
    this.statusBarEl.dataset.state = state;
    const detail = tooltip ?? text;
    this.statusBarEl.setAttribute("aria-label", detail);
    this.statusBarEl.setAttribute("title", detail);
  }
}

function platformName(): string {
  if (Platform.isMobile) return Platform.isAndroidApp ? "android" : "ios";
  if (Platform.isMacOS) return "macos";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  return "desktop";
}
