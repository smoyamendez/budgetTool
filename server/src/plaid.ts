import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products, type Transaction } from 'plaid';
import { store, upsertTxns, removeTxns, type PlaidItem, type Txn } from './store.js';

const env = (process.env.PLAID_ENV || 'sandbox').toLowerCase();

export const plaidConfigured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
export const plaidEnv = env;

const client = new PlaidApi(
  new Configuration({
    // PLAID_BASE_URL is only for testing against a fake Plaid server.
    basePath: process.env.PLAID_BASE_URL || PlaidEnvironments[env] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
        'PLAID-SECRET': process.env.PLAID_SECRET || '',
      },
    },
  }),
);

/** Plaid's own error message when there is one, so the app can show something useful. */
export function plaidError(err: any): { code: string; message: string } {
  const data = err?.response?.data;
  if (data?.error_code) return { code: data.error_code, message: data.display_message || data.error_message };
  return { code: 'UNKNOWN', message: err?.message || 'Something went wrong talking to Plaid.' };
}

export async function createLinkToken(updateItemId?: string): Promise<string> {
  let access_token: string | undefined;
  if (updateItemId) {
    const item = (await store.getPlaid()).items.find((i) => i.item_id === updateItemId);
    if (!item) throw new Error('That connection no longer exists.');
    access_token = item.access_token;
  }
  const res = await client.linkTokenCreate({
    user: { client_user_id: 'payday-local-user' },
    client_name: 'Payday',
    language: 'en',
    country_codes: [CountryCode.Us],
    // In update mode (fixing a broken sign-in) Plaid wants the access token and no products.
    ...(access_token ? { access_token } : { products: [Products.Transactions], transactions: { days_requested: 180 } }),
    ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken: string, institutionName?: string): Promise<PlaidItem> {
  const ex = await client.itemPublicTokenExchange({ public_token: publicToken });
  const item: PlaidItem = {
    item_id: ex.data.item_id,
    access_token: ex.data.access_token,
    institution_name: institutionName || 'Bank',
    accounts: {},
    cursor: null,
    last_synced: null,
    error: null,
  };
  try {
    const acc = await client.accountsGet({ access_token: item.access_token });
    for (const a of acc.data.accounts) item.accounts[a.account_id] = a.mask ? `${a.name} ••${a.mask}` : a.name;
  } catch {
    // Account names are nice to have; transactions still sync without them.
  }
  const p = await store.getPlaid();
  p.items = p.items.filter((i) => i.item_id !== item.item_id).concat(item);
  await store.putPlaid(p);
  return item;
}

export async function removeItem(itemId: string): Promise<void> {
  const p = await store.getPlaid();
  const item = p.items.find((i) => i.item_id === itemId);
  if (!item) return;
  try {
    await client.itemRemove({ access_token: item.access_token });
  } catch {
    // If Plaid already forgot it, still remove it here.
  }
  p.items = p.items.filter((i) => i.item_id !== itemId);
  await store.putPlaid(p);
}

function toTxn(t: Transaction, item: PlaidItem): Txn {
  return {
    transaction_id: t.transaction_id,
    date: t.date,
    name: t.name,
    merchant_name: t.merchant_name ?? null,
    amount: t.amount,
    account_id: t.account_id,
    account_name: item.accounts[t.account_id] || item.institution_name,
    pending: t.pending,
    pending_transaction_id: t.pending_transaction_id ?? null,
    category: t.personal_finance_category?.primary ?? null,
    source: 'plaid',
  };
}

export interface SyncResult { added: number; modified: number; removed: number; errors: { institution: string; message: string; itemId: string; code: string }[] }

/**
 * Pull new, changed and removed transactions for every connection using /transactions/sync.
 * When a pending charge posts, Plaid removes the pending one and adds the posted one with
 * pending_transaction_id pointing back. Any bill linked to the pending charge is moved to the posted one.
 */
export async function syncAll(): Promise<SyncResult> {
  const p = await store.getPlaid();
  const txns = await store.getTxns();
  const result: SyncResult = { added: 0, modified: 0, removed: 0, errors: [] };
  const relink = new Map<string, string>();

  for (const item of p.items) {
    const startCursor = item.cursor;
    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      let cursor = startCursor;
      const added: Transaction[] = [];
      const modified: Transaction[] = [];
      const removed: string[] = [];
      try {
        let hasMore = true;
        while (hasMore) {
          const res = await client.transactionsSync({ access_token: item.access_token, cursor: cursor ?? undefined, count: 500 });
          added.push(...res.data.added);
          modified.push(...res.data.modified);
          removed.push(...res.data.removed.map((r) => r.transaction_id).filter((id): id is string => Boolean(id)));
          for (const a of res.data.accounts || []) item.accounts[a.account_id] = a.mask ? `${a.name} ••${a.mask}` : a.name;
          hasMore = res.data.has_more;
          cursor = res.data.next_cursor;
        }
        result.added += upsertTxns(txns, added.map((t) => toTxn(t, item)));
        upsertTxns(txns, modified.map((t) => toTxn(t, item)));
        result.modified += modified.length;
        removeTxns(txns, new Set(removed));
        result.removed += removed.length;
        for (const t of added) if (t.pending_transaction_id) relink.set(t.pending_transaction_id, t.transaction_id);
        item.cursor = cursor;
        item.last_synced = new Date().toISOString();
        item.error = null;
        break;
      } catch (err) {
        const e = plaidError(err);
        // Plaid asks you to restart the whole pull if data changed mid-way.
        if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 2) continue;
        item.error = e.code;
        result.errors.push({ institution: item.institution_name, message: e.message, itemId: item.item_id, code: e.code });
        break;
      }
    }
  }

  await store.putTxns(txns);
  await store.putPlaid(p);

  if (relink.size) {
    const budget = await store.getBudget();
    const paid = (budget?.paid || {}) as Record<string, { txn?: string; amount?: number; on?: string }>;
    let changed = false;
    for (const entry of Object.values(paid)) {
      if (entry?.txn && relink.has(entry.txn)) { entry.txn = relink.get(entry.txn); changed = true; }
    }
    if (changed && budget) await store.putBudget(budget);
  }
  return result;
}
