import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage, extractAll } from "@electron/asar";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncy-e2e-"));
const vaultName = "Syncy E2E Vault";
const vaultPath = path.join(tempRoot, vaultName);
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "syncy");
const appName = `obsidian-syncy-e2e-${Date.now().toString(36)}`;
const userDataPath = path.join(process.env.APPDATA ?? os.homedir(), appName);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keep = process.env.SYNCY_E2E_KEEP === "1";
const externalServerUrl = (process.env.SYNCY_TEST_URL ?? "").replace(/\/+$/, "");
const email = process.env.SYNCY_TEST_EMAIL ?? "e2e@example.com";
const password = process.env.SYNCY_TEST_PASSWORD ?? "e2e-password-123";

let obsidianProcess = null;
let serverProcess = null;
let cdp = null;
let token = "";
let serverUrl = externalServerUrl;
let createdVaultId = "";
let passed = false;

function log(message) {
  console.log(`[e2e] ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function killTree(processId) {
  if (!processId) return;
  spawnSync("taskkill", ["/PID", String(processId), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, label, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, headers: response.headers };
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function listFiles() {
  const response = await api(`/v1/vaults/${createdVaultId}/files?limit=1000`, {
    headers: authHeaders(),
  });
  if (response.status !== 200) throw new Error(`list files failed: ${response.text}`);
  return response.json.files;
}

async function findFile(filePath) {
  return (await listFiles()).find((file) => file.path === filePath);
}

async function pushFile(filePath, content, fileId = randomUUID()) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const hash = sha256(bytes);
  const upload = await api(`/v1/vaults/${createdVaultId}/blobs/${hash}`, {
    method: "PUT",
    headers: authHeaders({ "content-type": "application/octet-stream" }),
    body: bytes,
  });
  if (upload.status !== 200 && upload.status !== 201) {
    throw new Error(`blob upload failed: ${upload.text}`);
  }
  const push = await api(`/v1/vaults/${createdVaultId}/changes`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      atomic: true,
      changes: [
        {
          fileId,
          path: filePath,
          kind: "file",
          hash,
          expectedRevision: null,
        },
      ],
    }),
  });
  if (push.status !== 200 || !push.json?.applied) {
    throw new Error(`remote push failed: ${push.text}`);
  }
  return push.json.results[0];
}

async function startLocalServer() {
  if (externalServerUrl) {
    serverUrl = externalServerUrl;
    log(`using external server ${serverUrl}`);
    return;
  }

  const serverDir = process.env.SYNCY_SERVER_DIR ?? path.resolve(repoRoot, "..", "Syncy");
  const entry = path.join(serverDir, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Syncy server build not found at ${entry}. Build the server or set SYNCY_SERVER_DIR.`,
    );
  }

  const serverPort = await freePort();
  serverUrl = `http://127.0.0.1:${serverPort}`;
  const dataDir = path.join(tempRoot, "server-data");
  const stdout = fs.openSync(path.join(tempRoot, "server.stdout.log"), "w");
  const stderr = fs.openSync(path.join(tempRoot, "server.stderr.log"), "w");
  serverProcess = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env: {
      ...process.env,
      SYNCY_EMAIL: email,
      SYNCY_PASSWORD: password,
      SYNCY_NAME: "Syncy E2E",
      HOST: "127.0.0.1",
      PORT: String(serverPort),
      DATA_DIR: dataDir,
      PUBLIC_URL: serverUrl,
      LOG_LEVEL: "warn",
      RATE_LIMIT_MAX: "100000",
      UPDATE_DISABLED: "true",
    },
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });

  await waitFor(
    async () => {
      try {
        const response = await fetch(`${serverUrl}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    },
    "Syncy server startup",
    30_000,
  );
  log(`temporary server ready on ${serverUrl}`);
}

async function prepareVault() {
  fs.mkdirSync(pluginPath, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(pluginPath, file));
  }
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Syncy E2E Vault\n", "utf8");
}

async function prepareObsidianInstall() {
  const sourceExe =
    process.env.SYNCY_E2E_OBSIDIAN ??
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe");
  if (!fs.existsSync(sourceExe)) {
    throw new Error(`Obsidian not found at ${sourceExe}. Set SYNCY_E2E_OBSIDIAN to Obsidian.exe.`);
  }

  const sourceInstall = path.dirname(sourceExe);
  const installPath = path.join(tempRoot, "obsidian");
  fs.cpSync(sourceInstall, installPath, { recursive: true });
  log("copied Obsidian installation");

  const appAsar = path.join(installPath, "resources", "app.asar");
  const extracted = path.join(tempRoot, "app-asar");
  extractAll(appAsar, extracted);
  const packageFile = path.join(extracted, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  packageJson.name = appName;
  packageJson.productName = appName;
  fs.writeFileSync(packageFile, JSON.stringify(packageJson, null, 2), "utf8");
  fs.rmSync(appAsar, { force: true });
  await createPackage(extracted, appAsar);
  fs.rmSync(extracted, { recursive: true, force: true });
  log("patched isolated Obsidian identity");

  fs.rmSync(userDataPath, { recursive: true, force: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, "obsidian.json"),
    JSON.stringify(
      {
        updateDisabled: true,
        disableGpu: true,
        vaults: {
          [randomUUID()]: { path: vaultPath, ts: Date.now(), open: true },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    installPath,
    exe: path.join(installPath, "Obsidian.exe"),
    cdpPort: await freePort(),
  };
}

async function launchObsidian(install) {
  obsidianProcess = spawn(
    install.exe,
    [`--remote-debugging-port=${install.cdpPort}`, "--disable-gpu", "--no-first-run"],
    {
      cwd: install.installPath,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  log(`launched isolated Obsidian (pid ${obsidianProcess.pid})`);

  const target = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${install.cdpPort}/json/list`);
        const targets = await response.json();
        return targets.find(
          (item) => item.type === "page" && item.url.startsWith("app://obsidian.md"),
        );
      } catch {
        return false;
      }
    },
    "Obsidian DevTools endpoint",
    90_000,
    500,
  );

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.evaluate("document.title");
  log(`attached to ${target.title}`);

  await waitFor(
    async () => {
      const value = await cdp.evaluate("app?.vault?.getName?.()");
      return value === vaultName;
    },
    "test vault load",
    60_000,
    500,
  );

  const isolation = await cdp.evaluate(
    "({ appPath: window.electron?.remote?.app?.getAppPath?.(), userData: window.electron?.remote?.app?.getPath?.('userData') })",
  );
  if (!isolation?.appPath?.startsWith(install.installPath)) {
    throw new Error(`Obsidian is not running from the temporary copy: ${isolation?.appPath}`);
  }
  if (path.resolve(isolation.userData) !== path.resolve(userDataPath)) {
    throw new Error(`Obsidian is not using isolated user data: ${isolation.userData}`);
  }
  log("verified isolated app path and user data");
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
        return;
      }
      if (message.result?.exceptionDetails) {
        pending.reject(
          new Error(
            message.result.exceptionDetails.exception?.description ??
              message.result.exceptionDetails.text ??
              "CDP evaluation failed",
          ),
        );
        return;
      }
      pending.resolve(message.result?.result?.value);
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP WebSocket failed"));
    });
  }

  evaluate(expression) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
          },
        }),
      );
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore close failures.
    }
    this.ws = null;
  }
}

