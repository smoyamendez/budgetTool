// Single-person sign-in: one password (a Worker secret), then a random session
// token the app sends as "Authorization: Bearer <token>". Only a hash of each
// token is stored, so a copy of the database can't be used to sign in.
import { randomToken, safeEqual, sha256Hex } from './crypto.js';
import { HttpError, now, type Env } from './env.js';

const SESSION_DAYS = 60;
const WINDOW_MIN = 15;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 20;

export async function login(env: Env, req: Request, password: unknown): Promise<string> {
  if (!env.APP_PASSWORD) throw new HttpError(500, 'APP_PASSWORD is not set. See the README.', 'CONFIG');
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();

  const fails = await env.DB.prepare(
    'SELECT SUM(CASE WHEN ip = ?1 THEN 1 ELSE 0 END) AS mine, COUNT(*) AS total FROM login_attempts WHERE ok = 0 AND at > ?2',
  ).bind(ip, since).first<{ mine: number | null; total: number }>();
  if ((fails?.mine || 0) >= MAX_FAILS_PER_IP || (fails?.total || 0) >= MAX_FAILS_TOTAL) {
    throw new HttpError(429, `Too many wrong passwords. Wait ${WINDOW_MIN} minutes and try again.`, 'RATE_LIMITED');
  }

  const ok = typeof password === 'string' && password.length > 0 && (await safeEqual(password, env.APP_PASSWORD));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_attempts (ip, at, ok) VALUES (?1, ?2, ?3)').bind(ip, now(), ok ? 1 : 0),
    env.DB.prepare('DELETE FROM login_attempts WHERE at < ?1').bind(new Date(Date.now() - 7 * 864e5).toISOString()),
  ]);
  if (!ok) throw new HttpError(401, "That password isn't right.", 'BAD_PASSWORD');

  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)').bind(await sha256Hex(token), now(), expires),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now()),
  ]);
  return token;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export async function requireSession(env: Env, req: Request): Promise<void> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Please sign in.', 'SIGNED_OUT');
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1')
    .bind(await sha256Hex(token)).first<{ expires_at: string }>();
  if (!row || row.expires_at < now()) throw new HttpError(401, 'Please sign in again.', 'SIGNED_OUT');
}

export async function logout(env: Env, req: Request): Promise<void> {
  const token = bearer(req);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
}

export async function logoutEverywhere(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions').run();
}
