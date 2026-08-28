import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Encrypts plaintext using AES-256-GCM with a master key.
 * Returns a base64 string: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string, masterKey: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error("master key must be 64 hex characters (32 bytes)");
  }
  const key = Buffer.from(masterKey, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * Decrypts a ciphertext produced by encrypt().
 * Returns the original plaintext.
 */
export function decrypt(ciphertext: string, masterKey: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error("master key must be 64 hex characters (32 bytes)");
  }
  const key = Buffer.from(masterKey, "hex");
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("invalid ciphertext format");
  }
  const [ivB64, authTagB64, encryptedB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * Decrypts with key rotation support: tries the current key first, then the
 * previous one. `rotated` tells the caller the value was sealed with the old
 * key and should be re-encrypted with the current key on the next write.
 */
export function decryptWithRotation(
  ciphertext: string,
  masterKey: string,
  previousKey: string | null,
): { value: string; rotated: boolean } {
  try {
    return { value: decrypt(ciphertext, masterKey), rotated: false };
  } catch (currentKeyError) {
    if (!previousKey) throw currentKeyError;
    return { value: decrypt(ciphertext, previousKey), rotated: true };
  }
}

/**
 * Generates a random master key suitable for AGENT_SERVICE_ENCRYPTION_KEY.
 */
export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}
