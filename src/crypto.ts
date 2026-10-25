import {
  base64UrlToBytes,
  bytesToBase32,
  bytesToBase64Url,
  concatBytes,
  randomBytes,
  utf8Decode,
  utf8Encode,
} from "./util/encoding";
import { hmacSha256 } from "./util/hash";
import { normalizeVaultPath } from "./util/path";

const CONTENT_MAGIC = utf8Encode("SYNCY1\n");
const PATH_PREFIX = "s1.";
const CONTENT_AAD_PREFIX = "syncy-content-v1:";
const PATH_AAD = utf8Encode("syncy-path-v1");
const ENVELOPE_AAD = utf8Encode("syncy-envelope-v1");
const KDF_ITERATIONS = 600_000;
const MIN_KDF_ITERATIONS = 100_000;
const MAX_KDF_ITERATIONS = 2_000_000;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

interface EnvelopeV1 {
  v: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

async function deriveAesKey(key: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", copyBytes(key), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: copyBytes(utf8Encode(info)),
    },
    material,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deriveBytes(key: Uint8Array, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey("raw", copyBytes(key), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: copyBytes(utf8Encode(info)),
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export class VaultCrypto {
  private constructor(
    private readonly contentKey: CryptoKey,
    private readonly pathKey: CryptoKey,
    private readonly fileIdKey: Uint8Array<ArrayBuffer>,
  ) {}

  static async fromKey(key: Uint8Array): Promise<VaultCrypto> {
    if (key.length !== 32) throw new CryptoError("Vault key must be 32 bytes");
    const contentKey = await deriveAesKey(key, "syncy-content-v1");
    const pathKey = await deriveAesKey(key, "syncy-path-v1");
    const fileIdKey = await deriveBytes(key, "syncy-file-id-v1");
    return new VaultCrypto(contentKey, pathKey, fileIdKey);
  }

  async encryptContent(
    plaintext: ArrayBuffer | Uint8Array,
    fileId: string,
    nonce?: Uint8Array,
  ): Promise<Uint8Array> {
    const plaintextBytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
    const nonceBytes = nonce ? copyBytes(nonce) : randomBytes(12);
    if (nonceBytes.length !== 12) throw new CryptoError("Content nonce must be 12 bytes");
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonceBytes,
        additionalData: copyBytes(utf8Encode(`${CONTENT_AAD_PREFIX}${fileId}`)),
      },
      this.contentKey,
      copyBytes(plaintextBytes),
    );
    return concatBytes(CONTENT_MAGIC, nonceBytes, new Uint8Array(ciphertext));
  }

  async decryptContent(ciphertext: ArrayBuffer | Uint8Array, fileId: string): Promise<Uint8Array> {
    const bytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
    if (bytes.length < CONTENT_MAGIC.length + 12 + 16) {
      throw new CryptoError("Encrypted file is too short");
    }
    for (let index = 0; index < CONTENT_MAGIC.length; index += 1) {
      if (bytes[index] !== CONTENT_MAGIC[index]) {
        throw new CryptoError("Encrypted file has an unsupported format");
      }
    }
    const nonce = bytes.subarray(CONTENT_MAGIC.length, CONTENT_MAGIC.length + 12);
    const body = bytes.subarray(CONTENT_MAGIC.length + 12);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: copyBytes(nonce),
          additionalData: copyBytes(utf8Encode(`${CONTENT_AAD_PREFIX}${fileId}`)),
        },
        this.contentKey,
        copyBytes(body),
      );
      return new Uint8Array(plaintext);
    } catch {
      throw new CryptoError("Could not decrypt file content");
    }
  }

  async encryptPath(path: string): Promise<string> {
    const normalized = normalizeVaultPath(path);
    const nonce = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: copyBytes(PATH_AAD) },
      this.pathKey,
      copyBytes(utf8Encode(normalized)),
    );
    return PATH_PREFIX + bytesToBase64Url(concatBytes(nonce, new Uint8Array(ciphertext)));
  }

  async decryptPath(value: string): Promise<string> {
    if (!value.startsWith(PATH_PREFIX)) {
      throw new CryptoError("Encrypted path has an unsupported format");
    }
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(value.slice(PATH_PREFIX.length));
    } catch {
      throw new CryptoError("Encrypted path is not valid base64url");
    }
    if (bytes.length < 13) throw new CryptoError("Encrypted path is too short");
    const nonce = bytes.subarray(0, 12);
    const body = bytes.subarray(12);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: copyBytes(nonce), additionalData: copyBytes(PATH_AAD) },
        this.pathKey,
        copyBytes(body),
      );
      return normalizeVaultPath(utf8Decode(new Uint8Array(plaintext)));
    } catch {
      throw new CryptoError("Could not decrypt path");
    }
  }

  async fileIdForPath(path: string): Promise<string> {
    const normalized = normalizeVaultPath(path);
    const digest = await hmacSha256(this.fileIdKey, `syncy-file-id:${normalized}`);
    return bytesToBase32(digest).slice(0, 32);
  }
}

export function generateVaultKey(): Uint8Array {
  return randomBytes(32);
}

export function vaultKeyToBase64(key: Uint8Array): string {
  return bytesToBase64Url(key);
}

export function vaultKeyFromBase64(value: string): Uint8Array {
  const key = base64UrlToBytes(value);
  if (key.length !== 32) throw new CryptoError("Stored vault key is invalid");
  return key;
}

async function deriveEnvelopeKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    copyBytes(utf8Encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: copyBytes(salt),
      iterations,
    },
    material,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function wrapVaultKey(key: Uint8Array, passphrase: string): Promise<string> {
  if (key.length !== 32) throw new CryptoError("Vault key must be 32 bytes");
  if (passphrase.length < 8) throw new CryptoError("E2EE passphrase must be at least 8 characters");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const kek = await deriveEnvelopeKey(passphrase, salt, KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: copyBytes(ENVELOPE_AAD) },
    kek,
    copyBytes(key),
  );
  const envelope: EnvelopeV1 = {
    v: 1,
    kdf: "pbkdf2-sha256",
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64Url(salt),
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

export async function unwrapVaultKey(
  envelopeText: string,
  passphrase: string,
): Promise<Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeText);
  } catch {
    throw new CryptoError("Key envelope is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CryptoError("Key envelope is invalid");
  }
  const envelope = parsed as Partial<EnvelopeV1>;
  if (envelope.v !== 1 || envelope.kdf !== "pbkdf2-sha256") {
    throw new CryptoError("This key envelope uses an unsupported format");
  }
  if (
    typeof envelope.iterations !== "number" ||
    envelope.iterations < MIN_KDF_ITERATIONS ||
    envelope.iterations > MAX_KDF_ITERATIONS
  ) {
    throw new CryptoError("Key envelope has invalid KDF parameters");
  }
  if (
    typeof envelope.salt !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new CryptoError("Key envelope is incomplete");
  }

  const salt = base64UrlToBytes(envelope.salt);
  const nonce = base64UrlToBytes(envelope.nonce);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  if (salt.length < 8 || nonce.length !== 12) {
    throw new CryptoError("Key envelope has invalid parameters");
  }

  const kek = await deriveEnvelopeKey(passphrase, salt, envelope.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: copyBytes(nonce), additionalData: copyBytes(ENVELOPE_AAD) },
      kek,
      copyBytes(ciphertext),
    );
    const key = new Uint8Array(plaintext);
    if (key.length !== 32) throw new CryptoError("Key envelope contains an invalid key");
    return key;
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError("Incorrect E2EE passphrase or damaged key envelope");
  }
}
