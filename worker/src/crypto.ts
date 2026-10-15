// Small helpers on top of the Web Crypto API that Workers provide.
import { HttpError, type Env } from './env.js';

const enc = new TextEncoder();

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const toB64Url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two strings without leaking where they differ through timing. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

let cachedKey: { raw: string; key: CryptoKey } | null = null;
async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new HttpError(500, 'TOKEN_ENCRYPTION_KEY is not set. See the README.', 'CONFIG');
  if (cachedKey?.raw === raw) return cachedKey.key;
  const bytes = fromB64(raw.trim());
  if (bytes.length !== 32) throw new HttpError(500, 'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded.', 'CONFIG');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  cachedKey = { raw, key };
  return key;
}

/** AES-GCM encrypt. Output is base64 of a 12-byte IV followed by the ciphertext. */
export async function encryptSecret(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

export async function decryptSecret(env: Env, packed: string): Promise<string> {
  const bytes = fromB64(packed);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(env), bytes.slice(12));
  return new TextDecoder().decode(pt);
}
