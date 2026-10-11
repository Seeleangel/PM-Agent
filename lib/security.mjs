import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function validUsername(value) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(value);
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHex) {
  try {
    const actual = scryptSync(password, salt, 64, SCRYPT_OPTIONS);
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
}
