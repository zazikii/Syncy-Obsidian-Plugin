export class SyncyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SyncyApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

export class AuthLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthLostError";
  }
}

export class SyncPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncPausedError";
  }
}

export function isSyncyApiError(error: unknown): error is SyncyApiError {
  return error instanceof SyncyApiError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
