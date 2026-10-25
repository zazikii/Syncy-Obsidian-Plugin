import { type RequestUrlResponse, requestUrl } from "obsidian";
import type {
  ChangesPage,
  DeviceInfo,
  FilePage,
  PushChange,
  PushResult,
  ServerInfo,
  Session,
  StoredSession,
  Vault,
  VersionsPage,
  WsTicket,
} from "./types";
import { AuthLostError, isSyncyApiError, NetworkError, SyncyApiError } from "./util/errors";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  auth?: boolean;
  allowStatuses?: number[];
  retryUnauthorized?: boolean;
  retryRateLimit?: number;
}

export interface ApiSessionHandlers {
  saveSession: (session: StoredSession) => Promise<void>;
  clearSession: () => Promise<void>;
  onAuthLost: (message: string) => void;
}

function parseErrorBody(response: RequestUrlResponse): {
  code: string;
  message: string;
  details: unknown;
} {
  let text = "";
  try {
    text = response.text;
  } catch {
    text = "";
  }
  try {
    const parsed = response.json as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const error = parsed?.error;
    if (error && typeof error.code === "string" && typeof error.message === "string") {
      return { code: error.code, message: error.message, details: error.details };
    }
  } catch {
    // Fall through to a generic error below.
  }
  return {
    code: "HTTP_ERROR",
    message: text.slice(0, 300) || "The server returned an error",
    details: null,
  };
}

export class SyncyApi {
  private serverUrl: string;
  private session: StoredSession | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  private readonly handlers: ApiSessionHandlers;

