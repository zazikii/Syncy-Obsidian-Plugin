import { randomUUID } from "node:crypto";
import { promises as fs, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  class TFolder {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  return { TFolder };
});

vi.mock("obsidian", () => ({
  TFolder: mock.TFolder,
  requestUrl: async (request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  }) => {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      arrayBuffer,
      text,
      json,
    };
  },
}));

import { SyncyApi } from "../src/api";
import { generateVaultKey, VaultCrypto, wrapVaultKey } from "../src/crypto";
import { SyncStateStore } from "../src/state";
import { SyncEngine } from "../src/sync/engine";
import { buildExcludePatterns, compileExcludes } from "../src/util/glob";
import { sha256Hex } from "../src/util/hash";

const serverUrl = process.env.SYNCY_TEST_URL ?? "";
const email = process.env.SYNCY_TEST_EMAIL ?? "";
const password = process.env.SYNCY_TEST_PASSWORD ?? "";

const enabled = Boolean(serverUrl && email && password);

class FakeAdapter {
  constructor(private readonly root: string) {}

  private absolute(relative: string): string {
    return path.join(this.root, relative.replace(/\\/g, "/"));
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await fs.access(this.absolute(relative));
      return true;
    } catch {
      return false;
    }
  }

  async stat(
    relative: string,
  ): Promise<{ type: "file" | "folder"; size: number; mtime: number; ctime: number } | null> {
    try {
      const stat = await fs.stat(this.absolute(relative));
      return {
        type: stat.isDirectory() ? "folder" : "file",
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
      };
    } catch {
      return null;
    }
  }

  async read(relative: string): Promise<string> {
    return fs.readFile(this.absolute(relative), "utf8");
  }

  async readBinary(relative: string): Promise<ArrayBuffer> {
    const data = await fs.readFile(this.absolute(relative));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  async write(relative: string, data: string): Promise<void> {
    const absolute = this.absolute(relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data, "utf8");
  }

  async writeBinary(relative: string, data: ArrayBuffer): Promise<void> {
    const absolute = this.absolute(relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, Buffer.from(data));
  }

  async remove(relative: string): Promise<void> {
    await fs.unlink(this.absolute(relative));
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.absolute(to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(this.absolute(from), target);
  }

  async mkdir(relative: string): Promise<void> {
    await fs.mkdir(this.absolute(relative), { recursive: true });
  }

  async rmdir(relative: string, recursive: boolean): Promise<void> {
    await fs.rm(this.absolute(relative), { recursive, force: false });
  }
}

function walk(root: string, relative = ""): { files: string[]; folders: string[] } {
  const files: string[] = [];
  const folders: string[] = [];
  const directory = relative ? path.join(root, relative) : root;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      folders.push(entryPath);
      const nested = walk(root, entryPath);
      files.push(...nested.files);
      folders.push(...nested.folders);
    } else {
      files.push(entryPath);
    }
  }
  return { files, folders };
}

class FakeVault {
  readonly adapter: FakeAdapter;
  constructor(private readonly root: string) {
    this.adapter = new FakeAdapter(root);
  }

  getFiles(): Array<{ path: string }> {
    return walk(this.root).files.map((file) => ({ path: file }));
  }

  getAllLoadedFiles(): unknown[] {
    const { files, folders } = walk(this.root);
    return [
      ...folders.map((folder) => new mock.TFolder(folder)),
      ...files.map((file) => ({ path: file })),
    ];
  }

  getAbstractFileByPath(relative: string): unknown {
    try {
      const stat = statSync(path.join(this.root, relative));
      if (stat.isDirectory()) return new mock.TFolder(relative);
    } catch {
      return null;
    }
    return { path: relative };
  }
}

const tempRoots: string[] = [];

async function makeVault(): Promise<{ root: string; vault: FakeVault }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syncy-engine-"));
  tempRoots.push(root);
  return { root, vault: new FakeVault(root) };
}

function arrayBufferOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function waitForSync(engine: SyncEngine, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await engine.syncNow();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for sync state");
}

beforeAll(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});

