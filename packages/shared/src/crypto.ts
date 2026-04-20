import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "./env";

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
