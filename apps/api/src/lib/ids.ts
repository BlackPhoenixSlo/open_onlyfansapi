import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform base62 string (rejection sampling, no modulo bias). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += ALPHABET[b % 62];
    }
  }
  return out;
}

/** `newId('key')` → `key_<20 base62>` */
export function newId(prefix: string): string {
  return `${prefix}_${randomBase62(20)}`;
}

/** API key secret: `gk_` + 32 base62 characters. */
export function newKeySecret(): string {
  return `gk_${randomBase62(32)}`;
}
