import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, store, upsertTxns, type Txn } from './store.js';
import { createLinkToken, exchangePublicToken, plaidConfigured, plaidEnv, plaidError, removeItem, syncAll } from './plaid.js';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../public');
const PORT = Number(process.env.PORT) || 3000;
// Only listen on this computer. Your Plaid keys and bank tokens live on this server.
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '10mb' }));

// Reject requests that come from other websites open in your browser.
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('origin');
  let sameSite = true;
  if (origin) { try { sameSite = new URL(origin).host === req.get('host'); } catch { sameSite = false; } }
  if (req.method !== 'GET' && !sameSite) {
    res.status(403).json({ error: 'Requests from other sites are not allowed.' });
    return;
  }
  next();
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    const e = plaidError(err);
    console.error('[payday]', e.code, e.message);
    res.status(500).json({ error: e.message, code: e.code });
  });
};

// ---------- budget ----------
app.get('/api/state', wrap(async (_req, res) => {
  res.json({ state: await store.getBudget() });
}));

app.put('/api/state', wrap(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'Expected the budget as a JSON object.' });
    return;
  }
  await store.putBudget(req.body);
  res.json({ ok: true });
}));

// ---------- transactions ----------
app.get('/api/transactions', wrap(async (_req, res) => {
  res.json(await store.getTxns());
}));

const MONTH = /^\d{4}-\d{2}$/;
app.put('/api/transactions/month/:month', wrap(async (req, res) => {
  const m = req.params.month;
  const items = req.body?.items;
  if (!MONTH.test(m) || !Array.isArray(items)) {
    res.status(400).json({ error: 'Expected { items: [...] } for a month like 2026-10.' });
    return;
  }
  const t = await store.getTxns();
  const clean: Txn[] = items
    .filter((x: any) => x && typeof x.transaction_id === 'string' && typeof x.date === 'string' && x.date.startsWith(m) && Number.isFinite(+x.amount))
    .map((x: any) => ({
      transaction_id: String(x.transaction_id).slice(0, 200),
      date: String(x.date).slice(0, 10),
      name: String(x.name || 'Payment').slice(0, 200),
      merchant_name: x.merchant_name ? String(x.merchant_name).slice(0, 120) : null,
      amount: Math.round(+x.amount * 100) / 100,
      account_id: x.account_id ?? null,
      account_name: String(x.account_name || '').slice(0, 120),
      pending: Boolean(x.pending),
      pending_transaction_id: x.pending_transaction_id ?? null,
      category: x.category ?? null,
      source: x.source === 'plaid' ? 'plaid' : 'csv',
    }));
  t.months[m] = [];
  upsertTxns(t, clean);
  if (!t.months[m]?.length) delete t.months[m];
  await store.putTxns(t);
  res.json({ ok: true, count: clean.length });
}));

app.delete('/api/transactions/month/:month', wrap(async (req, res) => {
  const t = await store.getTxns();
  delete t.months[req.params.month];
  await store.putTxns(t);
  res.json({ ok: true });
}));

// ---------- Plaid ----------
app.get('/api/plaid/status', wrap(async (_req, res) => {
  const p = await store.getPlaid();
  res.json({
    configured: plaidConfigured,
    env: plaidEnv,
    items: p.items.map((i) => ({
      item_id: i.item_id,
      institution_name: i.institution_name,
      accounts: Object.values(i.accounts),
      last_synced: i.last_synced,
      error: i.error,
    })),
  });
}));

app.post('/api/plaid/link-token', wrap(async (req, res) => {
  if (!plaidConfigured) {
    res.status(400).json({ error: 'Add your Plaid keys to the .env file, then restart the server.' });
    return;
  }
  res.json({ link_token: await createLinkToken(req.body?.item_id) });
}));

app.post('/api/plaid/exchange', wrap(async (req, res) => {
  const { public_token, institution_name } = req.body || {};
  if (typeof public_token !== 'string') {
    res.status(400).json({ error: 'Missing public_token.' });
    return;
  }
  const item = await exchangePublicToken(public_token, institution_name);
  const sync = await syncAll();
  res.json({ item_id: item.item_id, institution_name: item.institution_name, sync });
}));

app.post('/api/plaid/sync', wrap(async (_req, res) => {
  res.json(await syncAll());
}));

app.delete('/api/plaid/items/:id', wrap(async (req, res) => {
  await removeItem(req.params.id);
  res.json({ ok: true });
}));

// ---------- app ----------
app.use(express.static(publicDir));

app.listen(PORT, HOST, () => {
  console.log(`Payday is running at http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(plaidConfigured ? `Plaid: ${plaidEnv}` : 'Plaid: not set up yet. Add your keys to .env to connect banks.');
});