async function enablePlugin() {
  const enabled = await cdp.evaluate(`(async () => {
    localStorage.setItem("enable-plugin-" + app.appId, "true");
    await app.plugins.loadManifests();
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.enabledPlugins.has("syncy")) {
      app.plugins.enabledPlugins.add("syncy");
      await app.plugins.saveConfig();
    }
    try {
      await app.plugins.enablePluginAndSave("syncy");
    } catch (error) {
      if (!app.plugins.plugins.syncy) throw error;
    }
    return Boolean(app.plugins.plugins.syncy);
  })()`);
  if (!enabled) throw new Error("Syncy plugin did not load inside Obsidian");
  log("Syncy plugin loaded inside Obsidian");
}

async function setupPlugin() {
  const result = await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    await plugin.updateSettings({ serverUrl: ${JSON.stringify(serverUrl)} });
    await plugin.connect(${JSON.stringify(email)}, ${JSON.stringify(password)});
    await plugin.linkVault(${JSON.stringify(createdVaultId)});
    return {
      linked: plugin.data.settings.vaultId,
      engine: Boolean(plugin.engine),
      realtime: Boolean(plugin.realtime),
    };
  })()`);
  if (!result?.engine) throw new Error("Syncy sync engine did not start");
  log(`plugin linked vault ${result.linked}`);
}

async function syncPlugin() {
  return cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    if (!plugin.engine) return { status: "missing" };
    await plugin.engine.syncNow();
    const status = plugin.engine.getStatus();
    const state = plugin.engine.getState().state;
    return {
      status: status.phase,
      message: status.message,
      pending: Object.keys(state.pending).length,
      cursor: state.cursor,
      files: Object.keys(state.files).length,
      error: state.lastError,
    };
  })()`);
}