  constructor(serverUrl: string, handlers: ApiSessionHandlers) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.handlers = handlers;
  }

  setServerUrl(serverUrl: string): void {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getSession(): StoredSession | null {
    return this.session;
  }

  getUserId(): string | null {
    return this.session?.user.id ?? null;
  }

  getDeviceId(): string | null {
    return this.session?.deviceId ?? null;
  }

  async restoreSession(session: StoredSession): Promise<void> {
    this.session = session;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  hasSession(): boolean {
    return this.session !== null;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    let url = `${this.serverUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        params.set(key, String(value));
      }
      const serialized = params.toString();
      if (serialized) url += `?${serialized}`;
    }
    return url;
  }

  private async send(rawUrl: string, options: RequestOptions): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = { Accept: "application/json", ...options.headers };

    try {
      return await requestUrl({
        url: rawUrl,
        method: options.method ?? "GET",
        headers,
        body: options.body,
        throw: false,
      });
    } catch (error) {
      throw new NetworkError(`Could not reach ${this.serverUrl}`, error);
    }
  }

  private async ensureAccessToken(forceRefresh = false): Promise<string> {
    if (!this.session) {
      throw new AuthLostError("Not signed in");
    }
    const now = Date.now();
    if (!forceRefresh && this.accessToken && this.accessTokenExpiresAt - 60_000 > now) {
      return this.accessToken;
    }
    if (this.session.refreshTokenExpiresAt < now) {
      await this.clearSession("Your session has expired. Sign in again.");
      throw new AuthLostError("Session expired");
    }
    await this.refreshSession();
    if (!this.accessToken) throw new AuthLostError("Could not refresh the session");
    return this.accessToken;
  }

  private async refreshSession(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const session = this.session;
      if (!session) throw new AuthLostError("Not signed in");

      const response = await this.send(this.url("/v1/auth/refresh"), {
        method: "POST",
        json: { refreshToken: session.refreshToken },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        headers: { "Content-Type": "application/json" },
      });

      if (response.status !== 200) {
        const error = parseErrorBody(response);
        if (response.status === 401 || response.status === 403) {
          await this.clearSession(
            error.code === "REFRESH_TOKEN_REUSED"
              ? "Your session was revoked. Sign in again."
              : error.message,
          );
          throw new AuthLostError(error.message);
        }
        throw new SyncyApiError(response.status, error.code, error.message, error.details);
      }

      const next = response.json as Session;
      const stored: StoredSession = {
        refreshToken: next.refreshToken,
        refreshTokenExpiresAt: next.refreshTokenExpiresAt,
        deviceId: next.deviceId,
        user: next.user,
        serverUrl: this.serverUrl,
      };
      this.session = stored;
      this.accessToken = next.accessToken;
      this.accessTokenExpiresAt = next.accessTokenExpiresAt;
      await this.handlers.saveSession(stored);
    })().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async clearSession(message: string): Promise<void> {
    this.session = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    await this.handlers.clearSession();
    this.handlers.onAuthLost(message);
  }

  private async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    if (response.status === 204) return undefined as T;
    try {
      return response.json as T;
    } catch {
      return JSON.parse(response.text) as T;
    }
  }

  private async request(path: string, options: RequestOptions = {}): Promise<RequestUrlResponse> {
    const auth = options.auth !== false;
    const allowStatuses = options.allowStatuses ?? [];
    const maxRateLimitRetries = options.retryRateLimit ?? 2;
    let rateLimitRetries = 0;
    let unauthorizedRetried = false;

    for (;;) {
      const headers: Record<string, string> = { ...options.headers };
      let body = options.body;

      if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers["Content-Type"] = "application/json";
      }

      if (auth) {
        const token = await this.ensureAccessToken();
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await this.send(this.url(path, options.query), {
        ...options,
        headers,
        body,
      });

      if (
        response.status === 401 &&
        auth &&
        !unauthorizedRetried &&
        options.retryUnauthorized !== false
      ) {
        const error = parseErrorBody(response);
        if (error.code === "TOKEN_EXPIRED" || error.code === "UNAUTHORIZED") {
          unauthorizedRetried = true;
          await this.ensureAccessToken(true);
          continue;
        }
        if (
          error.code === "TOKEN_REVOKED" ||
          error.code === "DEVICE_REVOKED" ||
          error.code === "REFRESH_TOKEN_REUSED"
        ) {
          await this.clearSession(error.message);
          throw new AuthLostError(error.message);
        }
      }

      if (response.status === 429 && rateLimitRetries < maxRateLimitRetries) {
        rateLimitRetries += 1;
        const retryAfter = Number.parseFloat(response.headers["retry-after"] ?? "");
        const delay = Number.isFinite(retryAfter)
          ? Math.min(30_000, Math.max(500, retryAfter * 1000))
          : 1000 * 2 ** rateLimitRetries;
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        continue;
      }

      if (response.status >= 200 && response.status < 300) return response;
      if (allowStatuses.includes(response.status)) return response;

      const error = parseErrorBody(response);
      if (response.status === 401 && auth) {
        if (error.code === "TOKEN_REVOKED" || error.code === "DEVICE_REVOKED") {
          await this.clearSession(error.message);
          throw new AuthLostError(error.message);
        }
      }
      throw new SyncyApiError(response.status, error.code, error.message, error.details);
    }
  }

  async getInfo(): Promise<ServerInfo> {
    return this.requestJson<ServerInfo>("/v1/info", { auth: false });
  }

  async login(email: string, password: string, device: DeviceInfo): Promise<StoredSession> {
    const response = await this.request("/v1/auth/login", {
      method: "POST",
      json: { email, password, device },
      auth: false,
    });
    const session = response.json as Session;
    const stored: StoredSession = {
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
      deviceId: session.deviceId,
      user: session.user,
      serverUrl: this.serverUrl,
    };
    this.session = stored;
    this.accessToken = session.accessToken;
    this.accessTokenExpiresAt = session.accessTokenExpiresAt;
    await this.handlers.saveSession(stored);
    return stored;
  }

  async logout(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    try {
      if (session) {
        await this.send(this.url("/v1/auth/logout"), {
          method: "POST",
          body: JSON.stringify({ refreshToken: session.refreshToken }),
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch {
      // Signing out locally is what matters; the server token will expire.
    }
    await this.handlers.clearSession();
  }

  async getVaults(): Promise<Vault[]> {
    const response = await this.requestJson<{ vaults: Vault[] }>("/v1/vaults");
    return response.vaults;
  }

  async getVault(vaultId: string): Promise<Vault> {
    const response = await this.requestJson<{ vault: Vault }>(
      `/v1/vaults/${encodeURIComponent(vaultId)}`,
    );
    return response.vault;
  }

  async createVault(input: { name: string; e2ee: boolean; keyEnvelope?: string }): Promise<Vault> {
    const response = await this.requestJson<{ vault: Vault }>("/v1/vaults", {
      method: "POST",
      json: {
        name: input.name,
        e2ee: input.e2ee,
        ...(input.keyEnvelope ? { keyEnvelope: input.keyEnvelope } : {}),
      },
    });
    return response.vault;
  }

  async renameVault(vaultId: string, name: string): Promise<Vault> {
    const response = await this.requestJson<{ vault: Vault }>(
      `/v1/vaults/${encodeURIComponent(vaultId)}`,
      { method: "PATCH", json: { name } },
    );
    return response.vault;
  }

  async listFiles(
    vaultId: string,
    options: { cursor?: string | null; limit?: number; includeDeleted?: boolean } = {},
  ): Promise<FilePage> {
    return this.requestJson<FilePage>(`/v1/vaults/${encodeURIComponent(vaultId)}/files`, {
      query: {
        cursor: options.cursor ?? undefined,
        limit: options.limit ?? 1000,
        includeDeleted: options.includeDeleted ?? false,
      },
    });
  }

  async getChanges(
    vaultId: string,
    options: { since: number; until?: number; limit?: number },
  ): Promise<ChangesPage> {
    return this.requestJson<ChangesPage>(`/v1/vaults/${encodeURIComponent(vaultId)}/changes`, {
      query: {
        since: options.since,
        until: options.until,
        limit: options.limit ?? 500,
      },
    });
  }

  async pushChanges(vaultId: string, changes: PushChange[], atomic: boolean): Promise<PushResult> {
    const response = await this.request(`/v1/vaults/${encodeURIComponent(vaultId)}/changes`, {
      method: "POST",
      json: { atomic, changes },
      allowStatuses: [409],
    });
    return response.json as PushResult;
  }

  async uploadBlob(vaultId: string, hash: string, bytes: ArrayBuffer): Promise<void> {
    await this.request(`/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${hash}`, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async blobExists(vaultId: string, hash: string): Promise<boolean> {
    try {
      const response = await this.send(
        this.url(`/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${hash}`),
        {
          method: "HEAD",
          headers: { Authorization: `Bearer ${await this.ensureAccessToken()}` },
        },
      );
      return response.status === 200;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      return false;
    }
  }

  async downloadBlob(vaultId: string, hash: string): Promise<ArrayBuffer> {
    const headers = {
      Authorization: `Bearer ${await this.ensureAccessToken()}`,
      Accept: "application/octet-stream",
    };
    const response = await this.send(
      this.url(`/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${hash}`),
      { method: "GET", headers },
    );
    if (response.status !== 200) {
      const error = parseErrorBody(response);
      throw new SyncyApiError(response.status, error.code, error.message, error.details);
    }
    return response.arrayBuffer;
  }

  async getVersions(
    vaultId: string,
    fileId: string,
    options: { cursor?: number | null; limit?: number } = {},
  ): Promise<VersionsPage> {
    return this.requestJson<VersionsPage>(
      `/v1/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(fileId)}/versions`,
      {
        query: {
          cursor: options.cursor ?? undefined,
          limit: options.limit ?? 50,
        },
      },
    );
  }

  async restoreVersion(
    vaultId: string,
    fileId: string,
    versionId: string,
    expectedRevision?: number,
  ): Promise<PushResult> {
    const response = await this.request(
      `/v1/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/restore`,
      {
        method: "POST",
        json: expectedRevision === undefined ? {} : { expectedRevision },
        allowStatuses: [409],
      },
    );
    return response.json as PushResult;
  }

  async getWsTicket(): Promise<WsTicket> {
    return this.requestJson<WsTicket>("/v1/auth/ws-ticket", { method: "POST", json: {} });
  }

  webSocketUrl(ticket: string): string | null {
    try {
      const url = new URL(this.serverUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/ws`;
      url.search = `?ticket=${encodeURIComponent(ticket)}`;
      return url.toString();
    } catch {
      return null;
    }
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AuthLostError;
}

export function isRetryableApiError(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (!isSyncyApiError(error)) return false;
  return error.status === 429 || error.status >= 500;
}
