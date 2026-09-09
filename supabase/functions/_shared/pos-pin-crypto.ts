import { argon2id } from "@noble/hashes/argon2";
import { randomBytes } from "@noble/hashes/utils";

const MEMORY_KIB = 19_456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const OUTPUT_BYTES = 32;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "");
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  try {
    const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validPin(pin: string): boolean {
  return /^\d{4,8}$/u.test(pin);
}

export async function hashPosPin(pin: string, salt = randomBytes(16)): Promise<string> {
  if (!validPin(pin)) throw new Error("A POS PIN must contain 4 to 8 digits");
  if (salt.length !== 16) throw new Error("A POS PIN salt must contain exactly 16 bytes");

  const digest = argon2id(pin, salt, {
    t: ITERATIONS,
    m: MEMORY_KIB,
    p: PARALLELISM,
    dkLen: OUTPUT_BYTES,
  });
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${ITERATIONS},p=${PARALLELISM}$${encodeBase64(salt)}$${encodeBase64(digest)}`;
}

export async function verifyPosPin(encoded: string, pin: string): Promise<boolean> {
  if (!validPin(pin)) return false;
  const match = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([^$]+)\$([^$]+)$/u.exec(encoded);
  if (!match) return false;

  const salt = decodeBase64(match[1]);
  const expected = decodeBase64(match[2]);
  if (!salt || salt.length !== 16 || !expected || expected.length !== OUTPUT_BYTES) return false;

  const actual = argon2id(pin, salt, {
    t: ITERATIONS,
    m: MEMORY_KIB,
    p: PARALLELISM,
    dkLen: OUTPUT_BYTES,
  });
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index];
  }
  return difference === 0;
}
