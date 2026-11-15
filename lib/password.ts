import { randomBytes, scrypt as _scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt (memory-hard, built into Node: no native dependency). Parameters follow OWASP's minimum (N=2^17, r=8, p=1).
const N = 131072;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => _scrypt(password, salt, KEYLEN, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

/** Format: scrypt$N$r$p$saltB64$hashB64 (self-describing so parameters can be raised later). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// A real hash of a random value, used so unknown-email logins cost the same as known-email ones (no user enumeration by timing).
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString("hex")));

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const hash = stored && stored.startsWith("scrypt$") ? stored : await dummyHash();
  const [, n, r, p, saltB64, keyB64] = hash.split("$");
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  const match = key.length === expected.length && timingSafeEqual(key, expected);
  return match && hash === stored;
}

/** Shared by signup + reset. Length matters more than composition (NIST 800-63B); we keep letter+digit as a floor. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "At least 8 characters";
  if (pw.length > 200) return "Too long";
  if (!/[A-Za-z]/.test(pw)) return "Include a letter";
  if (!/\d/.test(pw)) return "Include a number";
  return null;
}
