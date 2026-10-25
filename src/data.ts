import type { StoredSession, StoredVaultKey } from "./types";

export interface SyncySettings {
  serverUrl: string;
  email: string;
  deviceName: string;
  vaultId: string | null;
  vaultName: string;
  syncEnabled: boolean;
  intervalSeconds: number;
  realtime: boolean;
  syncOnStartup: boolean;
  syncConfig: boolean;
  syncWorkspace: boolean;
  syncPluginData: boolean;
  excludePatterns: string[];
  rememberVaultKey: boolean;
}

export interface PluginData {
  version: 1;
  settings: SyncySettings;
  session: StoredSession | null;
  vaultKeys: Record<string, StoredVaultKey>;
}

export const DEFAULT_SETTINGS: SyncySettings = {
  serverUrl: "http://localhost:8080",
  email: "",
  deviceName: "",
  vaultId: null,
  vaultName: "",
  syncEnabled: true,
  intervalSeconds: 30,
  realtime: true,
  syncOnStartup: true,
  syncConfig: true,
  syncWorkspace: false,
  syncPluginData: false,
  excludePatterns: [],
  rememberVaultKey: true,
};

export function defaultPluginData(): PluginData {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    session: null,
    vaultKeys: {},
  };
}

export function mergePluginData(raw: unknown): PluginData {
  const fallback = defaultPluginData();
  if (typeof raw !== "object" || raw === null) return fallback;
  const value = raw as Partial<PluginData>;
  const settings = typeof value.settings === "object" && value.settings !== null ? value.settings : {};
  const mergedSettings: SyncySettings = { ...DEFAULT_SETTINGS, ...settings };
  if (!Array.isArray(mergedSettings.excludePatterns)) {
    mergedSettings.excludePatterns = [];
  }
  return {
    version: 1,
    settings: mergedSettings,
    session: value.session ?? null,
    vaultKeys: typeof value.vaultKeys === "object" && value.vaultKeys !== null ? value.vaultKeys : {},
  };
}

export function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
