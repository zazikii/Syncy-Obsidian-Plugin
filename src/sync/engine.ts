import { type App, type DataAdapter, TFolder } from "obsidian";
import type { SyncyApi } from "../api";
import { CryptoError, type VaultCrypto } from "../crypto";
import type { PendingChange, SyncStateStore } from "../state";
import type { Change, FileSummary, PushChange, PushConflict, PushResult } from "../types";
import { base64UrlToBytes, bytesToBase64Url, randomId } from "../util/encoding";
import { AuthLostError, isSyncyApiError, SyncPausedError, SyncyApiError } from "../util/errors";
import { sha256Hex } from "../util/hash";
import {
  conflictCopyPath,
  isSubPath,
  normalizeVaultPath,
  parentPath,
  pathKey,
  replacePathPrefix,
  uniquePathAsync,
} from "../util/path";

export type EnginePhase = "idle" | "syncing" | "synced" | "error" | "paused";

export interface EngineStatus {
  phase: EnginePhase;
  message: string;
  lastSyncAt: number | null;
}

export interface SyncEngineOptions {
  app: App;
  api: SyncyApi;
  vaultId: string;
  e2ee: boolean;
  vaultCrypto: VaultCrypto | null;
  state: SyncStateStore;
  intervalSeconds: number;
  syncOnStartup: boolean;
  isExcluded: (path: string) => boolean;
  maxBlobBytes: () => number;
  onStatus: (status: EngineStatus) => void;
  notify: (message: string) => void;
  onAuthLost: (message: string) => void;
  onVaultUnavailable: (message: string) => void;
}

const PULL_LIMIT = 500;
const SNAPSHOT_LIMIT = 1000;
const PUSH_BATCH_SIZE = 200;
const PUSH_ROUNDS = 6;
const UPLOAD_CONCURRENCY = 4;
const TOO_LARGE_RETRY_MS = 24 * 60 * 60 * 1000;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      const item = items[current];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

interface ServerFileInfo {
  path: string;
  content: ArrayBuffer | null;
  localHash: string | null;
}

interface PreparedBlob {
  ok: boolean;
  changed: boolean;
}

export class SyncEngine {
  private readonly options: SyncEngineOptions;
  private readonly app: App;
  private readonly adapter: DataAdapter;
  private readonly api: SyncyApi;
  private readonly state: SyncStateStore;
  private readonly vaultId: string;

  private started = false;
  private syncing = false;
  private syncQueued = false;
  private currentSync: Promise<void> | null = null;
  private syncTimer: number | null = null;
  private retryTimer: number | null = null;
  private intervalTimer: number | null = null;
  private localTimer: number | null = null;
  private retryDelay = 1000;
  private readOnly = false;
  private applying = 0;
  private forceFull = false;
  private lastStatus: EngineStatus = { phase: "idle", message: "", lastSyncAt: null };

  private readonly touchedPaths = new Map<string, { path: string; action: "upsert" | "delete" }>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly tooLarge = new Set<string>();
  private conflictNotices = 0;

  constructor(options: SyncEngineOptions) {
    this.options = options;
    this.app = options.app;
    this.adapter = options.app.vault.adapter;
    this.api = options.api;
    this.state = options.state;
    this.vaultId = options.vaultId;
    this.lastStatus.lastSyncAt = options.state.state.lastSyncAt;
  }

  getState(): SyncStateStore {
    return this.state;
  }

  getStatus(): EngineStatus {
    return this.lastStatus;
  }

  getFileId(path: string): string | null {
    return this.state.fileIdAt(path);
  }

  isApplying(): boolean {
    return this.applying > 0;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit("idle", "Starting sync");
    if (this.options.intervalSeconds > 0) {
      this.intervalTimer = window.setInterval(() => {
        this.scheduleSync(0);
      }, Math.max(10, this.options.intervalSeconds) * 1000);
    }
    if (this.options.syncOnStartup) {
      this.scheduleSync(100);
    } else {
      this.emit("idle", "Ready to sync");
    }
  }

  stop(): void {
    this.started = false;
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
    if (this.intervalTimer !== null) window.clearInterval(this.intervalTimer);
    this.syncTimer = null;
    this.retryTimer = null;
    this.localTimer = null;
    this.intervalTimer = null;
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    if (this.currentSync) await this.currentSync.catch(() => undefined);
  }

  notifyRemoteChange(originDeviceId?: string | null): void {
    if (originDeviceId && originDeviceId === this.api.getDeviceId()) return;
    this.scheduleSync(500);
  }

