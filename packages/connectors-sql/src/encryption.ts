import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@corgtex/shared";

const ALGO = "aes-256-gcm";

function getSecretKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Missing ENCRYPTION_KEY required for AES-256-GCM");
  }
  return Buffer.from(env.ENCRYPTION_KEY, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getSecretKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

export function decrypt(ciphertext: string): string {
  const key = getSecretKey();
  const [ivHex, tagHex, encHex] = ciphertext.split(":");
  
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
