// Small JSON-file store. Payday is a single-person app that runs on your own
// computer, so plain files in DATA_DIR are enough and easy to back up.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

/** One imported or synced payment, in Plaid's transaction shape. Positive amount = money out. */
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

/** Transactions grouped by month ("2026-10"), the same layout the app uses. */
export interface TxnStore { months: Record<string, Txn[]> }

export interface PlaidItem {
  item_id: string;
  access_token: string;
  institution_name: string;
  accounts: Record<string, string>;
  cursor: string | null;
  last_synced: string | null;
  error: string | null;
}
export interface PlaidStore { items: PlaidItem[] }

type BudgetState = Record<string, unknown>;

const files = {
  budget: 'budget.json',
  transactions: 'transactions.json',
  plaid: 'plaid.json',
} as const;

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Writes go to a temp file first, then replace the real one, so a crash never leaves half a file.
// Calls are queued so two saves can't interleave.
let queue: Promise<unknown> = Promise.resolve();
function writeJson(name: string, value: unknown, secret = false): Promise<void> {
  const run = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(DATA_DIR, name);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: secret ? 0o600 : 0o644 });
    await fs.rename(tmp, file);
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export const store = {
  getBudget: () => readJson<BudgetState | null>(files.budget, null),
  putBudget: (s: BudgetState) => writeJson(files.budget, s),

  getTxns: () => readJson<TxnStore>(files.transactions, { months: {} }),
  putTxns: (t: TxnStore) => writeJson(files.transactions, t),

  getPlaid: () => readJson<PlaidStore>(files.plaid, { items: [] }),
  putPlaid: (p: PlaidStore) => writeJson(files.plaid, p, true),
};

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Insert or replace transactions by id, keeping each month sorted by date. */
export function upsertTxns(t: TxnStore, incoming: Txn[]): number {
  let added = 0;
  const byId = new Map<string, string>();
  for (const [m, list] of Object.entries(t.months)) for (const x of list) byId.set(x.transaction_id, m);
  for (const x of incoming) {
    const prevMonth = byId.get(x.transaction_id);
    if (prevMonth) t.months[prevMonth] = t.months[prevMonth].filter((y) => y.transaction_id !== x.transaction_id);
    else added++;
    const m = monthOf(x.date);
    (t.months[m] ||= []).push(x);
    byId.set(x.transaction_id, m);
  }
  for (const m of Object.keys(t.months)) t.months[m].sort((a, b) => a.date.localeCompare(b.date));
  return added;
}

export function removeTxns(t: TxnStore, ids: Set<string>): void {
  for (const m of Object.keys(t.months)) {
    t.months[m] = t.months[m].filter((x) => !ids.has(x.transaction_id));
    if (!t.months[m].length) delete t.months[m];
  }
}
