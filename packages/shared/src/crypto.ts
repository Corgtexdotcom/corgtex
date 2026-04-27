import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const SECRET_ENCRYPTION_VERSION = "aes-256-gcm";

function encryptionKey() {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Missing ENCRYPTION_KEY required for AES-256-GCM");
  }
  const key = Buffer.from(env.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string.");
  }
  return key;
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

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
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
