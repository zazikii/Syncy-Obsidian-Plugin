import type { DataAdapter } from "obsidian";
import { normalizeVaultPath, pathKey } from "./util/path";

export interface SyncFileEntry {
  path: string;
  kind: "file" | "folder";
  revision: number;
  hash: string | null;
  localHash: string | null;
  mtime: number;
  ctime: number;
}

export interface PendingChange {
  fileId: string;
  path: string;
  kind: "file" | "folder";
  deleted: boolean;
  encrypted: boolean;
  hash: string | null;
  localHash: string | null;
  nonce: string | null;
  size: number;
  mtime: number;
  ctime: number;
  expectedRevision: number | null;
  seq: number;
  attempts: number;
  notBefore: number | null;
  reason: string | null;
  movedFrom: string | null;
}

export interface VaultSyncState {
  version: 1;
  vaultId: string;
  cursor: number;
  initialized: boolean;
  files: Record<string, SyncFileEntry>;
  pending: Record<string, PendingChange>;
  uploadedHashes: Record<string, number>;
  lastSyncAt: number | null;
  lastError: string | null;
  lastFullSyncAt: number | null;
}

const STATE_VERSION = 1;
const MAX_UPLOADED_HASHES = 5000;

function emptyState(vaultId: string): VaultSyncState {
  return {
    version: STATE_VERSION,
    vaultId,
    cursor: 0,
    initialized: false,
    files: {},
    pending: {},
    uploadedHashes: {},
    lastSyncAt: null,
    lastError: null,
    lastFullSyncAt: null,
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function normalizeLoadedState(raw: unknown, vaultId: string): VaultSyncState {
  if (typeof raw !== "object" || raw === null) return emptyState(vaultId);
  const value = raw as Partial<VaultSyncState>;
  if (value.version !== STATE_VERSION) return emptyState(vaultId);

  const state = emptyState(vaultId);
  state.cursor = typeof value.cursor === "number" && value.cursor >= 0 ? value.cursor : 0;
  state.initialized = value.initialized === true;
  state.lastSyncAt = typeof value.lastSyncAt === "number" ? value.lastSyncAt : null;
  state.lastError = typeof value.lastError === "string" ? value.lastError : null;
  state.lastFullSyncAt = typeof value.lastFullSyncAt === "number" ? value.lastFullSyncAt : null;

  if (typeof value.files === "object" && value.files !== null) {
    for (const [fileId, entry] of Object.entries(value.files)) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Partial<SyncFileEntry>;
      if (typeof candidate.path !== "string" || !candidate.path) continue;
      if (candidate.kind !== "file" && candidate.kind !== "folder") continue;
      state.files[fileId] = {
        path: normalizeVaultPath(candidate.path),
        kind: candidate.kind,
        revision: typeof candidate.revision === "number" ? candidate.revision : 0,
        hash: typeof candidate.hash === "string" ? candidate.hash : null,
        localHash: typeof candidate.localHash === "string" ? candidate.localHash : null,
        mtime: typeof candidate.mtime === "number" ? candidate.mtime : 0,
        ctime: typeof candidate.ctime === "number" ? candidate.ctime : 0,
      };
    }
  }

  if (typeof value.pending === "object" && value.pending !== null) {
    for (const [fileId, entry] of Object.entries(value.pending)) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Partial<PendingChange>;
      if (typeof candidate.path !== "string" || !candidate.path) continue;
      if (candidate.kind !== "file" && candidate.kind !== "folder") continue;
      state.pending[fileId] = {
        fileId,
        path: normalizeVaultPath(candidate.path),
        kind: candidate.kind,
        deleted: candidate.deleted === true,
        encrypted: candidate.encrypted === true,
        hash: typeof candidate.hash === "string" ? candidate.hash : null,
        localHash: typeof candidate.localHash === "string" ? candidate.localHash : null,
        nonce: typeof candidate.nonce === "string" ? candidate.nonce : null,
        size: typeof candidate.size === "number" ? candidate.size : 0,
        mtime: typeof candidate.mtime === "number" ? candidate.mtime : 0,
        ctime: typeof candidate.ctime === "number" ? candidate.ctime : 0,
        expectedRevision:
          typeof candidate.expectedRevision === "number" ? candidate.expectedRevision : null,
        seq: typeof candidate.seq === "number" ? candidate.seq : 0,
        attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0,
        notBefore: typeof candidate.notBefore === "number" ? candidate.notBefore : null,
        reason: typeof candidate.reason === "string" ? candidate.reason : null,
        movedFrom: typeof candidate.movedFrom === "string" ? candidate.movedFrom : null,
      };
    }
  }

  if (typeof value.uploadedHashes === "object" && value.uploadedHashes !== null) {
    for (const [hash, timestamp] of Object.entries(value.uploadedHashes)) {
      if (typeof timestamp === "number") state.uploadedHashes[hash] = timestamp;
    }
  }

  return state;
}

