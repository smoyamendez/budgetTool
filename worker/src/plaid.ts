// Plaid over plain fetch (the Node SDK depends on axios, which doesn't suit Workers).
// API reference: https://plaid.com/docs/api/
import { decryptSecret, encryptSecret } from './crypto.js';
import { HttpError, now, type Env } from './env.js';
import { deleteTxns, getBudget, putBudget, upsertTxns, type Txn } from './store.js';

const BASES: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export function plaidConfigured(env: Env): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}

export class PlaidError extends HttpError {}

async function call<T>(env: Env, endpoint: string, body: Record<string, unknown>): Promise<T> {
  if (!plaidConfigured(env)) throw new HttpError(400, 'Plaid keys are not set yet. Add PLAID_CLIENT_ID and PLAID_SECRET as Worker secrets.', 'CONFIG');
  const base = env.PLAID_BASE_URL || BASES[(env.PLAID_ENV || 'sandbox').toLowerCase()] || BASES.sandbox;
  const res = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PlaidError(res.status >= 500 ? 502 : 400, data.display_message || data.error_message || `Plaid returned ${res.status}.`, data.error_code || 'PLAID_ERROR');
  }
  return data as T;
}

interface ItemRow {
  item_id: string;
  access_token_enc: string;
  institution_name: string;
  accounts: string;
  balances: string;
  cursor: string | null;
  last_synced: string | null;
  error: string | null;
}

interface PlaidAccount {
  account_id: string;
  name: string;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances?: { current?: number | null; available?: number | null; limit?: number | null } | null;
}
interface Balance { name: string; type: string; subtype: string; current: number | null; available: number | null; limit: number | null }

function toBalance(a: PlaidAccount): Balance {
  return { name: accountLabel(a), type: a.type || '', subtype: a.subtype || '', current: a.balances?.current ?? null, available: a.balances?.available ?? null, limit: a.balances?.limit ?? null };
}

/** /accounts/get returns the balances Plaid already has on file, at no extra cost. */
async function fetchAccounts(env: Env, token: string) {
  const r = await call<{ accounts: PlaidAccount[] }>(env, '/accounts/get', { access_token: token });
  const accounts: Record<string, string> = {}, balances: Record<string, Balance> = {};
  for (const a of r.accounts) { accounts[a.account_id] = accountLabel(a); balances[a.account_id] = toBalance(a); }
  return { accounts, balances };
}

export async function listItems(env: Env) {
  const { results } = await env.DB.prepare('SELECT item_id, institution_name, accounts, balances, last_synced, error FROM plaid_items ORDER BY created_at').all<Omit<ItemRow, 'access_token_enc' | 'cursor'>>();
  return results.map((r) => ({
    ...r,
    accounts: Object.values(JSON.parse(r.accounts || '{}') as Record<string, string>),
    balances: Object.values(JSON.parse(r.balances || '{}') as Record<string, Balance>),
  }));
}

async function accessToken(env: Env, itemId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT access_token_enc FROM plaid_items WHERE item_id = ?1').bind(itemId).first<{ access_token_enc: string }>();
  if (!row) throw new HttpError(404, 'That connection no longer exists.', 'NOT_FOUND');
  return decryptSecret(env, row.access_token_enc);
}

export async function createLinkToken(env: Env, itemId?: string): Promise<string> {
  const body: Record<string, unknown> = {
    user: { client_user_id: 'payday-owner' },
    client_name: 'Payday',
    language: 'en',
    country_codes: ['US'],
  };
  // Update mode (fixing a broken sign-in) takes the item's access token and no products.
  if (itemId) body.access_token = await accessToken(env, itemId);
  else {
    body.products = ['transactions'];
    body.transactions = { days_requested: 180 };
  }
  if (env.PLAID_REDIRECT_URI) body.redirect_uri = env.PLAID_REDIRECT_URI;
  const r = await call<{ link_token: string }>(env, '/link/token/create', body);
  return r.link_token;
}

