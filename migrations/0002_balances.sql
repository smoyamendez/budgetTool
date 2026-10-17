-- Latest balance of each account in a Plaid connection, keyed by account_id.
ALTER TABLE plaid_items ADD COLUMN balances TEXT NOT NULL DEFAULT '{}';