function pruneUploadedHashes(state: VaultSyncState): void {
  const entries = Object.entries(state.uploadedHashes);
  if (entries.length <= MAX_UPLOADED_HASHES) return;
  entries.sort((left, right) => right[1] - left[1]);
  state.uploadedHashes = Object.fromEntries(entries.slice(0, Math.floor(MAX_UPLOADED_HASHES / 2)));
}

export class SyncStateStore {
  readonly state: VaultSyncState;
  private readonly adapter: DataAdapter;
  private readonly filePath: string;
  private readonly tempPath: string;
  private readonly pathToFileId = new Map<string, string>();
  private readonly pathToPendingId = new Map<string, string>();
  private saveTimer: number | null = null;
  private savePromise: Promise<void> | null = null;
  private dirty = false;

  private constructor(adapter: DataAdapter, filePath: string, state: VaultSyncState) {
    this.adapter = adapter;
    this.filePath = filePath;
    this.tempPath = `${filePath}.tmp`;
    this.state = state;
    this.rebuildIndex();
  }

  static async load(
    adapter: DataAdapter,
    directory: string,
    vaultId: string,
  ): Promise<SyncStateStore> {
    const filePath = `${directory}/sync-state/${sanitizeFileName(vaultId)}.json`;
    let raw: unknown = null;
    if (await adapter.exists(filePath)) {
      try {
        raw = JSON.parse(await adapter.read(filePath));
      } catch {
        raw = null;
      }
    }
    return new SyncStateStore(adapter, filePath, normalizeLoadedState(raw, vaultId));
  }

  private rebuildIndex(): void {
    this.pathToFileId.clear();
    this.pathToPendingId.clear();
    for (const [fileId, entry] of Object.entries(this.state.files)) {
      this.pathToFileId.set(pathKey(entry.path), fileId);
    }
    for (const [fileId, entry] of Object.entries(this.state.pending)) {
      this.pathToPendingId.set(pathKey(entry.path), fileId);
    }
  }

  fileIdAt(path: string): string | null {
    return this.pathToFileId.get(pathKey(normalizeVaultPath(path))) ?? null;
  }

  pendingIdAt(path: string): string | null {
    return this.pathToPendingId.get(pathKey(normalizeVaultPath(path))) ?? null;
  }

  entryAt(path: string): { fileId: string; entry: SyncFileEntry } | null {
    const fileId = this.fileIdAt(path);
    if (!fileId) return null;
    const entry = this.state.files[fileId];
    return entry ? { fileId, entry } : null;
  }

  setFile(fileId: string, entry: SyncFileEntry): void {
    const normalized: SyncFileEntry = { ...entry, path: normalizeVaultPath(entry.path) };
    const previous = this.state.files[fileId];
    if (previous) this.pathToFileId.delete(pathKey(previous.path));
    this.state.files[fileId] = normalized;
    this.pathToFileId.set(pathKey(normalized.path), fileId);
    this.markDirty();
  }

  removeFile(fileId: string): void {
    const previous = this.state.files[fileId];
    if (!previous) return;
    this.pathToFileId.delete(pathKey(previous.path));
    delete this.state.files[fileId];
    this.markDirty();
  }

  filesUnder(prefix: string): Array<{ fileId: string; entry: SyncFileEntry }> {
    const normalized = normalizeVaultPath(prefix);
    const result: Array<{ fileId: string; entry: SyncFileEntry }> = [];
    for (const [fileId, entry] of Object.entries(this.state.files)) {
      if (entry.path === normalized || entry.path.startsWith(`${normalized}/`)) {
        result.push({ fileId, entry });
      }
    }
    return result;
  }

