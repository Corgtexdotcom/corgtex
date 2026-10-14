import { decryptSecret } from "@corgtex/shared";

/** Verify the authenticated encrypted JSON envelope without returning or logging its contents. */
export function isMcpToolInputEncryptedPayload(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("aes-256-gcm:")) return false;
  const parts = value.split(":");
  if (parts.length !== 4 || parts[1].length !== 16 || parts[2].length !== 22
    || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    JSON.parse(decryptSecret(value));
    return true;
  } catch {
    return false;
  }
}