async function waitForSync(label = "plugin sync") {
  const result = await waitFor(
    async () => {
      const state = await syncPlugin();
      if (state.status === "synced" && state.pending === 0) return state;
      if (state.status === "error" || state.status === "paused") {
        throw new Error(`${state.status}: ${state.message ?? state.error ?? "unknown"}`);
      }
      return false;
    },
    label,
    60_000,
    300,
  );
  return result;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The desktop E2E harness currently supports Windows only");
  }
  if (!fs.existsSync(path.join(repoRoot, "main.js"))) {
    throw new Error("main.js is missing. Run npm run build first.");
  }

  await startLocalServer();
  const login = await api("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      device: { name: "Syncy E2E API", platform: "node" },
    }),
  });
  if (login.status !== 200) throw new Error(`API login failed: ${login.text}`);
  token = login.json.accessToken;

  const vault = await api("/v1/vaults", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: `Obsidian E2E ${new Date().toISOString()}` }),
  });
  if (vault.status !== 201) throw new Error(`vault creation failed: ${vault.text}`);
  createdVaultId = vault.json.vault.id;
  log(`created remote vault ${createdVaultId}`);

  await prepareVault();
  const install = await prepareObsidianInstall();
  await launchObsidian(install);
  await enablePlugin();
  await setupPlugin();
  const initial = await waitForSync("initial sync");
  log(`initial sync complete (${initial.files} files, cursor ${initial.cursor})`);

  const initialServer = await listFiles();
  if (!initialServer.some((file) => file.path === "Welcome.md")) {
    throw new Error("initial sync did not upload Welcome.md");
  }

  const created = await cdp.evaluate(`(async () => {
    await app.vault.createFolder("Notes");
    await app.vault.createFolder("Attachments");
    await app.vault.createFolder("Empty E2E");
    await app.vault.create("Notes/E2E Created.md", "created through obsidian");
    await app.vault.createBinary(
      "Attachments/e2e.bin",
      new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]).buffer,
    );
    const plugin = app.plugins.plugins.syncy;
    await plugin.engine.flushLocalPending();
    await plugin.engine.syncNow();
    return true;
  })()`);
  if (!created) throw new Error("creating files through the Obsidian API failed");

  await waitFor(
    async () => {
      const files = await listFiles();
      return (
        files.some((file) => file.path === "Notes/E2E Created.md") &&
        files.some((file) => file.path === "Attachments/e2e.bin") &&
        files.some((file) => file.path === "Empty E2E")
      );
    },
    "local files on server",
    30_000,
  );
  log("local files, binary attachment and empty folder reached the server");

  const binary = await findFile("Attachments/e2e.bin");
  const blob = await fetch(`${serverUrl}/v1/vaults/${createdVaultId}/blobs/${binary.hash}`, {
    headers: authHeaders(),
  });
  if (blob.status !== 200) throw new Error(`binary download failed: ${blob.status}`);
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (sha256(bytes) !== binary.hash || bytes.length !== 10) {
    throw new Error("binary attachment content mismatch");
  }

  const modified = await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    const file = app.vault.getAbstractFileByPath("Notes/E2E Created.md");
    await app.vault.modify(file, "updated through obsidian");
    await plugin.engine.flushLocalPending();
    await plugin.engine.syncNow();
    return true;
  })()`);
  if (!modified) throw new Error("modifying through the Obsidian API failed");

  await waitFor(
    async () => {
      const file = await findFile("Notes/E2E Created.md");
      return file?.hash === sha256(Buffer.from("updated through obsidian"));
    },
    "modified note on server",
    30_000,
  );
  log("local edit reached the server");

  const fileData = await cdp.evaluate(`(() => {
    const plugin = app.plugins.plugins.syncy;
    return plugin.engine.getState().entryAt("Notes/E2E Created.md");
  })()`);
  if (!fileData?.fileId) throw new Error("could not read file ID from plugin state");
  const versions = await api(
    `/v1/vaults/${createdVaultId}/files/${encodeURIComponent(fileData.fileId)}/versions`,
    { headers: authHeaders() },
  );
  if (versions.status !== 200 || versions.json.versions.length < 2) {
    throw new Error("expected at least two stored versions");
  }
  const originalVersion = versions.json.versions[versions.json.versions.length - 1];
  const restore = await api(
    `/v1/vaults/${createdVaultId}/files/${encodeURIComponent(fileData.fileId)}/versions/${encodeURIComponent(originalVersion.id)}/restore`,
    {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{}",
    },
  );
  if (restore.status !== 200 || !restore.json?.applied) {
    throw new Error(`version restore failed: ${restore.text}`);
  }
  await waitFor(
    async () => {
      await syncPlugin();
      return cdp.evaluate(
        `app.vault.read(app.vault.getAbstractFileByPath("Notes/E2E Created.md")).then((text) => text === "created through obsidian")`,
      );
    },
    "restored version applied locally",
    30_000,
  );
  log("version history restore applied to the Obsidian vault");

  await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    const file = app.vault.getAbstractFileByPath("Notes/E2E Created.md");
    await app.vault.rename(file, "Notes/Renamed.md");
    await plugin.engine.flushLocalPending();
    await plugin.engine.syncNow();
    return true;
  })()`);
  await waitFor(
    async () => {
      const files = await listFiles();
      return (
        files.some((file) => file.path === "Notes/Renamed.md") &&
        !files.some((file) => file.path === "Notes/E2E Created.md")
      );
    },
    "local rename on server",
    30_000,
  );
  log("local rename reached the server");

  await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    await plugin.updateSettings({ intervalSeconds: 0 }, true);
    return Boolean(plugin.realtime);
  })()`);
  await waitForSync("sync after disabling polling");
  log("polling disabled for the realtime test");

  const remoteFileId = randomUUID();
  const remoteContent = Buffer.from("created by another Syncy device");
  const remoteResult = await pushFile("FromServer.md", remoteContent, remoteFileId);
  const remoteRevision = remoteResult.revision;
  const realtimeArrived = await waitFor(
    async () => {
      return cdp.evaluate(`(async () => {
        const file = app.vault.getAbstractFileByPath("FromServer.md");
        if (!file) return false;
        return (await app.vault.read(file)) === "created by another Syncy device";
      })()`);
    },
    "remote file via realtime WebSocket",
    25_000,
  );
  if (!realtimeArrived) throw new Error("remote file did not arrive over realtime");
  log("remote file arrived through the realtime WebSocket");

  const remoteDelete = await api(`/v1/vaults/${createdVaultId}/changes`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      atomic: true,
      changes: [
        {
          fileId: remoteFileId,
          path: "FromServer.md",
          kind: "file",
          deleted: true,
          expectedRevision: remoteRevision,
        },
      ],
    }),
  });
  if (remoteDelete.status !== 200 || !remoteDelete.json?.applied) {
    throw new Error(`remote delete failed: ${remoteDelete.text}`);
  }
  await waitFor(
    async () => cdp.evaluate("!app.vault.getAbstractFileByPath('FromServer.md')"),
    "remote delete via realtime WebSocket",
    25_000,
  );
  log("remote delete was applied over realtime");

  fs.writeFileSync(
    path.join(vaultPath, ".obsidian", "app.json"),
    JSON.stringify({ baseFontSize: 18 }),
    "utf8",
  );
  await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    await plugin.engine.flushLocalPending();
    await plugin.engine.syncNow();
    return true;
  })()`);
  await waitFor(
    async () => {
      const file = await findFile(".obsidian/app.json");
      return file?.hash === sha256(Buffer.from('{"baseFontSize":18}'));
    },
    "config file on server",
    30_000,
  );
  log("vault configuration changed without a vault event reached the server");

  await cdp.evaluate(`(async () => {
    const plugin = app.plugins.plugins.syncy;
    const file = app.vault.getAbstractFileByPath("Notes/Renamed.md");
    await app.vault.delete(file);
    await plugin.engine.flushLocalPending();
    await plugin.engine.syncNow();
    return true;
  })()`);
  await waitFor(
    async () => !(await findFile("Notes/Renamed.md")),
    "local delete on server",
    30_000,
  );
  log("local delete reached the server");

  const finalState = await syncPlugin();
  if (finalState.status !== "synced" || finalState.pending !== 0) {
    throw new Error(`final state is not clean: ${JSON.stringify(finalState)}`);
  }
  if (finalState.error) throw new Error(`final sync error: ${finalState.error}`);

  passed = true;
  log("E2E PASS");
}

async function cleanup() {
  try {
    cdp?.close();
  } catch {
    // Ignore cleanup failures.
  }

  if (token && createdVaultId) {
    try {
      await api(`/v1/vaults/${createdVaultId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      // Ignore cleanup failures.
    }
  }

  killTree(obsidianProcess?.pid);
  killTree(serverProcess?.pid);
  await sleep(500);

  if (!passed || keep) {
    log(`kept E2E artifacts at ${tempRoot}`);
    log(`kept Obsidian app data at ${userDataPath}`);
  } else {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(userDataPath, { recursive: true, force: true });
    } catch (error) {
      log(`cleanup warning: ${error.message}`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`[e2e] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