afterAll(async () => {
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(!enabled)("sync engine against a live Syncy server", () => {
  it("imports local files, pushes edits, renames and deletes", async () => {
    const { root, vault } = await makeVault();
    const api = new SyncyApi(serverUrl, {
      saveSession: async () => undefined,
      clearSession: async () => undefined,
      onAuthLost: () => undefined,
    });
    await api.login(email, password, { name: "Engine Integration", platform: "node" });
    const serverVault = await api.createVault({
      name: `engine-${randomUUID().slice(0, 8)}`,
      e2ee: false,
    });

    await fs.mkdir(path.join(root, "Notes"), { recursive: true });
    await fs.mkdir(path.join(root, "Attachments"), { recursive: true });
    await fs.mkdir(path.join(root, "Empty"), { recursive: true });
    await fs.writeFile(path.join(root, "Notes", "Hello.md"), "hello world", "utf8");
    await fs.writeFile(
      path.join(root, "Attachments", "image.bin"),
      Buffer.from([0, 1, 2, 3, 4, 5, 250, 251]),
    );

    const state = await SyncStateStore.load(
      vault.adapter as never,
      ".obsidian/plugins/syncy",
      serverVault.id,
    );
    const excluded = compileExcludes(
      buildExcludePatterns({
        syncConfig: true,
        syncWorkspace: false,
        syncPluginData: false,
        extraPatterns: [],
      }),
    );
    const engine = new SyncEngine({
      app: { vault } as never,
      api,
      vaultId: serverVault.id,
      e2ee: false,
      vaultCrypto: null,
      state,
      intervalSeconds: 0,
      syncOnStartup: true,
      isExcluded: excluded,
      maxBlobBytes: () => 512 * 1024 * 1024,
      onStatus: () => undefined,
      notify: () => undefined,
      onAuthLost: () => undefined,
      onVaultUnavailable: () => undefined,
    });

    engine.start();
    await waitForSync(engine, async () => {
      const pending = Object.keys(state.state.pending).length;
      return state.state.initialized && pending === 0;
    });

    const files = await api.listFiles(serverVault.id, { limit: 100 });
    const paths = files.files.map((file) => file.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining(["Notes/Hello.md", "Attachments/image.bin", "Empty"]),
    );
    const empty = files.files.find((file) => file.path === "Empty");
    expect(empty?.kind).toBe("folder");

    await fs.writeFile(path.join(root, "Notes", "Hello.md"), "hello updated", "utf8");
    engine.handleCreateOrModify("Notes/Hello.md");
    await waitForSync(engine, async () => Object.keys(state.state.pending).length === 0);
    const afterEdit = await api.listFiles(serverVault.id, { limit: 100 });
    const hello = afterEdit.files.find((file) => file.path === "Notes/Hello.md")!;
    expect(hello.hash).toBe(await sha256Hex(Buffer.from("hello updated", "utf8")));

    await fs.rename(path.join(root, "Notes", "Hello.md"), path.join(root, "Notes", "Renamed.md"));
    engine.handleRename("Notes/Renamed.md", "Notes/Hello.md");
    await waitForSync(engine, async () => Object.keys(state.state.pending).length === 0);
    const afterRename = await api.listFiles(serverVault.id, { limit: 100 });
    expect(afterRename.files.some((file) => file.path === "Notes/Renamed.md")).toBe(true);
    expect(afterRename.files.some((file) => file.path === "Notes/Hello.md")).toBe(false);

    await fs.unlink(path.join(root, "Notes", "Renamed.md"));
    engine.handleDelete("Notes/Renamed.md");
    await waitForSync(engine, async () => Object.keys(state.state.pending).length === 0);
    const afterDelete = await api.listFiles(serverVault.id, { limit: 100 });
    expect(afterDelete.files.some((file) => file.path === "Notes/Renamed.md")).toBe(false);

    await engine.stopAndWait();
    await api.deleteVault(serverVault.id).catch(() => undefined);
  }, 120_000);

  it("pulls remote changes and resolves conflicts into a copy", async () => {
    const { root, vault } = await makeVault();
    const api = new SyncyApi(serverUrl, {
      saveSession: async () => undefined,
      clearSession: async () => undefined,
      onAuthLost: () => undefined,
    });
    await api.login(email, password, { name: "Engine Integration 2", platform: "node" });
    const serverVault = await api.createVault({
      name: `engine-${randomUUID().slice(0, 8)}`,
      e2ee: false,
    });

    await fs.writeFile(path.join(root, "Note.md"), "local base", "utf8");
    const state = await SyncStateStore.load(
      vault.adapter as never,
      ".obsidian/plugins/syncy",
      serverVault.id,
    );
    const engine = new SyncEngine({
      app: { vault } as never,
      api,
      vaultId: serverVault.id,
      e2ee: false,
      vaultCrypto: null,
      state,
      intervalSeconds: 0,
      syncOnStartup: true,
      isExcluded: compileExcludes(
        buildExcludePatterns({
          syncConfig: true,
          syncWorkspace: false,
          syncPluginData: false,
          extraPatterns: [],
        }),
      ),
      maxBlobBytes: () => 512 * 1024 * 1024,
      onStatus: () => undefined,
      notify: () => undefined,
      onAuthLost: () => undefined,
      onVaultUnavailable: () => undefined,
    });
    engine.start();
    await waitForSync(
      engine,
      async () => state.state.initialized && Object.keys(state.state.pending).length === 0,
    );

    const remoteContent = Buffer.from("remote change", "utf8");
    const remoteHash = await sha256Hex(remoteContent);
    await api.uploadBlob(serverVault.id, remoteHash, arrayBufferOf(remoteContent));
    const initialRemotePush = await api.pushChanges(
      serverVault.id,
      [
        {
          fileId: "remote-note",
          path: "Remote.md",
          kind: "file",
          hash: remoteHash,
          expectedRevision: null,
        },
      ],
      true,
    );
    const remoteRevision = initialRemotePush.results[0]!.revision!;
    await waitForSync(
      engine,
      async () =>
        (await fs.readFile(path.join(root, "Remote.md"), "utf8").catch(() => "")) ===
        "remote change",
    );
    expect(await fs.readFile(path.join(root, "Remote.md"), "utf8")).toBe("remote change");

    await fs.writeFile(path.join(root, "Remote.md"), "local edit", "utf8");
    engine.handleCreateOrModify("Remote.md");
    await engine.flushLocalPending();
    expect(Object.keys(state.state.pending)).toHaveLength(1);

    const otherContent = Buffer.from("server edit", "utf8");
    const otherHash = await sha256Hex(otherContent);
    await api.uploadBlob(serverVault.id, otherHash, arrayBufferOf(otherContent));
    const pushed = await api.pushChanges(
      serverVault.id,
      [
        {
          fileId: "remote-note",
          path: "Remote.md",
          kind: "file",
          hash: otherHash,
          expectedRevision: remoteRevision,
        },
      ],
      true,
    );
    expect(pushed.applied).toBe(true);
    await waitForSync(engine, async () => Object.keys(state.state.pending).length === 0);

    const files = await fs.readdir(root);
    const conflicts = files.filter((file) => file.includes("conflict"));
    expect(conflicts.length).toBe(1);
    expect(await fs.readFile(path.join(root, "Remote.md"), "utf8")).toBe("server edit");
    expect(await fs.readFile(path.join(root, conflicts[0]!), "utf8")).toBe("local edit");

    await engine.stopAndWait();
    await api.deleteVault(serverVault.id).catch(() => undefined);
  }, 120_000);

  it("applies local path swaps atomically", async () => {
    const { root, vault } = await makeVault();
    const api = new SyncyApi(serverUrl, {
      saveSession: async () => undefined,
      clearSession: async () => undefined,
      onAuthLost: () => undefined,
    });
    await api.login(email, password, { name: "Engine Integration Swap", platform: "node" });
    const serverVault = await api.createVault({
      name: `swap-${randomUUID().slice(0, 8)}`,
      e2ee: false,
    });

    await fs.writeFile(path.join(root, "A.md"), "content A", "utf8");
    await fs.writeFile(path.join(root, "B.md"), "content B", "utf8");
    const state = await SyncStateStore.load(
      vault.adapter as never,
      ".obsidian/plugins/syncy",
      serverVault.id,
    );
    const engine = new SyncEngine({
      app: { vault } as never,
      api,
      vaultId: serverVault.id,
      e2ee: false,
      vaultCrypto: null,
      state,
      intervalSeconds: 0,
      syncOnStartup: true,
      isExcluded: compileExcludes(
        buildExcludePatterns({
          syncConfig: true,
          syncWorkspace: false,
          syncPluginData: false,
          extraPatterns: [],
        }),
      ),
      maxBlobBytes: () => 512 * 1024 * 1024,
      onStatus: () => undefined,
      notify: () => undefined,
      onAuthLost: () => undefined,
      onVaultUnavailable: () => undefined,
    });
    engine.start();
    await waitForSync(
      engine,
      async () => state.state.initialized && Object.keys(state.state.pending).length === 0,
    );

    const pause = () => new Promise((resolve) => setTimeout(resolve, 75));
    await fs.rename(path.join(root, "A.md"), path.join(root, "SwapTemp.md"));
    engine.handleRename("SwapTemp.md", "A.md");
    await pause();
    await fs.rename(path.join(root, "B.md"), path.join(root, "A.md"));
    engine.handleRename("A.md", "B.md");
    await pause();
    await fs.rename(path.join(root, "SwapTemp.md"), path.join(root, "B.md"));
    engine.handleRename("B.md", "SwapTemp.md");
    await pause();
    await engine.flushLocalPending();
    await waitForSync(engine, async () => Object.keys(state.state.pending).length === 0);

    const files = await api.listFiles(serverVault.id, { limit: 100 });
    const a = files.files.find((file) => file.path === "A.md")!;
    const b = files.files.find((file) => file.path === "B.md")!;
    expect(a.hash).toBe(await sha256Hex(Buffer.from("content B", "utf8")));
    expect(b.hash).toBe(await sha256Hex(Buffer.from("content A", "utf8")));

    await engine.stopAndWait();
    await api.deleteVault(serverVault.id).catch(() => undefined);
  }, 120_000);

  it("recovers from a stale cursor and applies remote deletes and moves", async () => {
    const { root, vault } = await makeVault();
    const api = new SyncyApi(serverUrl, {
      saveSession: async () => undefined,
      clearSession: async () => undefined,
      onAuthLost: () => undefined,
    });
    await api.login(email, password, { name: "Engine Integration Resync", platform: "node" });
    const serverVault = await api.createVault({
      name: `resync-${randomUUID().slice(0, 8)}`,
      e2ee: false,
    });

    await fs.writeFile(path.join(root, "Base.md"), "base file", "utf8");
    const state = await SyncStateStore.load(
      vault.adapter as never,
      ".obsidian/plugins/syncy",
      serverVault.id,
    );
    const engine = new SyncEngine({
      app: { vault } as never,
      api,
      vaultId: serverVault.id,
      e2ee: false,
      vaultCrypto: null,
      state,
      intervalSeconds: 0,
      syncOnStartup: true,
      isExcluded: compileExcludes(
        buildExcludePatterns({
          syncConfig: true,
          syncWorkspace: false,
          syncPluginData: false,
          extraPatterns: [],
        }),
      ),
      maxBlobBytes: () => 512 * 1024 * 1024,
      onStatus: () => undefined,
      notify: () => undefined,
      onAuthLost: () => undefined,
      onVaultUnavailable: () => undefined,
    });
    engine.start();
    await waitForSync(
      engine,
      async () => state.state.initialized && Object.keys(state.state.pending).length === 0,
    );

    const remoteContent = Buffer.from("remote file", "utf8");
    const remoteHash = await sha256Hex(remoteContent);
    await api.uploadBlob(serverVault.id, remoteHash, arrayBufferOf(remoteContent));
    const remotePush = await api.pushChanges(
      serverVault.id,
      [
        {
          fileId: "remote-delete",
          path: "RemoteDelete.md",
          kind: "file",
          hash: remoteHash,
          expectedRevision: null,
        },
      ],
      true,
    );
    await waitForSync(engine, async () =>
      fs
        .stat(path.join(root, "RemoteDelete.md"))
        .then(() => true)
        .catch(() => false),
    );

    state.state.cursor = 9_999_999;
    await waitForSync(engine, async () => state.state.cursor > 0 && state.state.cursor < 9_999_999);
    expect(await fs.readFile(path.join(root, "RemoteDelete.md"), "utf8")).toBe("remote file");

    const files = await api.listFiles(serverVault.id, { limit: 100 });
    const base = files.files.find((file) => file.path === "Base.md")!;
    const remote = files.files.find((file) => file.path === "RemoteDelete.md")!;

    const moved = await api.pushChanges(
      serverVault.id,
      [
        {
          fileId: base.fileId,
          path: "RenamedBase.md",
          kind: "file",
          hash: base.hash,
          expectedRevision: base.revision,
        },
      ],
      true,
    );
    expect(moved.applied).toBe(true);
    await waitForSync(engine, async () =>
      fs
        .stat(path.join(root, "RenamedBase.md"))
        .then(() => true)
        .catch(() => false),
    );
    expect(await fs.readFile(path.join(root, "RenamedBase.md"), "utf8")).toBe("base file");
    expect(
      await fs
        .stat(path.join(root, "Base.md"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    const deleted = await api.pushChanges(
      serverVault.id,
      [
        {
          fileId: remote.fileId,
          path: remote.path,
          kind: "file",
          deleted: true,
          expectedRevision: remote.revision,
        },
      ],
      true,
    );
    expect(deleted.applied).toBe(true);
    await waitForSync(engine, async () =>
      fs
        .stat(path.join(root, "RemoteDelete.md"))
        .then(() => false)
        .catch(() => true),
    );
    expect(remotePush.applied).toBe(true);

    await engine.stopAndWait();
    await api.deleteVault(serverVault.id).catch(() => undefined);
  }, 120_000);

  it("syncs encrypted vaults without exposing plaintext paths", async () => {
    const { root, vault } = await makeVault();
    const api = new SyncyApi(serverUrl, {
      saveSession: async () => undefined,
      clearSession: async () => undefined,
      onAuthLost: () => undefined,
    });
    await api.login(email, password, { name: "Engine Integration E2EE", platform: "node" });
    const key = generateVaultKey();
    const crypto = await VaultCrypto.fromKey(key);
    const envelope = await wrapVaultKey(key, "integration-passphrase");
    const serverVault = await api.createVault({
      name: `e2ee-${randomUUID().slice(0, 8)}`,
      e2ee: true,
      keyEnvelope: envelope,
    });

    await fs.writeFile(path.join(root, "Secret.md"), "top secret note", "utf8");
    const state = await SyncStateStore.load(
      vault.adapter as never,
      ".obsidian/plugins/syncy",
      serverVault.id,
    );
    const engine = new SyncEngine({
      app: { vault } as never,
      api,
      vaultId: serverVault.id,
      e2ee: true,
      vaultCrypto: crypto,
      state,
      intervalSeconds: 0,
      syncOnStartup: true,
      isExcluded: compileExcludes(
        buildExcludePatterns({
          syncConfig: true,
          syncWorkspace: false,
          syncPluginData: false,
          extraPatterns: [],
        }),
      ),
      maxBlobBytes: () => 512 * 1024 * 1024,
      onStatus: () => undefined,
      notify: () => undefined,
      onAuthLost: () => undefined,
      onVaultUnavailable: () => undefined,
    });
    engine.start();
    await waitForSync(
      engine,
      async () => state.state.initialized && Object.keys(state.state.pending).length === 0,
    );

    const files = await api.listFiles(serverVault.id, { limit: 100 });
    expect(files.files).toHaveLength(1);
    expect(files.files[0]!.path.startsWith("s1.")).toBe(true);
    expect(files.files[0]!.path).not.toContain("Secret");
    expect(files.files[0]!.encrypted).toBe(true);

    const encrypted = await api.downloadBlob(serverVault.id, files.files[0]!.hash!);
    expect(new TextDecoder().decode(encrypted)).not.toContain("top secret");
    const decrypted = await crypto.decryptContent(encrypted, files.files[0]!.fileId);
    expect(new TextDecoder().decode(decrypted)).toBe("top secret note");

    await fs.unlink(path.join(root, "Secret.md"));
    await fs.writeFile(path.join(root, "Second.md"), "second secret", "utf8");
    engine.handleDelete("Secret.md");
    engine.handleCreateOrModify("Second.md");
    await waitForSync(engine, async () => Object.keys(state.state.pending).length === 0);
    expect(await fs.readFile(path.join(root, "Second.md"), "utf8")).toBe("second secret");
    const after = await api.listFiles(serverVault.id, { limit: 100 });
    expect(after.files).toHaveLength(1);

    await engine.stopAndWait();
    await api.deleteVault(serverVault.id).catch(() => undefined);
  }, 120_000);
});