  pendingFor(fileId: string): PendingChange | null {
    return this.state.pending[fileId] ?? null;
  }

  hasPending(fileId: string): boolean {
    return this.state.pending[fileId] !== undefined;
  }

  pendingAt(path: string): PendingChange | null {
    const fileId = this.fileIdAt(path);
    return fileId ? (this.state.pending[fileId] ?? null) : null;
  }

  pendingEntries(): PendingChange[] {
    return Object.values(this.state.pending);
  }

  enqueue(
    change: Omit<PendingChange, "seq" | "attempts" | "notBefore" | "reason" | "movedFrom"> & {
      movedFrom?: string | null;
    },
  ): PendingChange {
    const existing = this.state.pending[change.fileId];
    const entry: PendingChange = {
      ...change,
      expectedRevision:
        existing !== undefined ? existing.expectedRevision : (change.expectedRevision ?? null),
      seq: (existing?.seq ?? 0) + 1,
      attempts: 0,
      notBefore: null,
      reason: null,
      movedFrom: change.movedFrom ?? null,
    };
    if (existing) this.pathToPendingId.delete(pathKey(existing.path));
    this.state.pending[change.fileId] = entry;
    this.pathToPendingId.set(pathKey(entry.path), change.fileId);
    this.markDirty();
    return entry;
  }

  updatePending(fileId: string, update: Partial<PendingChange>): void {
    const existing = this.state.pending[fileId];
    if (!existing) return;
    if (update.path !== undefined && update.path !== existing.path) {
      this.pathToPendingId.delete(pathKey(existing.path));
      this.pathToPendingId.set(pathKey(update.path), fileId);
    }
    this.state.pending[fileId] = { ...existing, ...update };
    this.markDirty();
  }

  removePending(fileId: string, seq?: number): void {
    const existing = this.state.pending[fileId];
    if (!existing) return;
    if (seq !== undefined && existing.seq !== seq) return;
    this.pathToPendingId.delete(pathKey(existing.path));
    delete this.state.pending[fileId];
    this.markDirty();
  }

  clearPending(): void {
    if (Object.keys(this.state.pending).length === 0) return;
    this.state.pending = {};
    this.pathToPendingId.clear();
    this.markDirty();
  }

  hasUploaded(hash: string): boolean {
    return this.state.uploadedHashes[hash] !== undefined;
  }

  markUploaded(hash: string): void {
    this.state.uploadedHashes[hash] = Date.now();
    this.markDirty();
  }

  setCursor(cursor: number): void {
    if (this.state.cursor === cursor) return;
    this.state.cursor = cursor;
    this.markDirty();
  }

  touch(lastError: string | null): void {
    this.state.lastSyncAt = Date.now();
    this.state.lastError = lastError;
    this.markDirty();
  }

  reset(full: boolean): void {
    if (full) {
      this.state.cursor = 0;
      this.state.initialized = false;
      this.state.files = {};
      this.state.pending = {};
      this.state.uploadedHashes = {};
      this.state.lastFullSyncAt = Date.now();
      this.pathToFileId.clear();
      this.pathToPendingId.clear();
    }
    this.markDirty();
  }

  markDirty(): void {
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch(() => undefined);
    }, 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.savePromise) {
      await this.savePromise;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.savePromise = this.writeState()
      .catch((error: unknown) => {
        this.dirty = true;
        throw error;
      })
      .finally(() => {
        this.savePromise = null;
      });
    await this.savePromise;
  }

  private async writeState(): Promise<void> {
    pruneUploadedHashes(this.state);
    const serialized = JSON.stringify(this.state);
    const directory = this.filePath.slice(0, this.filePath.lastIndexOf("/"));
    if (!(await this.adapter.exists(directory))) {
      await this.adapter.mkdir(directory);
    }
    await this.adapter.write(this.tempPath, serialized);
    if (await this.adapter.exists(this.filePath)) {
      await this.adapter.remove(this.filePath);
    }
    await this.adapter.rename(this.tempPath, this.filePath);
  }

  async destroy(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.savePromise) await this.savePromise;
    if (await this.adapter.exists(this.filePath)) await this.adapter.remove(this.filePath);
    if (await this.adapter.exists(this.tempPath)) await this.adapter.remove(this.tempPath);
  }
}
