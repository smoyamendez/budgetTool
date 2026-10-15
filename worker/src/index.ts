import { login, logout, logoutEverywhere, requireSession } from './auth.js';
import { HttpError, type Env } from './env.js';
import { createLinkToken, exchangePublicToken, listItems, plaidConfigured, removeItem, syncAll } from './plaid.js';
import { cleanTxn, deleteMonth, getBudget, getTxnMonths, putBudget, upsertTxns } from './store.js';

const MONTH = /^\d{4}-\d{2}$/;

function allowedOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

async function readJson(req: Request): Promise<any> {
  if (Number(req.headers.get('Content-Length') || 0) > 5_000_000) throw new HttpError(413, 'That request is too large.');
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Expected JSON.');
  }
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const { pathname: p } = url;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    const body = await readJson(req);
    return json({ token: await login(env, req, body?.password) });
  }

  // Everything below needs a signed-in session.
  await requireSession(env, req);

  if (p === '/api/session' && m === 'GET') return json({ ok: true });
  if (p === '/api/logout' && m === 'POST') { await logout(env, req); return json({ ok: true }); }
  if (p === '/api/logout-everywhere' && m === 'POST') { await logoutEverywhere(env); return json({ ok: true }); }

  if (p === '/api/state' && m === 'GET') return json({ state: await getBudget(env) });
  if (p === '/api/state' && m === 'PUT') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected the budget as a JSON object.');
    await putBudget(env, body);
    return json({ ok: true });
  }

  if (p === '/api/transactions' && m === 'GET') return json({ months: await getTxnMonths(env) });
  const monthMatch = /^\/api\/transactions\/month\/([^/]+)$/.exec(p);
  if (monthMatch) {
    const month = monthMatch[1];
    if (!MONTH.test(month)) throw new HttpError(400, 'Use a month like 2026-10.');
    if (m === 'PUT') {
      const body = await readJson(req);
      if (!Array.isArray(body?.items)) throw new HttpError(400, 'Expected { items: [...] }.');
      const items = body.items.map(cleanTxn).filter((t: any) => t && t.date.startsWith(month));
      await upsertTxns(env, items);
      return json({ ok: true, count: items.length });
    }
    if (m === 'DELETE') { await deleteMonth(env, month); return json({ ok: true }); }
  }

  if (p === '/api/plaid/status' && m === 'GET') {
    return json({ configured: plaidConfigured(env), env: env.PLAID_ENV || 'sandbox', items: await listItems(env) });
  }
  if (p === '/api/plaid/link-token' && m === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    return json({ link_token: await createLinkToken(env, typeof body?.item_id === 'string' ? body.item_id : undefined) });
  }
  if (p === '/api/plaid/exchange' && m === 'POST') {
    const body = await readJson(req);
    if (typeof body?.public_token !== 'string') throw new HttpError(400, 'Missing public_token.');
    const item = await exchangePublicToken(env, body.public_token, typeof body.institution_name === 'string' ? body.institution_name : undefined);
    return json({ ...item, sync: await syncAll(env) });
  }
  if (p === '/api/plaid/sync' && m === 'POST') return json(await syncAll(env));
  const itemMatch = /^\/api\/plaid\/items\/([^/]+)$/.exec(p);
  if (itemMatch && m === 'DELETE') { await removeItem(env, decodeURIComponent(itemMatch[1])); return json({ ok: true }); }

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }

    const origin = req.headers.get('Origin');
    const sameOrigin = origin === url.origin;
    const allowed = sameOrigin ? null : allowedOrigin(env, origin);
    const cors = corsHeaders(allowed);

    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    // Browsers send Origin on cross-site requests. Refuse any site that isn't on the list.
    if (origin && !sameOrigin && !allowed) return json({ error: 'This site is not allowed to use the Payday API.' }, 403);

    try {
      const res = await route(req, env, url);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[payday]', err?.code, err?.message);
      return json({ error: err instanceof HttpError ? err.message : 'Something went wrong on the server.', code: err?.code || 'ERROR' }, status, cors);
    }
  },

  // Daily bank sync (see [triggers] in wrangler.toml).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!plaidConfigured(env)) return;
    ctx.waitUntil(syncAll(env).then((r) => console.log('[payday] daily sync', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
