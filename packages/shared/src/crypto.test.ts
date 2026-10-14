import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, decryptSecretBase64, encryptSecret } from "./crypto";

describe("bounded authenticated base64 decoding", () => {
  beforeEach(() => vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64)));
  afterEach(() => vi.unstubAllEnvs());

  it.each([1, 2, 3, 4, 393_215, 393_216, 393_217, 786_435])("preserves all %i original bytes across transport and padding boundaries", length => {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index++) bytes[index] = index % 256;
    const encrypted = encryptSecret(bytes.toString("base64"));
    expect(decryptSecretBase64(encrypted, length)).toEqual(bytes);
    expect(decryptSecretBase64(encrypted, length)).toEqual(Buffer.from(decryptSecret(encrypted), "base64"));
    expect(() => decryptSecretBase64(encrypted, length - 1)).toThrow();
  });

  it.each(["tag", "cipher", "truncation"])("does not return bytes after %s corruption", target => {
    const parts = encryptSecret(Buffer.alloc(400_001, 173).toString("base64")).split(":");
    if (target === "tag") parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    else if (target === "cipher") parts[3] = parts[3].slice(0, 100) + (parts[3][100] === "A" ? "B" : "A") + parts[3].slice(101);
    else parts[3] = parts[3].slice(0, -4);
    expect(() => decryptSecretBase64(parts.join(":"), 500_000)).toThrow();
  });

  it.each(["AA=A", "AA", "AAAA====", "Zm9v=", "éAAA"])("rejects authenticated malformed base64 %s", plaintext => {
    expect(() => decryptSecretBase64(encryptSecret(plaintext), 100)).toThrow();
  });
});
