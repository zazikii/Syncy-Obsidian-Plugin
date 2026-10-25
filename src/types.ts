export type FileKind = "file" | "folder";

export interface DeviceInfo {
  id?: string;
  name?: string;
  platform?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  tokenType: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  deviceId: string;
  user: PublicUser;
}

export interface ServerInfo {
  name: string;
  version: string;
  setupRequired: boolean;
  registrationOpen: boolean;
  e2ee: boolean;
  maxBlobBytes: number;
  realtime: boolean;
  apiVersion: number;
}

export interface Vault {
  id: string;
  name: string;
  e2ee: boolean;
  revision: number;
  prunedBeforeRevision: number;
  role: "owner" | "editor" | "reader";
  ownerId: string;
  keyEnvelope: string | null;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FileSummary {
  fileId: string;
  path: string;
  kind: FileKind;
  encrypted: boolean;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  revision: number;
  deleted: boolean;
  updatedAt: number;
}

export interface Change extends FileSummary {
  versionId: string;
  deviceId: string | null;
  createdAt: number;
}

export interface FilePage {
  vaultId: string;
  revision: number;
  prunedBeforeRevision: number;
  hasMore: boolean;
  nextCursor: string | null;
  files: FileSummary[];
}

export interface ChangesPage {
  vaultId: string;
  since: number;
  until: number;
  revision: number;
  prunedBeforeRevision: number;
  hasMore: boolean;
  nextCursor: number;
  changes: Change[];
}

export interface PushChange {
  fileId: string;
  path: string;
  kind: FileKind;
  encrypted?: boolean;
  hash?: string | null;
  size?: number;
  mtime?: number;
  ctime?: number;
  deleted?: boolean;
  expectedRevision?: number | null;
}

export interface PushConflict {
  fileId: string;
  code: "revision_mismatch" | "not_found" | "already_exists" | "path_taken" | string;
  message: string;
  server?: FileSummary;
}

export interface ChangeResult {
  fileId: string;
  status: "applied" | "conflict" | "skipped" | "rejected";
  revision?: number;
  versionId?: string;
  reason?: string;
  conflict?: PushConflict;
}

export interface PushResult {
  vaultId: string;
  previousRevision: number;
  revision: number;
  applied: boolean;
  hasConflicts: boolean;
  results: ChangeResult[];
  conflicts: PushConflict[];
}

export interface Version {
  id: string;
  fileId: string;
  revision: number;
  path: string;
  kind: FileKind;
  encrypted: boolean;
  hash: string | null;
  size: number;
  mtime: number;
  ctime: number;
  deleted: boolean;
  deviceId: string | null;
  createdAt: number;
}

export interface VersionsPage {
  vaultId: string;
  fileId: string;
  hasMore: boolean;
  nextCursor: number | null;
  versions: Version[];
}

export interface WsTicket {
  ticket: string;
  expiresAt: number;
}

export type WsServerMessage =
  | { type: "hello"; userId: string; deviceId: string; serverVersion: string; serverTime: number }
  | { type: "subscribed"; vaultId: string; revision: number }
  | { type: "unsubscribed"; vaultId: string; reason?: string }
  | { type: "pong"; serverTime: number }
  | { type: "vault_updated"; vaultId: string; name: string; actorUserId: string }
  | { type: "vault_settings_changed"; vaultId: string; revision: number; actorUserId: string }
  | {
      type: "vault_changed";
      vaultId: string;
      revision: number;
      actorUserId: string;
      originDeviceId: string | null;
    }
  | { type: "vault_members_changed"; vaultId: string; actorUserId: string }
  | { type: "vault_deleted"; vaultId: string; actorUserId: string }
  | { type: "error"; code: string; message: string; vaultId?: string };

export interface StoredSession {
  refreshToken: string;
  refreshTokenExpiresAt: number;
  deviceId: string;
  user: PublicUser;
  serverUrl: string;
}

export interface StoredVaultKey {
  key: string;
  savedAt: number;
}
