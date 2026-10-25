import { bytesToHex, utf8Encode } from "./encoding";

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const source = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy;
}

export async function sha256Bytes(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(data));
  return new Uint8Array(digest);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return bytesToHex(await sha256Bytes(data));
}

export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(key.length);
  keyBytes.set(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, toBytes(utf8Encode(message)));
  return new Uint8Array(signature);
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
