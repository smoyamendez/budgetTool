-- The whole budget (pay schedule, bills, debts, payments) as one JSON document.
CREATE TABLE budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per bank or imported payment, stored in Plaid's transaction shape.
CREATE TABLE transactions (
  transaction_id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX transactions_month ON transactions (month);

-- Plaid connections. Access tokens are encrypted with TOKEN_ENCRYPTION_KEY.
CREATE TABLE plaid_items (
  item_id TEXT PRIMARY KEY,
  access_token_enc TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  accounts TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  last_synced TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Signed-in devices. Only a hash of each session token is kept.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Recent sign-in attempts, used to slow down password guessing.
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX login_attempts_at ON login_attempts (at);
