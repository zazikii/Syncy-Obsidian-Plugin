import { describe, expect, it } from "vitest";
import {
  CryptoError,
  generateVaultKey,
  unwrapVaultKey,
  VaultCrypto,
  wrapVaultKey,
} from "../src/crypto";

describe("VaultCrypto", () => {
  const key = new Uint8Array(32).fill(7);

  it("round-trips file content and binds it to the file id", async () => {
    const vault = await VaultCrypto.fromKey(key);
    const plaintext = new TextEncoder().encode("hello syncy");
    const ciphertext = await vault.encryptContent(plaintext, "file-a");
    expect(ciphertext.length).toBeGreaterThan(plaintext.length);
    const decrypted = await vault.decryptContent(ciphertext, "file-a");
    expect(new TextDecoder().decode(decrypted)).toBe("hello syncy");
    await expect(vault.decryptContent(ciphertext, "file-b")).rejects.toBeInstanceOf(CryptoError);
  });

  it("uses a fresh nonce for each encryption", async () => {
    const vault = await VaultCrypto.fromKey(key);
    const plaintext = new TextEncoder().encode("same content");
    const first = await vault.encryptContent(plaintext, "file-a");
    const second = await vault.encryptContent(plaintext, "file-a");
    expect(Array.from(first)).not.toEqual(Array.from(second));
  });

  it("round-trips encrypted paths", async () => {
    const vault = await VaultCrypto.fromKey(key);
    const path = "Notes/Über/hello.md";
    const encrypted = await vault.encryptPath(path);
    expect(encrypted.startsWith("s1.")).toBe(true);
    expect(encrypted).not.toContain("Notes");
    expect(await vault.decryptPath(encrypted)).toBe(path);
  });

  it("derives stable path-based file ids", async () => {
    const vault = await VaultCrypto.fromKey(key);
    const first = await vault.fileIdForPath("Notes/hello.md");
    const second = await vault.fileIdForPath("Notes/hello.md");
    const other = await vault.fileIdForPath("Notes/other.md");
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe("key envelopes", () => {
  it("wraps and unwraps a vault key", async () => {
    const key = generateVaultKey();
    const envelope = await wrapVaultKey(key, "correct horse battery staple");
    expect(envelope).toContain("pbkdf2-sha256");
    const unwrapped = await unwrapVaultKey(envelope, "correct horse battery staple");
    expect(Array.from(unwrapped)).toEqual(Array.from(key));
  }, 30_000);

  it("rejects a wrong passphrase", async () => {
    const key = generateVaultKey();
    const envelope = await wrapVaultKey(key, "right-passphrase");
    await expect(unwrapVaultKey(envelope, "wrong-passphrase")).rejects.toBeInstanceOf(CryptoError);
  }, 30_000);
});
