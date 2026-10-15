import { now, type Env } from './env.js';

/** A bank or imported payment, in Plaid's transaction shape. Positive amount = money out. */
export interface Txn {
  transaction_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  account_id?: string | null;
  account_name: string;
  pending: boolean;
  pending_transaction_id?: string | null;
  category?: string | null;
  source: 'plaid' | 'csv';
}

export async function getBudget(env: Env): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare('SELECT state FROM budget WHERE id = 1').first<{ state: string }>();
  return row ? JSON.parse(row.state) : null;
}

export async function putBudget(env: Env, state: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO budget (id, state, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
  ).bind(JSON.stringify(state), now()).run();
}

export async function getTxnMonths(env: Env): Promise<Record<string, Txn[]>> {
  const { results } = await env.DB.prepare('SELECT month, data FROM transactions ORDER BY date ASC').all<{ month: string; data: string }>();
  const months: Record<string, Txn[]> = {};
  for (const r of results) (months[r.month] ||= []).push(JSON.parse(r.data));
  return months;
}

/** D1 runs a batch as one transaction. Chunk to stay well inside its limits. */
async function runBatches(env: Env, stmts: D1PreparedStatement[], size = 50): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size));
}

/** Insert or replace by id. Returns how many ids were new. */
export async function upsertTxns(env: Env, txns: Txn[]): Promise<number> {
  if (!txns.length) return 0;
  const ids = txns.map((t) => t.transaction_id);
  let existing = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE transaction_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).first<{ n: number }>();
    existing += row?.n || 0;
  }
  const stmt = env.DB.prepare(
    `INSERT INTO transactions (transaction_id, month, date, source, data) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(transaction_id) DO UPDATE SET month = excluded.month, date = excluded.date, source = excluded.source, data = excluded.data`,
  );
  await runBatches(env, txns.map((t) => stmt.bind(t.transaction_id, t.date.slice(0, 7), t.date, t.source, JSON.stringify(t))));
  return new Set(ids).size - existing;
}

export async function deleteTxns(env: Env, ids: string[]): Promise<void> {
  const stmt = env.DB.prepare('DELETE FROM transactions WHERE transaction_id = ?1');
  await runBatches(env, ids.map((id) => stmt.bind(id)));
}

export async function deleteMonth(env: Env, month: string): Promise<void> {
  await env.DB.prepare('DELETE FROM transactions WHERE month = ?1').bind(month).run();
}

/** Clean up anything the app sends before it's stored. */
export function cleanTxn(x: any): Txn | null {
  if (!x || typeof x.transaction_id !== 'string' || typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(x.date) || !Number.isFinite(+x.amount)) return null;
  return {
    transaction_id: x.transaction_id.slice(0, 200),
    date: x.date.slice(0, 10),
    name: String(x.name || 'Payment').slice(0, 200),
    merchant_name: x.merchant_name ? String(x.merchant_name).slice(0, 120) : null,
    amount: Math.round(+x.amount * 100) / 100,
    account_id: x.account_id ? String(x.account_id).slice(0, 120) : null,
    account_name: String(x.account_name || '').slice(0, 120),
    pending: Boolean(x.pending),
    pending_transaction_id: x.pending_transaction_id ? String(x.pending_transaction_id).slice(0, 200) : null,
    category: x.category ? String(x.category).slice(0, 80) : null,
    source: x.source === 'plaid' ? 'plaid' : 'csv',
  };
}