function accountLabel(a: { name: string; mask?: string | null }): string {
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

export async function exchangePublicToken(env: Env, publicToken: string, institutionName?: string) {
  const ex = await call<{ access_token: string; item_id: string }>(env, '/item/public_token/exchange', { public_token: publicToken });
  let accounts: Record<string, string> = {}, balances: Record<string, Balance> = {};
  try {
    ({ accounts, balances } = await fetchAccounts(env, ex.access_token));
  } catch {
    // Names and balances are nice to have. Sync still works without them.
  }
  await env.DB.prepare(
    `INSERT INTO plaid_items (item_id, access_token_enc, institution_name, accounts, balances, cursor, last_synced, error, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6)
     ON CONFLICT(item_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, institution_name = excluded.institution_name, accounts = excluded.accounts, balances = excluded.balances, error = NULL`,
  ).bind(ex.item_id, await encryptSecret(env, ex.access_token), String(institutionName || 'Bank').slice(0, 120), JSON.stringify(accounts), JSON.stringify(balances), now()).run();
  return { item_id: ex.item_id, institution_name: institutionName || 'Bank' };
}

export async function removeItem(env: Env, itemId: string): Promise<void> {
  try {
    await call(env, '/item/remove', { access_token: await accessToken(env, itemId) });
  } catch {
    // If Plaid already forgot it, still remove it here.
  }
  await env.DB.prepare('DELETE FROM plaid_items WHERE item_id = ?1').bind(itemId).run();
}

interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name?: string | null;
  amount: number;
  pending: boolean;
  pending_transaction_id?: string | null;
  personal_finance_category?: { primary?: string } | null;
}
interface SyncPage {
  added: PlaidTxn[];
  modified: PlaidTxn[];
  removed: { transaction_id?: string }[];
  accounts?: { account_id: string; name: string; mask?: string | null }[];
  next_cursor: string;
  has_more: boolean;
}

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  errors: { itemId: string; institution: string; code: string; message: string }[];
}

/**
 * Pull new, changed and removed transactions for every connection with /transactions/sync.
 * When a pending charge posts, Plaid removes the pending one and adds the posted one with
 * pending_transaction_id pointing back. Bills linked to the pending charge move to the posted one.
 */
export async function syncAll(env: Env): Promise<SyncResult> {
  const result: SyncResult = { added: 0, modified: 0, removed: 0, errors: [] };
  const { results: items } = await env.DB.prepare('SELECT * FROM plaid_items').all<ItemRow>();
  const relink = new Map<string, string>();

  for (const item of items) {
    const accounts = JSON.parse(item.accounts || '{}') as Record<string, string>;
    let token: string;
    try {
      token = await decryptSecret(env, item.access_token_enc);
    } catch {
      result.errors.push({ itemId: item.item_id, institution: item.institution_name, code: 'DECRYPT_FAILED', message: 'Could not read this connection. Was TOKEN_ENCRYPTION_KEY changed?' });
      continue;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      let cursor = item.cursor;
      const added: PlaidTxn[] = [], modified: PlaidTxn[] = [], removed: string[] = [];
      try {
        let more = true;
        while (more) {
          const page = await call<SyncPage>(env, '/transactions/sync', { access_token: token, count: 500, ...(cursor ? { cursor } : {}) });
          added.push(...page.added);
          modified.push(...page.modified);
          for (const r of page.removed) if (r.transaction_id) removed.push(r.transaction_id);
          for (const a of page.accounts || []) accounts[a.account_id] = accountLabel(a);
          more = page.has_more;
          cursor = page.next_cursor;
        }
        const toTxn = (t: PlaidTxn): Txn => ({
          transaction_id: t.transaction_id,
          date: t.date,
          name: t.name,
          merchant_name: t.merchant_name ?? null,
          amount: t.amount,
          account_id: t.account_id,
          account_name: accounts[t.account_id] || item.institution_name,
          pending: t.pending,
          pending_transaction_id: t.pending_transaction_id ?? null,
          category: t.personal_finance_category?.primary ?? null,
          source: 'plaid',
        });
        result.added += await upsertTxns(env, added.map(toTxn));
        await upsertTxns(env, modified.map(toTxn));
        result.modified += modified.length;
        await deleteTxns(env, removed);
        result.removed += removed.length;
        for (const t of added) if (t.pending_transaction_id) relink.set(t.pending_transaction_id, t.transaction_id);
        let balances = item.balances || '{}';
        try {
          const fresh = await fetchAccounts(env, token);
          Object.assign(accounts, fresh.accounts);
          balances = JSON.stringify(fresh.balances);
        } catch {
          // Keep the last known balances. Transactions still synced.
        }
        await env.DB.prepare('UPDATE plaid_items SET cursor = ?1, accounts = ?2, balances = ?3, last_synced = ?4, error = NULL WHERE item_id = ?5')
          .bind(cursor, JSON.stringify(accounts), balances, now(), item.item_id).run();
        break;
      } catch (err: any) {
        const code = err?.code || 'UNKNOWN';
        // Plaid asks you to restart the pull from the old cursor if data changed mid-way.
        if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 2) continue;
        await env.DB.prepare('UPDATE plaid_items SET error = ?1 WHERE item_id = ?2').bind(code, item.item_id).run();
        result.errors.push({ itemId: item.item_id, institution: item.institution_name, code, message: err?.message || 'Sync failed.' });
        break;
      }
    }
  }

  if (relink.size) {
    const budget = await getBudget(env);
    const paid = (budget?.paid || {}) as Record<string, { txn?: string }>;
    let changed = false;
    for (const entry of Object.values(paid)) {
      if (entry?.txn && relink.has(entry.txn)) {
        entry.txn = relink.get(entry.txn);
        changed = true;
      }
    }
    if (changed && budget) await putBudget(env, budget);
  }
  return result;
}
