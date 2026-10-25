# Syncy for Obsidian

Self-hosted sync for Obsidian, powered by your own [Syncy](https://github.com/zazikii/Syncy) server. Notes, attachments, folders, themes, snippets, community plugins and vault configuration stay in sync across devices without a subscription.

Optional end-to-end encryption keeps file contents and paths unreadable to the server.

> [!IMPORTANT]
> Syncy is not compatible with Obsidian's official Sync service and is not affiliated with or endorsed by Obsidian.

## Features

- **Everything syncs** — Markdown, Canvas, attachments, empty folders, themes, snippets, plugin bundles and `.obsidian` configuration.
- **Stable file identity** — Renames keep version history; path swaps are pushed as one atomic batch.
- **Conflict safety** — Per-file revisions and `expectedRevision` checks. Stale writes become conflict copies instead of silent overwrites.
- **Version history** — Browse, preview and restore previous versions from the file menu.
- **Real-time** — WebSocket notifications pull remote changes immediately, with periodic polling as a fallback.
- **Large vaults** — Paginated snapshots, cursor-based change feeds, batched pushes and bounded upload concurrency.
- **Durable queue** — Local changes and cursors persist outside the synced tree and resume after a restart.
- **Selective sync** — Glob exclusions plus toggles for `.obsidian` config, workspace layouts and community plugin data.
- **Optional E2EE** — AES-256-GCM content, encrypted paths and deterministic encrypted file IDs. The server only stores ciphertext.
- **Desktop and mobile** — No Node-only APIs in the sync path.

## Requirements

- Obsidian 1.6.0 or newer.
- A reachable Syncy server. Follow the [server quick start](https://github.com/zazikii/Syncy#quick-start).
- HTTPS is strongly recommended for any non-local server.

## Installation

Syncy is not in the community plugin store yet. Build it and copy the result into your vault:

```bash
git clone https://github.com/zazikii/Syncy-Obsidian-Plugin.git
cd Syncy-Obsidian-Plugin
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into:

```text
<your-vault>/.obsidian/plugins/syncy/
```

Then open **Settings → Community plugins**, reload Obsidian, and enable **Syncy**.

For development, create a junction or symlink from the repository to your vault's plugin folder and run `npm run dev`.

## Setup

1. Start your Syncy server and create the account from its `.env` (or use `/v1/setup`).
2. Open **Settings → Syncy**.
3. Enter the server URL, email and password, then click **Sign in**.
4. Choose an existing remote vault and click **Link**, or enter a name and click **Create vault**.
5. If the vault is end-to-end encrypted, enter the E2EE passphrase when prompted.

Syncy immediately runs an initial sync: the server snapshot is downloaded first, then local-only files are uploaded. For a large existing vault this may take a while; the status bar shows progress.

### Multiple devices

Repeat the setup on each device and link the same remote vault. Devices authenticate with their own refresh token and appear separately in the server's device list. Never link two different remote vaults to the same local Obsidian vault at the same time.

## What gets synced

| Included by default | Excluded by default |
| --- | --- |
| Notes, canvases, databases, PDFs and other attachments | `.trash/**` and `.git/**` |
| Empty folders and folder renames | OS junk: `.DS_Store`, `Thumbs.db`, `desktop.ini` |
| `.obsidian/app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`, `community-plugins.json`, `themes.json` | `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/workspaces.json` |
| `.obsidian/themes/**`, `.obsidian/snippets/**` | `.obsidian/plugins/*/data.json` unless plugin data sync is enabled |
| `.obsidian/plugins/**` bundles, manifests and styles | The Syncy plugin folder and its local sync state |

Syncy rescans `.obsidian` on each sync because Obsidian does not consistently emit vault events for its configuration directory. This also catches settings changed while the plugin was disabled.

The **Sync** section of the settings lets you:

- Disable periodic polling or real-time notifications.
- Exclude additional paths with one glob per line (`*`, `**`, `?`).
- Sync workspace layouts (usually device-specific).
- Sync community plugin `data.json` files, which may contain API keys and tokens.
- Trigger a manual sync, full resync or local-state reset.

When you change exclusions, Syncy stops managing the affected paths locally but **does not delete them from the server**.

## Conflict handling

Every pushed change carries the last applied server revision. If another device wrote first, Syncy:

1. Downloads the server version.
2. Keeps your local content in a copy such as `Note (conflict 2026-10-25 143512).md`.
3. Writes the server version to the original path and syncs the conflict copy as a new file.

Conflicts caused by a path collision are handled the same way. Nothing is silently overwritten.

## Version history

Open the command palette and run **Syncy: version history for the current file**, or right-click a synced file and choose **Syncy: version history**.

The history modal lists stored revisions. You can preview text versions and restore one as a new change. Binary versions can be restored but are not previewed. Encrypted versions are decrypted locally with the vault key.

## End-to-end encryption

Create a vault with **End-to-end encryption** enabled, or unlock an existing encrypted vault with its E2EE passphrase.

- **Content** — AES-256-GCM with a fresh nonce per version and the stable file ID as associated data.
- **Paths** — AES-256-GCM, encoded as opaque base64url strings.
- **File IDs** — HMAC-SHA256 of the normalized path during initial seeding, then stable across renames.
- **Keys** — a random 256-bit vault key, split with HKDF into content, path and file-ID keys.
- **Key envelopes** — the vault key is wrapped with a PBKDF2-SHA256 (600,000 iterations) key derived from the E2EE passphrase. The server stores only the opaque envelope.

The E2EE passphrase is never sent to the server and cannot be recovered by it. A separate login password is used for authentication. If **Remember key on this device** is enabled, the unlocked vault key is stored in the plugin's local `data.json`; disable it and enter the passphrase after each Obsidian restart for stricter security.

Sharing encrypted vaults, key rotation and member key distribution are server capabilities but not yet exposed in this plugin's UI.

## Local data

Syncy stores its own state under:

```text
.obsidian/plugins/syncy/
  data.json                 settings, refresh token, optional saved vault keys
  sync-state/<vault-id>.json  cursor, file IDs, revisions, hashes and pending changes
```

This folder is always excluded from sync. Keep it out of backups that you would not trust with credentials, or sign out and remove saved keys first.

## Commands

| Command | Purpose |
| --- | --- |
| **Syncy: sync now** | Pull and push immediately. |
| **Syncy: full resync** | Re-read the paginated server snapshot, reconcile local files, then resume the change feed. |
| **Syncy: reset local sync state** | Forget cursor, file IDs, revisions and pending metadata; rebuild from the server without deleting local files. |
| **Syncy: version history for the current file** | Open stored versions for the active file. |
| **Syncy: sign out** | Stop sync and revoke this device's session. |

The ribbon icon and status bar also trigger and report syncs.

## Development

```bash
npm install
npm run dev         # watch build
npm run typecheck
npm run lint
npm test
npm run build       # typecheck + production bundle
```

The unit tests cover E2EE primitives, key envelopes, path/glob handling, encoding and state persistence. An optional integration suite exercises the real engine against a live server:

```bash
SYNCY_TEST_URL=http://127.0.0.1:8080 \
SYNCY_TEST_EMAIL=you@example.com \
SYNCY_TEST_PASSWORD=your-password \
npm run test:integration
```

It creates and deletes temporary vaults on the server and covers initial import, edits, renames, deletes, path swaps, conflicts, stale cursors, remote moves/deletes and encrypted sync.

### Source layout

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, account/vault linking, status bar. |
| `src/api.ts` | `/v1` client, token refresh, blobs, changes, versions. |
| `src/sync/engine.ts` | Snapshot import, pull/apply, watcher queue, batched push, conflicts. |
| `src/state.ts` | Durable per-vault cursor, file-ID map and write-ahead pending queue. |
| `src/realtime.ts` | WebSocket tickets, subscriptions and reconnect backoff. |
| `src/crypto.ts` | E2EE content/path encryption, file-ID derivation and key envelopes. |
| `src/ui/` | Settings tab, passphrase/confirmation dialogs and version history. |
| `src/util/` | Paths, globs, hashing, encoding and errors. |

## Limitations

- The structured `/v1/vaults/:id/settings` document is not used; vault configuration syncs as raw `.obsidian` files.
- Blob uploads and downloads buffer the file through Obsidian's `requestUrl`; very large attachments use proportional memory.
- There is no side-by-side merge or diff editor for conflicts, only conflict copies.
- E2EE vault sharing and key rotation need to be done outside this plugin for now.
- One remote vault per Obsidian vault.
- File modification timestamps are not restored locally after a remote apply; Obsidian may show the download time as the local modified time.

## Security

- Use HTTPS. A self-hosted server with plain HTTP exposes credentials and content to the network.
- The login password is used once and is not stored. Refresh tokens rotate on every use.
- `data.json` contains a refresh token and, if enabled, saved vault keys. Protect your vault folder.
- Prefer E2EE for vaults containing plugin data with API tokens.
- The server administrator can read non-E2EE vault contents.

## Repository

Plugin: [github.com/zazikii/Syncy-Obsidian-Plugin](https://github.com/zazikii/Syncy-Obsidian-Plugin)

Server: [github.com/zazikii/Syncy](https://github.com/zazikii/Syncy)
