import type { SyncyApi } from "./api";
import type { WsServerMessage } from "./types";
import { AuthLostError, NetworkError, SyncyApiError } from "./util/errors";

export interface RealtimeHandlers {
  onVaultChanged: (revision: number, originDeviceId: string | null) => void;
  onVaultUpdated: (name: string) => void;
  onVaultDeleted: () => void;
  onMembershipChanged: () => void;
  onConnected: () => void;
  onAuthLost: (message: string) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 25_000;

export class RealtimeClient {
  private readonly api: SyncyApi;
  private readonly vaultId: string;
  private readonly handlers: RealtimeHandlers;
  private socket: WebSocket | null = null;
  private started = false;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private attempts = 0;

  constructor(api: SyncyApi, vaultId: string, handlers: RealtimeHandlers) {
    this.api = api;
    this.vaultId = vaultId;
    this.handlers = handlers;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  private async connect(): Promise<void> {
    if (!this.started) return;
    try {
      const ticket = await this.api.getWsTicket();
      const url = this.api.webSocketUrl(ticket.ticket);
      if (!url) throw new NetworkError("The server URL cannot be used for WebSocket connections");
      if (!this.started) return;

      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        this.attempts = 0;
      };
      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {}
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
          this.stopPing();
          this.scheduleReconnect();
        }
      };
    } catch (error) {
      if (error instanceof AuthLostError) {
        this.handlers.onAuthLost(error.message);
        this.stop();
        return;
      }
      if (error instanceof SyncyApiError && error.status === 401) {
        this.handlers.onAuthLost(error.message);
        this.stop();
        return;
      }
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: WsServerMessage;
    try {
      message = JSON.parse(raw) as WsServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case "hello":
        this.send({ type: "subscribe", vaultId: this.vaultId });
        this.startPing();
        break;
      case "subscribed":
        this.handlers.onConnected();
        break;
      case "vault_changed":
        if (message.vaultId === this.vaultId) {
          this.handlers.onVaultChanged(message.revision, message.originDeviceId);
        }
        break;
      case "vault_updated":
        if (message.vaultId === this.vaultId) {
          this.handlers.onVaultUpdated(message.name);
        }
        break;
      case "vault_deleted":
        if (message.vaultId === this.vaultId) {
          this.handlers.onVaultDeleted();
          this.stop();
        }
        break;
      case "unsubscribed":
        if (message.vaultId === this.vaultId && message.reason === "membership_changed") {
          this.handlers.onMembershipChanged();
          this.stop();
        }
        break;
      case "error":
        if (message.code === "VAULT_NOT_FOUND" && message.vaultId === this.vaultId) {
          this.handlers.onMembershipChanged();
          this.stop();
        }
        break;
      default:
        break;
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      this.socket.close();
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== null) return;
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts);
    const delay = exponential + Math.floor(Math.random() * 500);
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
