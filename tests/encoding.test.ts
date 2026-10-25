import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase32,
  bytesToBase64Url,
  concatBytes,
  randomId,
  utf8Decode,
  utf8Encode,
} from "../src/util/encoding";
import { EMPTY_SHA256, sha256Hex } from "../src/util/hash";

describe("encoding", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it("encodes base32", () => {
    expect(bytesToBase32(utf8Encode("foo"))).toBe("MZXW6");
    expect(bytesToBase32(new Uint8Array([0]))).toBe("AA");
  });

  it("concatenates and decodes text", () => {
    const joined = concatBytes(utf8Encode("hello "), utf8Encode("world"));
    expect(utf8Decode(joined)).toBe("hello world");
  });

  it("creates valid file ids", () => {
    const id = randomId();
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });
});

describe("hashing", () => {
  it("hashes empty content", async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(EMPTY_SHA256);
  });

  it("hashes utf-8 content", async () => {
    expect(await sha256Hex(utf8Encode("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
