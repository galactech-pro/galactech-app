import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM with a versioned envelope.
 *
 *   v1:<keyId>:<base64(iv | tag | ciphertext)>
 *
 * - keyId = first 8 hex chars of sha256(key). It lets decrypt() pick between ENCRYPTION_KEY (current) and
 *   ENCRYPTION_KEY_PREVIOUS (rotation) without trial decryption.
 * - Optional `aad` (additional authenticated data) binds the ciphertext to a context such as `org:<uuid>`;
 *   decrypt() must be given the same value. Existing call sites pass none, and values written without AAD
 *   must be read without AAD. Only start using AAD where every reader is updated together.
 * - Legacy payloads (no "v1:" prefix: base64(iv | tag | ciphertext), no AAD) are still readable with the
 *   current key, then the previous key.
 * Rotation runbook: docs/SECURITY.md.
 */

const VERSION = "v1";

function parseKey(hex: string | undefined, name: string): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be 32 bytes hex (64 chars)`);
  return Buffer.from(hex, "hex");
}

const keyId = (k: Buffer) => createHash("sha256").update(k).digest("hex").slice(0, 8);

function currentKey(): Buffer {
  return parseKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
}

function previousKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY_PREVIOUS;
  return hex ? parseKey(hex, "ENCRYPTION_KEY_PREVIOUS") : null;
}

function seal(key: Buffer, plain: string, aad?: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function open(key: Buffer, buf: Buffer, aad?: string): string {
  if (buf.length < 28) throw new Error("Ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  if (aad) d.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

/** Encrypts with the CURRENT key. Output: `v1:<keyId>:<base64>`. */
export function encrypt(plain: string, aad?: string): string {
  const k = currentKey();
  return `${VERSION}:${keyId(k)}:${seal(k, plain, aad).toString("base64")}`;
}

/** Decrypts v1 envelopes and legacy unprefixed payloads. Throws on tampering / wrong key / wrong AAD. */
export function decrypt(payload: string, aad?: string): string {
  if (payload.startsWith(`${VERSION}:`)) {
    const [, id, b64] = payload.split(":");
    if (!id || !b64) throw new Error("Malformed ciphertext");
    const buf = Buffer.from(b64, "base64");
    const cur = currentKey();
    if (id === keyId(cur)) return open(cur, buf, aad);
    const prev = previousKey();
    if (prev && id === keyId(prev)) return open(prev, buf, aad);
    throw new Error("Ciphertext was encrypted with an unknown key id");
  }
  // legacy: unprefixed, no AAD
  const buf = Buffer.from(payload, "base64");
  try {
    return open(currentKey(), buf);
  } catch (e) {
    const prev = previousKey();
    if (!prev) throw e;
    return open(prev, buf);
  }
}

/** True when the payload is legacy or was written with a key other than the current one (re-encrypt it). */
export function needsReencrypt(payload: string): boolean {
  if (!payload.startsWith(`${VERSION}:`)) return true;
  return payload.split(":")[1] !== keyId(currentKey());
}

/** Decrypt (current or previous key) and encrypt again under the current key. Use in rotation scripts. */
export function reencrypt(payload: string, aad?: string): string {
  return encrypt(decrypt(payload, aad), aad);
}
