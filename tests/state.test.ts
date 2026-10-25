import type { DataAdapter } from "obsidian";
import { beforeAll, describe, expect, it } from "vitest";
import { SyncStateStore } from "../src/state";

class MemoryAdapter {
  private readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    if (this.files.has(path)) return true;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.files.keys()].some((value) => value.startsWith(prefix));
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async rename(path: string, nextPath: string): Promise<void> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    this.files.delete(path);
    this.files.set(nextPath, value);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    this.files.set(`${path}/.keep`, "");
  }

  snapshot(): Map<string, string> {
    return new Map(this.files);
  }
}

beforeAll(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});

describe("SyncStateStore", () => {
  it("tracks file ids and pending paths", async () => {
    const adapter = new MemoryAdapter();
    const store = await SyncStateStore.load(
      adapter as unknown as DataAdapter,
      ".obsidian/plugins/syncy",
      "vault-1",
    );
    store.setFile("id-1", {
      path: "Notes/Hello.md",
      kind: "file",
      revision: 3,
      hash: "hash",
      localHash: "local",
      mtime: 1,
      ctime: 1,
    });
    expect(store.fileIdAt("notes/hello.md")).toBe("id-1");

    store.enqueue({
      fileId: "id-1",
      path: "Notes/Renamed.md",
      kind: "file",
      deleted: false,
      encrypted: false,
      hash: "hash",
      localHash: "local",
      nonce: null,
      size: 3,
      mtime: 2,
      ctime: 2,
      expectedRevision: 3,
      movedFrom: "Notes/Hello.md",
    });

    expect(store.pendingIdAt("Notes/Renamed.md")).toBe("id-1");
    expect(store.pendingFor("id-1")?.movedFrom).toBe("Notes/Hello.md");
  });

  it("preserves expected revisions when coalescing changes", async () => {
    const adapter = new MemoryAdapter();
    const store = await SyncStateStore.load(
      adapter as unknown as DataAdapter,
      ".obsidian/plugins/syncy",
      "vault-1",
    );
    const base = {
      fileId: "id-1",
      path: "a.md",
      kind: "file" as const,
      deleted: false,
      encrypted: false,
      hash: "a",
      localHash: "a",
      nonce: null,
      size: 1,
      mtime: 1,
      ctime: 1,
    };
    store.enqueue({ ...base, expectedRevision: 9 });
    const second = store.enqueue({ ...base, path: "b.md", expectedRevision: 2 });
    expect(second.expectedRevision).toBe(9);
    expect(second.seq).toBe(2);
  });

  it("persists and reloads state", async () => {
    const adapter = new MemoryAdapter();
    const store = await SyncStateStore.load(
      adapter as unknown as DataAdapter,
      ".obsidian/plugins/syncy",
      "vault-1",
    );
    store.setFile("id-1", {
      path: "Notes/Hello.md",
      kind: "file",
      revision: 3,
      hash: "hash",
      localHash: "local",
      mtime: 1,
      ctime: 1,
    });
    store.setCursor(12);
    store.enqueue({
      fileId: "id-2",
      path: "Notes/New.md",
      kind: "file",
      deleted: false,
      encrypted: true,
      hash: "hash2",
      localHash: "local2",
      nonce: "nonce",
      size: 4,
      mtime: 3,
      ctime: 3,
      expectedRevision: null,
      movedFrom: null,
    });
    await store.flush();

    const reloaded = await SyncStateStore.load(
      adapter as unknown as DataAdapter,
      ".obsidian/plugins/syncy",
      "vault-1",
    );
    expect(reloaded.state.cursor).toBe(12);
    expect(reloaded.fileIdAt("Notes/Hello.md")).toBe("id-1");
    expect(reloaded.pendingIdAt("Notes/New.md")).toBe("id-2");
    expect(reloaded.pendingFor("id-2")?.nonce).toBe("nonce");
  });

  it("removes pending changes without touching newer sequences", async () => {
    const adapter = new MemoryAdapter();
    const store = await SyncStateStore.load(
      adapter as unknown as DataAdapter,
      ".obsidian/plugins/syncy",
      "vault-1",
    );
    const change = store.enqueue({
      fileId: "id-1",
      path: "a.md",
      kind: "file",
      deleted: false,
      encrypted: false,
      hash: "a",
      localHash: "a",
      nonce: null,
      size: 1,
      mtime: 1,
      ctime: 1,
      expectedRevision: null,
    });
    store.enqueue({
      fileId: "id-1",
      path: "a.md",
      kind: "file",
      deleted: false,
      encrypted: false,
      hash: "b",
      localHash: "b",
      nonce: null,
      size: 1,
      mtime: 1,
      ctime: 1,
      expectedRevision: null,
    });
    store.removePending("id-1", change.seq);
    expect(store.pendingFor("id-1")).not.toBeNull();
    store.removePending("id-1");
    expect(store.pendingFor("id-1")).toBeNull();
  });
});