  async syncNow(): Promise<void> {
    if (!this.started) return;
    if (this.syncing) {
      this.syncQueued = true;
      if (this.currentSync) await this.currentSync;
      return;
    }
    this.syncing = true;
    this.currentSync = this.runSync().finally(() => {
      this.syncing = false;
      this.currentSync = null;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.scheduleSync(300);
      }
    });
    await this.currentSync;
  }

  async requestFullResync(): Promise<void> {
    this.forceFull = true;
    await this.syncNow();
  }

  resetState(): void {
    this.state.reset(true);
    this.touchedPaths.clear();
    this.suppressedUntil.clear();
  }

  private schedulePendingRetry(): void {
    const now = Date.now();
    const hasActive = this.state
      .pendingEntries()
      .some((entry) => entry.notBefore === null || entry.notBefore <= now);
    if (hasActive) this.scheduleSync(1000);
  }

  private scheduleSync(delay: number): void {
    if (!this.started) return;
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow().catch(() => undefined);
    }, delay);
  }

  private emit(phase: EnginePhase, message: string): void {
    this.lastStatus = {
      phase,
      message,
      lastSyncAt: this.state.state.lastSyncAt,
    };
    this.options.onStatus(this.lastStatus);
  }

  private async runSync(): Promise<void> {
    this.emit("syncing", "Syncing");
    let fullAttempted = false;

    for (;;) {
      try {
        if (!this.state.state.initialized || this.forceFull) {
          this.forceFull = false;
          await this.fullSync();
        }
        if (!this.state.state.initialized) {
          throw new SyncPausedError("Sync state is not initialized");
        }
        await this.pullChanges();
        if (!this.readOnly) await this.pushAll();
        this.state.touch(null);
        await this.state.flush();
        this.retryDelay = 1000;
        this.emit("synced", this.readOnly ? "Read-only access" : "Synced");
        this.schedulePendingRetry();
        return;
      } catch (error) {
        if (
          isSyncyApiError(error) &&
          (error.code === "CURSOR_EXPIRED" || error.code === "CURSOR_AHEAD")
        ) {
          if (!fullAttempted) {
            fullAttempted = true;
            this.forceFull = true;
            continue;
          }
        }
        await this.handleSyncError(error);
        return;
      }
    }
  }

  private async handleSyncError(error: unknown): Promise<void> {
    await this.state.flush().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Unknown sync error";
    this.state.touch(message);
    await this.state.flush().catch(() => undefined);

    if (!this.started) return;

    if (error instanceof SyncPausedError || error instanceof CryptoError) {
      this.emit("paused", message);
      return;
    }
    if (isSyncyApiError(error)) {
      if (error.status === 401 || error.status === 403) {
        if (error.code === "INSUFFICIENT_ROLE") {
          this.readOnly = true;
          this.emit("paused", "Read-only vault access");
          this.options.notify("Syncy has read-only access to this vault.");
          return;
        }
      }
      if (error.code === "VAULT_NOT_FOUND") {
        this.stop();
        this.options.onVaultUnavailable("This vault is no longer available. Check your account.");
        return;
      }
    }
    if (error instanceof AuthLostError) {
      this.stop();
      this.options.onAuthLost(message);
      return;
    }

    this.emit("error", message);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow().catch(() => undefined);
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 5 * 60 * 1000);
  }

  private async fullSync(): Promise<void> {
    const firstSync = !this.state.state.initialized;
    const livePaths = new Set<string>();
    let snapshotRevision: number | null = null;
    let cursor: string | null = null;

    this.emit("syncing", "Reading server snapshot");

    for (;;) {
      const page = await this.api.listFiles(this.vaultId, {
        cursor,
        limit: SNAPSHOT_LIMIT,
        includeDeleted: true,
      });
      if (snapshotRevision === null) snapshotRevision = page.revision;
      for (const file of page.files) {
        await this.adoptServerFile(file, livePaths, firstSync);
      }
      cursor = page.nextCursor;
      await this.state.flush();
      if (!page.hasMore || !cursor) break;
    }

    this.state.setCursor(snapshotRevision ?? 0);
    this.state.state.lastFullSyncAt = Date.now();
    await this.state.flush();

    await this.scanLocalExtras();
    this.state.state.initialized = true;
    await this.state.flush();
  }

  private async scanLocalExtras(): Promise<void> {
    const files = this.app.vault.getFiles();
    for (const file of files) {
      const path = normalizeVaultPath(file.path);
      if (this.options.isExcluded(path)) continue;
      if (this.state.fileIdAt(path) || this.state.pendingIdAt(path)) continue;
      await this.enqueueUpsertFromDisk(path, false);
    }

    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((item): item is TFolder => item instanceof TFolder);
    for (const folder of folders) {
      const path = normalizeVaultPath(folder.path);
      if (!path || this.options.isExcluded(path)) continue;
      if (this.state.fileIdAt(path) || this.state.pendingIdAt(path)) continue;
      await this.enqueueFolderUpsert(path);
    }
  }

  private async adoptServerFile(
    server: FileSummary,
    livePaths: Set<string>,
    firstSync: boolean,
  ): Promise<void> {
    if (server.encrypted && !this.options.e2ee) {
      throw new SyncPausedError("The server reports an encrypted vault");
    }
    const path = await this.decodeServerPath(server);
    if (this.options.isExcluded(path)) return;
    livePaths.add(pathKey(path));

    if (server.deleted) {
      if (firstSync) return;
      const entry = this.state.state.files[server.fileId];
      if (!entry) return;
      if (this.state.hasPending(server.fileId)) return;
      await this.removeLocalPath(entry.path, entry.kind);
      this.state.removeFile(server.fileId);
      return;
    }

    if (this.state.hasPending(server.fileId)) return;

    const existing = this.state.state.files[server.fileId];
    const otherOwner = this.state.fileIdAt(path);
    if (otherOwner && otherOwner !== server.fileId) {
      await this.detachConflictingLocal(otherOwner);
    }

    if (server.kind === "folder") {
      await this.ensureFolder(path);
      if (existing && existing.path !== path) {
        this.remapStateTree(existing.path, path);
        await this.moveLocalPath(existing.path, path);
      }
      this.state.setFile(server.fileId, {
        path,
        kind: "folder",
        revision: server.revision,
        hash: null,
        localHash: null,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }

    if (!server.hash) {
      this.state.setFile(server.fileId, {
        path,
        kind: "file",
        revision: server.revision,
        hash: null,
        localHash: null,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }

    const localStat = await this.adapter.stat(path);
    const previousStat = existing ? await this.adapter.stat(existing.path) : null;

    if (existing && existing.hash === server.hash && previousStat?.type === "file") {
      if (existing.path !== path) await this.moveLocalPath(existing.path, path);
      this.state.setFile(server.fileId, {
        ...existing,
        path,
        revision: server.revision,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }

    if (!localStat) {
      if (existing && existing.path !== path) {
        const oldStat = await this.adapter.stat(existing.path);
        if (oldStat?.type === "file") {
          await this.moveLocalPath(existing.path, path);
          this.state.setFile(server.fileId, {
            ...existing,
            path,
            revision: server.revision,
            mtime: server.mtime,
            ctime: server.ctime,
          });
          return;
        }
      }
      const info = await this.fetchServerFile(server);
      await this.writeLocalFile(path, info.content!);
      this.state.setFile(server.fileId, {
        path,
        kind: "file",
        revision: server.revision,
        hash: server.hash,
        localHash: info.localHash,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }

    if (localStat.type === "folder") {
      throw new SyncPausedError(`Cannot replace folder with file: ${path}`);
    }

    if (!this.options.e2ee) {
      const content = await this.adapter.readBinary(path);
      const localHash = await sha256Hex(content);
      if (localHash === server.hash) {
        if (existing && existing.path !== path)
          await this.removeLocalPath(existing.path, existing.kind);
        this.state.setFile(server.fileId, {
          path,
          kind: "file",
          revision: server.revision,
          hash: server.hash,
          localHash,
          mtime: server.mtime,
          ctime: server.ctime,
        });
        return;
      }
      await this.preserveLocalConflict(path, content);
      const info = await this.fetchServerFile(server);
      await this.writeLocalFile(path, info.content!);
      this.state.setFile(server.fileId, {
        path,
        kind: "file",
        revision: server.revision,
        hash: server.hash,
        localHash: info.localHash,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }

    const info = await this.fetchServerFile(server);
    const content = await this.adapter.readBinary(path);
    const localHash = await sha256Hex(content);
    if (localHash === info.localHash) {
      if (existing && existing.path !== path)
        await this.removeLocalPath(existing.path, existing.kind);
      this.state.setFile(server.fileId, {
        path,
        kind: "file",
        revision: server.revision,
        hash: server.hash,
        localHash,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }
    await this.preserveLocalConflict(path, content);
    await this.writeLocalFile(path, info.content!);
    this.state.setFile(server.fileId, {
      path,
      kind: "file",
      revision: server.revision,
      hash: server.hash,
      localHash: info.localHash,
      mtime: server.mtime,
      ctime: server.ctime,
    });
  }

  private async detachConflictingLocal(fileId: string): Promise<void> {
    const entry = this.state.state.files[fileId];
    if (!entry) return;
    if (this.state.hasPending(fileId)) return;
    if (entry.kind === "file") {
      const content = await this.readLocalFile(entry.path);
      if (content) {
        await this.preserveLocalConflict(entry.path, content);
      }
    }
    this.state.removeFile(fileId);
  }

  private async preserveLocalConflict(path: string, content: ArrayBuffer): Promise<string | null> {
    const copyPath = await this.pickConflictPath(path);
    const fileId = randomId();
    await this.writeLocalFile(copyPath, content);
    const prepared = await this.prepareContent(fileId, content);
    this.state.enqueue({
      fileId,
      path: copyPath,
      kind: "file",
      deleted: false,
      encrypted: this.options.e2ee,
      hash: prepared.hash,
      localHash: prepared.localHash,
      nonce: prepared.nonce,
      size: content.byteLength,
      mtime: Date.now(),
      ctime: Date.now(),
      expectedRevision: null,
    });
    this.notifyConflict(copyPath);
    return copyPath;
  }

  private async pullChanges(): Promise<void> {
    const vault = await this.api.getVault(this.vaultId);
    if (vault.e2ee !== this.options.e2ee) {
      throw new SyncPausedError("Vault encryption mode changed on the server");
    }
    const until = vault.revision;
    if (this.state.state.cursor > until || this.state.state.cursor < vault.prunedBeforeRevision) {
      throw new SyncyApiError(410, "CURSOR_EXPIRED", "The change cursor is no longer valid");
    }
    if (this.state.state.cursor === until) return;

    this.emit("syncing", "Pulling changes");
    for (;;) {
      const page = await this.api.getChanges(this.vaultId, {
        since: this.state.state.cursor,
        until,
        limit: PULL_LIMIT,
      });
      for (const change of page.changes) {
        await this.applyChange(change);
      }
      this.state.setCursor(page.nextCursor);
      await this.state.flush();
      if (!page.hasMore || page.changes.length === 0) break;
      if (this.state.state.cursor >= until) break;
    }
  }

  private async applyChange(change: Change): Promise<void> {
    const entry = this.state.state.files[change.fileId];
    if (entry && entry.revision >= change.revision) return;
    if (this.state.hasPending(change.fileId)) return;

    const path = await this.decodeServerPath(change);
    if (this.options.isExcluded(path)) return;

    const otherOwner = this.state.fileIdAt(path);
    if (otherOwner && otherOwner !== change.fileId && !this.state.hasPending(otherOwner)) {
      await this.detachConflictingLocal(otherOwner);
    }

    if (change.deleted) {
      if (entry) {
        await this.removeLocalPath(entry.path, entry.kind);
        this.state.removeFile(change.fileId);
      }
      return;
    }

    if (change.kind === "folder") {
      await this.ensureFolder(path);
      if (entry && entry.path !== path) {
        this.remapStateTree(entry.path, path);
        await this.moveLocalPath(entry.path, path);
      }
      this.state.setFile(change.fileId, {
        path,
        kind: "folder",
        revision: change.revision,
        hash: null,
        localHash: null,
        mtime: change.mtime,
        ctime: change.ctime,
      });
      return;
    }

    if (!change.hash) return;

    if (entry && entry.hash === change.hash && entry.kind === "file") {
      const stat = await this.adapter.stat(entry.path);
      if (stat?.type === "file") {
        if (entry.path !== path) await this.moveLocalPath(entry.path, path);
        this.state.setFile(change.fileId, {
          ...entry,
          path,
          revision: change.revision,
          mtime: change.mtime,
          ctime: change.ctime,
        });
        return;
      }
    }

    const info = await this.fetchServerFile(change);
    if (entry && entry.path !== path) {
      await this.removeLocalPath(entry.path, entry.kind);
    }
    await this.writeLocalFile(path, info.content!);
    this.state.setFile(change.fileId, {
      path,
      kind: "file",
      revision: change.revision,
      hash: change.hash,
      localHash: info.localHash,
      mtime: change.mtime,
      ctime: change.ctime,
    });
  }

  private async pushAll(): Promise<void> {
    for (let round = 0; round < PUSH_ROUNDS; round += 1) {
      const now = Date.now();
      const active = this.state
        .pendingEntries()
        .filter((entry) => entry.notBefore === null || entry.notBefore <= now)
        .sort((left, right) => left.seq - right.seq);
      if (active.length === 0) return;

      const moves = active.filter((entry) => this.isMove(entry));
      const rest = active.filter((entry) => !this.isMove(entry));
      const batches: Array<{ entries: PendingChange[]; atomic: boolean }> = [
        ...chunk(moves, PUSH_BATCH_SIZE).map((entries) => ({ entries, atomic: true })),
        ...chunk(rest, PUSH_BATCH_SIZE).map((entries) => ({ entries, atomic: false })),
      ];

      let progress = false;
      for (const batch of batches) {
        const outcome = await this.pushBatch(batch.entries, batch.atomic);
        if (outcome.progress) progress = true;
        if (outcome.readOnly) {
          this.readOnly = true;
          return;
        }
      }
      await this.state.flush();
      if (!progress) return;
    }
  }

  private isMove(entry: PendingChange): boolean {
    if (entry.deleted || !entry.movedFrom) return false;
    return pathKey(entry.movedFrom) !== pathKey(entry.path);
  }

  private async pushBatch(
    entries: PendingChange[],
    atomic: boolean,
  ): Promise<{ progress: boolean; readOnly: boolean }> {
    let progress = false;
    let blobRetried = false;

    for (;;) {
      const blobResults = new Map<string, PreparedBlob>();
      const uploadTargets = entries.filter(
        (entry) =>
          !entry.deleted &&
          entry.kind === "file" &&
          this.state.pendingFor(entry.fileId)?.seq === entry.seq,
      );
      await runWithConcurrency(uploadTargets, UPLOAD_CONCURRENCY, async (entry) => {
        const result = await this.prepareBlob(entry);
        blobResults.set(entry.fileId, result);
        if (result.changed) progress = true;
      });

      const changes: Array<{ entry: PendingChange; change: PushChange }> = [];
      for (const entry of entries) {
        const current = this.state.pendingFor(entry.fileId);
        if (!current || current.seq !== entry.seq) continue;
        if (blobResults.get(entry.fileId)?.ok === false) continue;
        const change = await this.buildPushChange(entry);
        if (change) changes.push({ entry, change });
      }
      if (changes.length === 0) return { progress, readOnly: false };

      let response: PushResult;
      try {
        response = await this.api.pushChanges(
          this.vaultId,
          changes.map((item) => item.change),
          atomic,
        );
      } catch (error) {
        if (isSyncyApiError(error) && error.code === "BLOB_MISSING" && !blobRetried) {
          blobRetried = true;
          for (const item of changes) {
            if (item.entry.hash) {
              delete this.state.state.uploadedHashes[item.entry.hash];
            }
          }
          this.state.markDirty();
          progress = true;
          continue;
        }
        if (isSyncyApiError(error) && error.code === "INSUFFICIENT_ROLE") {
          return { progress, readOnly: true };
        }
        throw error;
      }

      for (const result of response.results) {
        const sent = changes.find((item) => item.entry.fileId === result.fileId);
        if (!sent) continue;
        if (result.status === "applied" || result.status === "skipped") {
          this.handleApplied(sent.entry, result);
          progress = true;
          continue;
        }
        if (result.status === "conflict" && result.conflict) {
          const resolved = await this.resolveConflict(sent.entry, result.conflict);
          if (resolved) progress = true;
          continue;
        }
        if (result.status === "rejected") {
          this.state.updatePending(sent.entry.fileId, {
            attempts: sent.entry.attempts + 1,
            notBefore: Date.now() + 250,
          });
        }
      }

      for (const conflict of response.conflicts) {
        if (changes.some((item) => item.entry.fileId === conflict.fileId)) continue;
        const pending = this.state.pendingFor(conflict.fileId);
        if (pending) await this.resolveConflict(pending, conflict);
      }

      return { progress, readOnly: false };
    }
  }

  private async prepareBlob(entry: PendingChange): Promise<PreparedBlob> {
    if (entry.deleted || entry.kind !== "file") return { ok: true, changed: false };
    if (!entry.hash) {
      await this.markPendingFailure(entry, "Missing content hash");
      return { ok: false, changed: false };
    }
    if (!this.state.hasUploaded(entry.hash)) {
      const stat = await this.adapter.stat(entry.path);
      if (stat?.type !== "file") {
        this.replaceWithDelete(entry);
        return { ok: false, changed: true };
      }
      const content = await this.adapter.readBinary(entry.path);
      const localHash = await sha256Hex(content);
      if (localHash !== entry.localHash) {
        await this.requeueFromDisk(entry, content, stat);
        return { ok: false, changed: true };
      }
      if (content.byteLength > this.options.maxBlobBytes()) {
        await this.markTooLarge(entry, content.byteLength);
        return { ok: false, changed: false };
      }

      let payload: ArrayBuffer = content;
      let hash = localHash;
      if (this.options.e2ee) {
        const vaultCrypto = this.requireCrypto();
        const nonce: Uint8Array | null = entry.nonce ? base64UrlToBytes(entry.nonce) : null;
        if (!nonce) {
          await this.requeueFromDisk(entry, content, stat);
          return { ok: false, changed: true };
        }
        const ciphertext = await vaultCrypto.encryptContent(content, entry.fileId, nonce);
        payload = toArrayBuffer(ciphertext);
        hash = await sha256Hex(payload);
        if (hash !== entry.hash) {
          await this.requeueFromDisk(entry, content, stat);
          return { ok: false, changed: true };
        }
      }

      try {
        await this.api.uploadBlob(this.vaultId, hash, payload);
      } catch (error) {
        if (isSyncyApiError(error) && error.status === 413) {
          await this.markTooLarge(entry, payload.byteLength);
          return { ok: false, changed: false };
        }
        throw error;
      }
      this.state.markUploaded(hash);
      return { ok: true, changed: false };
    }

    const stat = await this.adapter.stat(entry.path);
    if (stat?.type !== "file") {
      this.replaceWithDelete(entry);
      return { ok: false, changed: true };
    }
    if (entry.mtime && Math.abs(stat.mtime - entry.mtime) > 1500) {
      const content = await this.adapter.readBinary(entry.path);
      const localHash = await sha256Hex(content);
      if (localHash !== entry.localHash) {
        await this.requeueFromDisk(entry, content, stat);
        return { ok: false, changed: true };
      }
    }
    return { ok: true, changed: false };
  }

  private async requeueFromDisk(
    entry: PendingChange,
    content: ArrayBuffer,
    stat: { mtime: number; ctime: number; size: number },
  ): Promise<void> {
    const prepared = await this.prepareContent(entry.fileId, content);
    this.state.enqueue({
      fileId: entry.fileId,
      path: entry.path,
      kind: entry.kind,
      deleted: false,
      encrypted: this.options.e2ee,
      hash: prepared.hash,
      localHash: prepared.localHash,
      nonce: prepared.nonce,
      size: content.byteLength,
      mtime: stat.mtime,
      ctime: stat.ctime,
      expectedRevision: entry.expectedRevision,
      movedFrom: entry.movedFrom,
    });
  }

  private replaceWithDelete(entry: PendingChange): void {
    const known = this.state.state.files[entry.fileId];
    if (!known) {
      this.state.removePending(entry.fileId);
      return;
    }
    this.state.enqueue({
      fileId: entry.fileId,
      path: known.path,
      kind: known.kind,
      deleted: true,
      encrypted: this.options.e2ee,
      hash: null,
      localHash: null,
      nonce: null,
      size: 0,
      mtime: known.mtime,
      ctime: known.ctime,
      expectedRevision: known.revision,
      movedFrom: null,
    });
  }

  private async buildPushChange(entry: PendingChange): Promise<PushChange | null> {
    let path: string;
    try {
      path = this.options.e2ee ? await this.requireCrypto().encryptPath(entry.path) : entry.path;
    } catch (error) {
      await this.markPendingFailure(
        entry,
        error instanceof Error ? error.message : "Could not encrypt path",
      );
      return null;
    }

    const change: PushChange = {
      fileId: entry.fileId,
      path,
      kind: entry.kind,
      encrypted: this.options.e2ee,
      expectedRevision: entry.expectedRevision,
      mtime: positiveInt(entry.mtime, Date.now()),
      ctime: positiveInt(entry.ctime, Date.now()),
    };

    if (entry.deleted) {
      change.deleted = true;
    } else if (entry.kind === "file") {
      change.hash = entry.hash;
      if (!entry.hash) return null;
    }
    return change;
  }

  private handleApplied(entry: PendingChange, result: { revision?: number }): void {
    const revision = result.revision ?? entry.expectedRevision ?? 0;
    const current = this.state.pendingFor(entry.fileId);
    const changedDuringPush = current !== null && current.seq !== entry.seq;

    if (entry.deleted) {
      this.state.removeFile(entry.fileId);
    } else {
      this.state.setFile(entry.fileId, {
        path: entry.path,
        kind: entry.kind,
        revision,
        hash: entry.hash,
        localHash: entry.localHash,
        mtime: entry.mtime,
        ctime: entry.ctime,
      });
    }

    if (changedDuringPush) {
      this.state.updatePending(entry.fileId, {
        expectedRevision: revision,
        attempts: 0,
        notBefore: null,
        reason: null,
      });
    } else {
      this.state.removePending(entry.fileId, entry.seq);
    }
  }

  private async resolveConflict(entry: PendingChange, conflict: PushConflict): Promise<boolean> {
    const pending = this.state.pendingFor(entry.fileId);
    if (!pending) return false;

    if (conflict.code === "not_found") {
      if (pending.deleted) {
        this.state.removePending(pending.fileId);
        this.state.removeFile(pending.fileId);
        return true;
      }
      this.state.updatePending(pending.fileId, {
        expectedRevision: null,
        attempts: 0,
        notBefore: null,
        reason: null,
      });
      return true;
    }

    if (conflict.code === "path_taken") {
      return this.resolvePathTaken(pending, conflict);
    }

    if (
      conflict.code === "revision_mismatch" ||
      conflict.code === "already_exists" ||
      conflict.server !== undefined
    ) {
      return this.resolveRevisionConflict(pending, conflict.server ?? null);
    }

    await this.markPendingFailure(pending, conflict.message || "Unresolved sync conflict");
    return false;
  }

  private async resolveRevisionConflict(
    pending: PendingChange,
    server: FileSummary | null,
  ): Promise<boolean> {
    if (!server) {
      this.state.updatePending(pending.fileId, {
        expectedRevision: null,
        attempts: 0,
        notBefore: null,
        reason: null,
      });
      return true;
    }

    if (pending.kind === "folder" || server.kind === "folder") {
      if (server.deleted) {
        this.state.removeFile(pending.fileId);
        this.state.removePending(pending.fileId);
        return true;
      }
      await this.ensureFolder((await this.decodeServerPath(server)) || pending.path);
      const path = await this.decodeServerPath(server);
      if (path) {
        this.remapStateTree(pending.path, path);
        await this.moveLocalPath(pending.path, path);
      }
      this.state.setFile(pending.fileId, {
        path: path || pending.path,
        kind: "folder",
        revision: server.revision,
        hash: null,
        localHash: null,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      this.state.removePending(pending.fileId);
      return true;
    }

    if (pending.deleted) {
      if (server.deleted) {
        this.state.removeFile(pending.fileId);
      } else {
        await this.applyServerFile(server);
      }
      this.state.removePending(pending.fileId);
      return true;
    }

    if (server.deleted) {
      const content = await this.readLocalFile(pending.path);
      if (content) {
        await this.preserveLocalConflict(pending.path, content);
      }
      await this.removeLocalPath(pending.path, pending.kind);
      this.state.removeFile(pending.fileId);
      this.state.removePending(pending.fileId);
      return true;
    }

    if (!server.hash) {
      this.state.removePending(pending.fileId);
      return true;
    }

    const info = await this.fetchServerFile(server);
    if (info.localHash && pending.localHash && info.localHash === pending.localHash) {
      await this.adoptServerMetadata(pending, server, info.path);
      this.state.removePending(pending.fileId);
      return true;
    }

    const content = await this.readLocalFile(pending.path);
    if (content) {
      await this.preserveLocalConflict(pending.path, content);
    }
    this.state.removeFile(pending.fileId);
    this.state.removePending(pending.fileId);
    await this.applyServerFile(server, info);
    return true;
  }

  private async resolvePathTaken(pending: PendingChange, conflict: PushConflict): Promise<boolean> {
    const server = conflict.server;
    if (!server) {
      const copyPath = await this.pickConflictPath(pending.path);
      if (pending.kind === "folder") {
        await this.moveLocalPath(pending.path, copyPath);
      } else {
        const content = await this.readLocalFile(pending.path);
        if (content) await this.writeLocalFile(copyPath, content);
      }
      this.state.enqueue({
        fileId: pending.fileId,
        path: copyPath,
        kind: pending.kind,
        deleted: pending.deleted,
        encrypted: pending.encrypted,
        hash: pending.hash,
        localHash: pending.localHash,
        nonce: pending.nonce,
        size: pending.size,
        mtime: pending.mtime,
        ctime: pending.ctime,
        expectedRevision: pending.expectedRevision,
        movedFrom: pending.movedFrom,
      });
      return true;
    }

    const info =
      server.kind === "folder"
        ? { path: await this.decodeServerPath(server), content: null, localHash: null }
        : await this.fetchServerFile(server);
    const serverPath = info.path;
    const serverEntry = this.state.state.files[server.fileId];

    if (server.kind === "folder") {
      const content = await this.readLocalFile(pending.path);
      if (content) await this.preserveLocalConflict(pending.path, content);
      await this.ensureFolder(serverPath);
      this.state.setFile(server.fileId, {
        path: serverPath,
        kind: "folder",
        revision: server.revision,
        hash: null,
        localHash: null,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      this.state.removePending(pending.fileId);
      return true;
    }

    if (
      !serverEntry &&
      !this.state.state.files[pending.fileId] &&
      pending.localHash &&
      info.localHash &&
      pending.localHash === info.localHash
    ) {
      this.state.removeFile(pending.fileId);
      this.state.removePending(pending.fileId);
      this.state.setFile(server.fileId, {
        path: serverPath,
        kind: "file",
        revision: server.revision,
        hash: server.hash,
        localHash: info.localHash,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return true;
    }

    if (pending.kind === "folder") {
      if (serverPath) {
        await this.ensureFolder(serverPath);
        this.state.setFile(server.fileId, {
          path: serverPath,
          kind: "folder",
          revision: server.revision,
          hash: null,
          localHash: null,
          mtime: server.mtime,
          ctime: server.ctime,
        });
      }
      this.state.removePending(pending.fileId);
      return true;
    }

    const content = await this.readLocalFile(pending.path);
    if (content) {
      const copyPath = await this.pickConflictPath(pending.path);
      await this.writeLocalFile(copyPath, content);
      const prepared = await this.prepareContent(pending.fileId, content);
      this.state.enqueue({
        fileId: pending.fileId,
        path: copyPath,
        kind: "file",
        deleted: false,
        encrypted: this.options.e2ee,
        hash: prepared.hash,
        localHash: prepared.localHash,
        nonce: prepared.nonce,
        size: content.byteLength,
        mtime: pending.mtime,
        ctime: pending.ctime,
        expectedRevision: pending.expectedRevision,
        movedFrom: this.state.state.files[pending.fileId] ? pending.path : pending.movedFrom,
      });
      const known = this.state.state.files[pending.fileId];
      if (known) {
        this.state.setFile(pending.fileId, {
          ...known,
          path: copyPath,
          hash: prepared.hash,
          localHash: prepared.localHash,
        });
      }
    } else {
      this.state.removePending(pending.fileId);
    }

    this.state.setFile(server.fileId, {
      path: serverPath,
      kind: "file",
      revision: server.revision,
      hash: server.hash,
      localHash: info.localHash,
      mtime: server.mtime,
      ctime: server.ctime,
    });
    await this.applyServerFile(server, info);
    return true;
  }

  private async adoptServerMetadata(
    pending: PendingChange,
    server: FileSummary,
    path: string,
  ): Promise<void> {
    if (pending.path !== path) await this.moveLocalPath(pending.path, path);
    this.state.setFile(server.fileId, {
      path,
      kind: server.kind,
      revision: server.revision,
      hash: server.hash,
      localHash: pending.localHash,
      mtime: server.mtime,
      ctime: server.ctime,
    });
  }

  private async applyServerFile(server: FileSummary, info?: ServerFileInfo): Promise<void> {
    const path = info?.path ?? (await this.decodeServerPath(server));
    if (server.deleted) {
      this.state.removeFile(server.fileId);
      return;
    }
    if (server.kind === "folder") {
      await this.ensureFolder(path);
      this.state.setFile(server.fileId, {
        path,
        kind: "folder",
        revision: server.revision,
        hash: null,
        localHash: null,
        mtime: server.mtime,
        ctime: server.ctime,
      });
      return;
    }
    if (!server.hash) return;
    const data = info ?? (await this.fetchServerFile(server));
    await this.writeLocalFile(path, data.content!);
    this.state.setFile(server.fileId, {
      path,
      kind: "file",
      revision: server.revision,
      hash: server.hash,
      localHash: data.localHash,
      mtime: server.mtime,
      ctime: server.ctime,
    });
  }

  private async fetchServerFile(file: FileSummary | Change): Promise<ServerFileInfo> {
    if (!file.hash) throw new SyncPausedError("Server file has no content hash");
    const path = await this.decodeServerPath(file);
    const ciphertext = await this.api.downloadBlob(this.vaultId, file.hash);
    const actual = await sha256Hex(ciphertext);
    if (actual !== file.hash) {
      throw new SyncPausedError(`Downloaded file failed its integrity check: ${path}`);
    }
    let content: ArrayBuffer = ciphertext;
    if (file.encrypted || this.options.e2ee) {
      const plaintext = await this.requireCrypto().decryptContent(ciphertext, file.fileId);
      content = toArrayBuffer(plaintext);
    }
    const localHash = await sha256Hex(content);
    return { path, content, localHash };
  }

  private async decodeServerPath(file: { path: string; encrypted: boolean }): Promise<string> {
    if (file.encrypted || this.options.e2ee) {
      return this.requireCrypto().decryptPath(file.path);
    }
    return normalizeVaultPath(file.path);
  }

  private requireCrypto(): VaultCrypto {
    if (!this.options.vaultCrypto) {
      throw new SyncPausedError("This encrypted vault is locked");
    }
    return this.options.vaultCrypto;
  }

  private async prepareContent(
    fileId: string,
    content: ArrayBuffer,
  ): Promise<{ hash: string; localHash: string; nonce: string | null }> {
    const localHash = await sha256Hex(content);
    if (!this.options.e2ee) {
      return { hash: localHash, localHash, nonce: null };
    }
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const ciphertext = await this.requireCrypto().encryptContent(content, fileId, nonce);
    const hash = await sha256Hex(ciphertext);
    return { hash, localHash, nonce: bytesToBase64Url(nonce) };
  }

  private async enqueueUpsertFromDisk(path: string, notifyChange: boolean): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (this.options.isExcluded(normalized)) return;
    const stat = await this.adapter.stat(normalized);
    if (!stat) return;
    if (stat.type === "folder") {
      await this.enqueueFolderUpsert(normalized);
      return;
    }

    const content = await this.adapter.readBinary(normalized);
    const localHash = await sha256Hex(content);
    const known = this.state.entryAt(normalized);
    const pendingId = this.state.pendingIdAt(normalized);
    const pending = pendingId ? this.state.pendingFor(pendingId) : null;

    if (known && known.entry.localHash === localHash && known.entry.kind === "file" && !pending) {
      return;
    }
    if (
      pending &&
      !pending.deleted &&
      pending.localHash === localHash &&
      pathKey(pending.path) === pathKey(normalized)
    ) {
      return;
    }

    let fileId = known?.fileId ?? pending?.fileId ?? null;
    if (!fileId) {
      if (this.options.e2ee && !this.state.state.initialized) {
        fileId = await this.requireCrypto().fileIdForPath(normalized);
      } else {
        fileId = randomId();
      }
    }

    const prepared = await this.prepareContent(fileId, content);
    this.state.enqueue({
      fileId,
      path: normalized,
      kind: "file",
      deleted: false,
      encrypted: this.options.e2ee,
      hash: prepared.hash,
      localHash: prepared.localHash,
      nonce: prepared.nonce,
      size: content.byteLength,
      mtime: stat.mtime,
      ctime: stat.ctime,
      expectedRevision: known?.entry.revision ?? pending?.expectedRevision ?? null,
      movedFrom: pending?.movedFrom ?? null,
    });
    if (notifyChange) this.scheduleSync(400);
  }

  private async enqueueFolderUpsert(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (this.options.isExcluded(normalized)) return;
    const known = this.state.entryAt(normalized);
    const pendingId = this.state.pendingIdAt(normalized);
    const pending = pendingId ? this.state.pendingFor(pendingId) : null;
    if (known?.entry.kind === "folder" && !pending) return;
    if (pending && !pending.deleted) return;
    const fileId = known?.fileId ?? pending?.fileId ?? randomId();
    const stat = await this.adapter.stat(normalized);
    this.state.enqueue({
      fileId,
      path: normalized,
      kind: "folder",
      deleted: false,
      encrypted: this.options.e2ee,
      hash: null,
      localHash: null,
      nonce: null,
      size: 0,
      mtime: stat?.mtime ?? Date.now(),
      ctime: stat?.ctime ?? Date.now(),
      expectedRevision: known?.entry.revision ?? null,
    });
    this.scheduleSync(400);
  }

  private async queueDeleteAt(path: string): Promise<boolean> {
    const normalized = normalizeVaultPath(path);
    const known = this.state.entryAt(normalized);
    const pendingId = this.state.pendingIdAt(normalized);
    const pending = pendingId ? this.state.pendingFor(pendingId) : null;
    if (!known && !pending) return false;
    if (!known && pending) {
      this.state.removePending(pending.fileId);
      return true;
    }
    if (!known) return false;
    if (known.entry.kind === "folder") return this.queueDeleteTree(normalized);
    this.state.enqueue({
      fileId: known.fileId,
      path: known.entry.path,
      kind: known.entry.kind,
      deleted: true,
      encrypted: this.options.e2ee,
      hash: null,
      localHash: null,
      nonce: null,
      size: 0,
      mtime: known.entry.mtime,
      ctime: known.entry.ctime,
      expectedRevision: known.entry.revision,
    });
    return true;
  }

  private async queueDeleteTree(path: string): Promise<boolean> {
    const normalized = normalizeVaultPath(path);
    let queued = false;
    const pending = this.state
      .pendingEntries()
      .filter((entry) => isSubPath(entry.path, normalized));
    for (const entry of pending) {
      if (!this.state.state.files[entry.fileId]) {
        this.state.removePending(entry.fileId);
        queued = true;
      }
    }
    const entries = this.state.filesUnder(normalized);
    for (const { fileId, entry } of entries) {
      this.state.enqueue({
        fileId,
        path: entry.path,
        kind: entry.kind,
        deleted: true,
        encrypted: this.options.e2ee,
        hash: null,
        localHash: null,
        nonce: null,
        size: 0,
        mtime: entry.mtime,
        ctime: entry.ctime,
        expectedRevision: entry.revision,
      });
      queued = true;
    }
    return queued;
  }

  handleCreateOrModify(path: string): void {
    if (!this.started || this.applying > 0) return;
    const normalized = normalizeVaultPath(path);
    if (!normalized || this.isSuppressed(normalized)) return;
    if (this.options.isExcluded(normalized)) return;
    this.touchedPaths.set(pathKey(normalized), { path: normalized, action: "upsert" });
    this.scheduleLocalFlush();
  }

  handleDelete(path: string): void {
    if (!this.started || this.applying > 0) return;
    const normalized = normalizeVaultPath(path);
    if (!normalized || this.isSuppressed(normalized)) return;
    if (this.options.isExcluded(normalized)) return;
    this.touchedPaths.set(pathKey(normalized), { path: normalized, action: "delete" });
    this.scheduleLocalFlush();
  }

  handleRename(path: string, oldPath: string): void {
    if (!this.started || this.applying > 0) return;
    const normalized = normalizeVaultPath(path);
    const previous = normalizeVaultPath(oldPath);
    if (!normalized || !previous || normalized === previous) return;
    if (this.isSuppressed(normalized) || this.isSuppressed(previous)) return;

    const oldExcluded = this.options.isExcluded(previous);
    const newExcluded = this.options.isExcluded(normalized);
    if (oldExcluded && newExcluded) return;
    if (oldExcluded && !newExcluded) {
      void this.queueLocalTree(normalized);
      return;
    }
    if (!oldExcluded && newExcluded) {
      void this.queueDeleteTree(previous);
      this.touchedPaths.delete(pathKey(previous));
      return;
    }

    void this.applyLocalRename(previous, normalized);
  }

  private async queueLocalTree(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (this.options.isExcluded(normalized)) return;
    const stat = await this.adapter.stat(normalized);
    if (stat?.type === "folder") {
      await this.enqueueFolderUpsert(normalized);
      const files = this.app.vault.getFiles().filter((file) => isSubPath(file.path, normalized));
      for (const file of files) await this.enqueueUpsertFromDisk(file.path, false);
      const folders = this.app.vault
        .getAllLoadedFiles()
        .filter((item): item is TFolder => item instanceof TFolder)
        .filter((folder) => isSubPath(folder.path, normalized));
      for (const folder of folders) await this.enqueueFolderUpsert(folder.path);
    } else {
      await this.enqueueUpsertFromDisk(normalized, false);
    }
    this.scheduleSync(400);
  }

  private async applyLocalRename(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(newPath);
    if (file instanceof TFolder) {
      const affected = this.state.filesUnder(oldPath);
      for (const { fileId, entry } of affected) {
        const nextPath = replacePathPrefix(entry.path, oldPath, newPath);
        this.state.setFile(fileId, { ...entry, path: nextPath });
        const stat = await this.adapter.stat(nextPath);
        this.state.enqueue({
          fileId,
          path: nextPath,
          kind: entry.kind,
          deleted: false,
          encrypted: this.options.e2ee,
          hash: entry.hash,
          localHash: entry.localHash,
          nonce: null,
          size: 0,
          mtime: stat?.mtime ?? entry.mtime,
          ctime: stat?.ctime ?? entry.ctime,
          expectedRevision: entry.revision,
          movedFrom: oldPath,
        });
      }

      const untrackedPending = this.state
        .pendingEntries()
        .filter(
          (entry) =>
            isSubPath(entry.path, oldPath) && this.state.state.files[entry.fileId] === undefined,
        );
      for (const entry of untrackedPending) {
        const nextPath = replacePathPrefix(entry.path, oldPath, newPath);
        this.state.updatePending(entry.fileId, { path: nextPath });
      }

      const folderEntry = this.state.entryAt(newPath);
      if (!folderEntry) await this.enqueueFolderUpsert(newPath);
      this.scheduleSync(400);
      return;
    }

    const known = this.state.entryAt(oldPath);
    const pendingId = this.state.pendingIdAt(oldPath);
    const pending = pendingId ? this.state.pendingFor(pendingId) : null;

    if (known) {
      this.state.setFile(known.fileId, { ...known.entry, path: newPath });
      const stat = await this.adapter.stat(newPath);
      this.state.enqueue({
        fileId: known.fileId,
        path: newPath,
        kind: known.entry.kind,
        deleted: false,
        encrypted: this.options.e2ee,
        hash: known.entry.hash,
        localHash: known.entry.localHash,
        nonce: null,
        size: 0,
        mtime: stat?.mtime ?? known.entry.mtime,
        ctime: stat?.ctime ?? known.entry.ctime,
        expectedRevision: known.entry.revision,
        movedFrom: oldPath,
      });
      this.touchedPaths.delete(pathKey(oldPath));
      this.scheduleSync(400);
      return;
    }

    if (pending) {
      this.state.updatePending(pending.fileId, { path: newPath });
      this.touchedPaths.delete(pathKey(oldPath));
      this.scheduleSync(400);
      return;
    }

    await this.enqueueUpsertFromDisk(newPath, false);
    this.scheduleSync(400);
  }

  private scheduleLocalFlush(): void {
    if (this.localTimer !== null) window.clearTimeout(this.localTimer);
    this.localTimer = window.setTimeout(() => {
      this.localTimer = null;
      void this.flushLocalChanges().catch(() => undefined);
    }, 350);
  }

  private async flushLocalChanges(): Promise<void> {
    if (!this.started) return;
    if (this.applying > 0) {
      this.scheduleLocalFlush();
      return;
    }
    const items = [...this.touchedPaths.values()];
    this.touchedPaths.clear();
    if (items.length === 0) return;

    let enqueued = false;
    await runWithConcurrency(items, 4, async (item) => {
      try {
        const stat = await this.adapter.stat(item.path);
        if (item.action === "upsert" && stat) {
          if (stat.type === "folder") {
            await this.enqueueFolderUpsert(item.path);
          } else {
            await this.enqueueUpsertFromDisk(item.path, false);
          }
          enqueued = true;
          return;
        }
        if (item.action === "upsert" && !stat) {
          if (await this.queueDeleteAt(item.path)) enqueued = true;
          return;
        }
        if (item.action === "delete" && !stat) {
          if (await this.queueDeleteAt(item.path)) enqueued = true;
          return;
        }
        if (item.action === "delete" && stat) {
          if (stat.type === "folder") {
            await this.enqueueFolderUpsert(item.path);
          } else {
            await this.enqueueUpsertFromDisk(item.path, false);
          }
          enqueued = true;
        }
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("ENOENT"))) {
          this.options.notify(
            `Syncy could not read "${item.path}": ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    });

    await this.state.flush();
    if (enqueued) this.scheduleSync(300);
  }

  private async markPendingFailure(entry: PendingChange, message: string): Promise<void> {
    const attempts = entry.attempts + 1;
    this.state.updatePending(entry.fileId, {
      attempts,
      notBefore: Date.now() + Math.min(5 * 60 * 1000, 1000 * 2 ** attempts),
      reason: message,
    });
    if (entry.reason !== message) {
      this.options.notify(`Syncy could not sync "${entry.path}": ${message}`);
    }
  }

  private async markTooLarge(entry: PendingChange, size: number): Promise<void> {
    if (this.tooLarge.has(entry.fileId)) return;
    this.tooLarge.add(entry.fileId);
    this.state.updatePending(entry.fileId, {
      attempts: entry.attempts + 1,
      notBefore: Date.now() + TOO_LARGE_RETRY_MS,
      reason: "too_large",
    });
    this.options.notify(
      `"${entry.path}" is ${Math.ceil(size / (1024 * 1024))} MiB, larger than the server limit.`,
    );
  }

  private async readLocalFile(path: string): Promise<ArrayBuffer | null> {
    const stat = await this.adapter.stat(path);
    if (stat?.type !== "file") return null;
    return this.adapter.readBinary(path);
  }

  private async writeLocalFile(path: string, content: ArrayBuffer): Promise<void> {
    this.applying += 1;
    const normalized = normalizeVaultPath(path);
    try {
      await this.ensureFolder(parentPath(normalized));
      const temp = `${parentPath(normalized) ? `${parentPath(normalized)}/` : ""}.syncy-tmp-${randomId()}`;
      await this.adapter.writeBinary(temp, content);
      const existing = await this.adapter.stat(normalized);
      if (existing?.type === "file") await this.adapter.remove(normalized);
      if (existing?.type === "folder") {
        throw new SyncPausedError(`Cannot replace folder with file: ${normalized}`);
      }
      await this.adapter.rename(temp, normalized);
      this.suppress(normalized);
    } finally {
      this.applying -= 1;
    }
  }

  private async moveLocalPath(oldPath: string, newPath: string): Promise<void> {
    if (pathKey(oldPath) === pathKey(newPath)) return;
    const stat = await this.adapter.stat(oldPath);
    if (!stat) return;
    this.applying += 1;
    try {
      await this.ensureFolder(parentPath(newPath));
      const destination = await this.adapter.stat(newPath);
      if (destination?.type === "file") await this.adapter.remove(newPath);
      if (destination?.type === "folder") {
        await this.adapter.rmdir(newPath, false).catch(() => undefined);
      }
      await this.adapter.rename(oldPath, newPath);
      this.suppress(oldPath);
      this.suppress(newPath);
    } finally {
      this.applying -= 1;
    }
  }

  private async removeLocalPath(path: string, kind: "file" | "folder"): Promise<void> {
    const stat = await this.adapter.stat(path);
    if (!stat) return;
    this.applying += 1;
    try {
      if (stat.type === "file" || kind === "file") {
        await this.adapter.remove(path);
      } else {
        await this.adapter.rmdir(path, false).catch(() => undefined);
      }
      this.suppress(path);
    } finally {
      this.applying -= 1;
    }
  }

  private remapStateTree(oldPath: string, newPath: string): void {
    for (const { fileId, entry } of this.state.filesUnder(oldPath)) {
      if (entry.path === oldPath) continue;
      this.state.setFile(fileId, {
        ...entry,
        path: replacePathPrefix(entry.path, oldPath, newPath),
      });
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const normalized = normalizeVaultPath(path);
    if (!normalized) return;
    const stat = await this.adapter.stat(normalized);
    if (stat?.type === "folder") return;
    if (stat?.type === "file") {
      throw new SyncPausedError(`Expected a folder but found a file: ${normalized}`);
    }
    await this.ensureFolder(parentPath(normalized));
    await this.adapter.mkdir(normalized);
    this.suppress(normalized);
  }

  private async pickConflictPath(path: string): Promise<string> {
    return uniquePathAsync(conflictCopyPath(path), async (value) => {
      if (this.state.fileIdAt(value) || this.state.pendingIdAt(value)) return true;
      return this.adapter.exists(value);
    });
  }

  private notifyConflict(path: string): void {
    if (this.conflictNotices >= 5) return;
    this.conflictNotices += 1;
    this.options.notify(`Syncy kept a conflicting local copy as "${path}".`);
  }

  private suppress(path: string): void {
    this.suppressedUntil.set(pathKey(path), Date.now() + 2000);
  }

  private isSuppressed(path: string): boolean {
    const key = pathKey(path);
    const until = this.suppressedUntil.get(key);
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.suppressedUntil.delete(key);
      return false;
    }
    return true;
  }
}
