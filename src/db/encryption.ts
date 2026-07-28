import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const SECRET_KEY_SALT = "oled-secret-v1";
const FORMAT_PREFIX = "gcm:";

export function generateKey(): string {
  return randomBytes(32).toString("hex");
}

function deriveSecretKey(dbKey: string): Buffer {
  return scryptSync(dbKey, SECRET_KEY_SALT, 32);
}

/**
 * Encrypts a secret (e.g. PDF password) with AES-256-GCM, key derived from
 * `dbKey` via scrypt; a passthrough when `dbKey` is empty. Output format:
 * `gcm:<iv-hex>:<tag-hex>:<ciphertext-hex>`.
 */
export function encryptSecret(plaintext: string, dbKey: string): string {
  if (!dbKey) return plaintext;
  const key = deriveSecretKey(dbKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decryptSecret(ciphertext: string, dbKey: string): string {
  if (!dbKey || !ciphertext.startsWith(FORMAT_PREFIX)) return ciphertext;
  const rest = ciphertext.slice(FORMAT_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret.");
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = deriveSecretKey(dbKey);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
