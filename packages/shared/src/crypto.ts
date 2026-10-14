import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const SECRET_ENCRYPTION_VERSION = "aes-256-gcm";

function encryptionKey() {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Missing ENCRYPTION_KEY required for AES-256-GCM");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.ENCRYPTION_KEY)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string.");
  }
  return Buffer.from(env.ENCRYPTION_KEY, "hex");
}

/** Validate configuration through the same path as encryption without exposing key bytes. */
export function isSecretEncryptionConfigured() {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(value: string) {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== SECRET_ENCRYPTION_VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("Unsupported encrypted secret format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Decode encrypted base64 bytes with bounded transport/plaintext copies. No
 * bytes escape this function until GCM authentication has succeeded. */
export function decryptSecretBase64(value: string, maxBytes: number): Buffer {
  const [version, ivRaw, tagRaw, ciphertextRaw, extra] = value.split(":");
  if (version !== SECRET_ENCRYPTION_VERSION || !ivRaw || !tagRaw || !ciphertextRaw || extra !== undefined
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Unsupported encrypted secret format.");
  const upperBytes = Math.floor(Math.floor(ciphertextRaw.length * 3 / 4) / 4) * 3;
  if (upperBytes > maxBytes + 2) throw new Error("Encrypted base64 payload exceeds its byte bound.");
  const key = encryptionKey(), iv = Buffer.from(ivRaw, "base64url"), tag = Buffer.from(tagRaw, "base64url");
  const authenticator = createDecipheriv("aes-256-gcm", key, iv);
  authenticator.setAuthTag(tag);
  // Authenticate first with bounded discarded plaintext. Only the second pass
  // interprets base64, so unauthenticated content cannot reach even the decoder.
  for (let offset = 0; offset < ciphertextRaw.length; offset += 512 * 1024) {
    const part = ciphertextRaw.slice(offset, offset + 512 * 1024);
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid encrypted secret ciphertext.");
    authenticator.update(Buffer.from(part, "base64url"));
  }
  authenticator.final();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const output = Buffer.allocUnsafe(Math.min(upperBytes, maxBytes));
  let written = 0, carry = "", padded = false;
  const append = (plaintext: Buffer) => {
    if (!plaintext.length) return;
    if (padded) throw new Error("Invalid encrypted base64 payload.");
    const text = carry + plaintext.toString("utf8"), complete = text.length - text.length % 4;
    const segment = text.slice(0, complete);
    carry = text.slice(complete);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(segment) || !/^[A-Za-z0-9+/]*$/.test(carry)) {
      throw new Error("Invalid encrypted base64 payload.");
    }
    padded = segment.includes("=");
    if (padded && carry) throw new Error("Invalid encrypted base64 payload.");
    const bytes = Buffer.from(segment, "base64");
    if (written + bytes.length > maxBytes || written + bytes.length > output.length) {
      throw new Error("Encrypted base64 payload exceeds its byte bound.");
    }
    bytes.copy(output, written); written += bytes.length;
  };
  // Base64url transport pages are divisible by four; decoding each page cannot
  // lose bits at the boundary. Plaintext base64 carries its own final padding.
  for (let offset = 0; offset < ciphertextRaw.length; offset += 512 * 1024) {
    const part = ciphertextRaw.slice(offset, offset + 512 * 1024);
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid encrypted secret ciphertext.");
    append(decipher.update(Buffer.from(part, "base64url")));
  }
  append(decipher.final());
  if (carry) throw new Error("Invalid encrypted base64 payload.");
  return output.subarray(0, written);
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function isPasswordLoginDisabled(storedHash: string) {
  return storedHash.startsWith("disabled$");
}

export function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, hash] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) {
    return false;
  }

  const candidate = Buffer.from(scryptSync(password, salt, 64));
  const expected = Buffer.from(hash, "hex");

  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
}

export function randomOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function sessionCookieName() {
  return env.NODE_ENV === "production" ? "__Host-corgtex_session" : "corgtex_session";
}
