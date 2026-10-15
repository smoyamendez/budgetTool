# Payday

A personal budget app built around your pay cycle instead of the calendar month. Every bill is assigned to the paycheck that pays it. Debt payoff comes next, and the totals use what you actually paid. Bank and card transactions come in through Plaid, or from a CSV file your bank lets you download.

It runs on your own computer. Your Plaid keys, bank connections and budget never leave it, except for the calls Payday makes to Plaid.

## What it does

- **Paycheck view.** Shows what's left from each paycheck after its bills. Bills land on the last paycheck before they're due, and you can move them.
- **Look-ahead.** If a later paycheck can't cover its bills, the one before it tells you how much to set aside.
- **Static and variable bills.** Variable bills use an estimate until you enter the real amount.
- **Real amounts.** When you mark a bill paid you record what you actually paid. Monthly totals compare paid against planned.
- **Bank matching.** Plaid transactions and imported CSV payments are matched to bills. Review the matches and link them in one tap. When a pending charge posts, its link follows it.
- **Debt payoff plan.** Pay the highest interest first or the smallest balance first, with a debt-free date.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/smoyamendez/budgetTool.git
cd budgetTool
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. The app works without Plaid; you can add bills and import CSV files right away.

### Connect Plaid

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com).
2. Go to **Developers → Keys** and copy your `client_id` and your **Sandbox** secret.
3. Put them in `.env`:
   ```
   PLAID_CLIENT_ID=your_client_id
   PLAID_SECRET=your_sandbox_secret
   PLAID_ENV=sandbox
   ```
4. Restart the server (`npm start`), open **Settings → Connect a bank or card**.
5. In Sandbox, pick any test bank and sign in with `user_good` / `pass_good`.

### Use your real accounts

Sandbox only has fake banks. To connect your real accounts, request Production access in the Plaid dashboard, then switch `.env` to your Production secret and set `PLAID_ENV=production`. Check Plaid's current pricing and approval steps in the dashboard before you do.

Some banks sign you in on their own website (OAuth). Those need a redirect URI registered in the Plaid dashboard and set as `PLAID_REDIRECT_URI` in `.env`. See [Plaid's OAuth guide](https://plaid.com/docs/link/oauth/) for what each environment accepts.

## Your data

Everything is saved as JSON in the `data/` folder (or wherever `DATA_DIR` points):

| File | What's in it |
| --- | --- |
| `budget.json` | Pay schedule, bills, debts, what you paid |
| `transactions.json` | Payments from Plaid and CSV imports, grouped by month |
| `plaid.json` | Your bank connections, including Plaid access tokens. Treat it like a password. |

`data/` and `.env` are in `.gitignore`, so they never get committed. Back up `data/` if you want to keep your history.

The server only listens on `127.0.0.1`, so other devices on your network can't reach it, and it rejects write requests that come from other websites.

## Project layout

```
public/index.html      The app (plain HTML, CSS and JavaScript, no build step)
server/src/index.ts    Express server: budget, transactions and Plaid routes
server/src/plaid.ts    Plaid Link tokens, token exchange, /transactions/sync
server/src/store.ts    JSON file storage with safe writes
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET / PUT | `/api/state` | Read or save the whole budget |
| GET | `/api/transactions` | All payments, grouped by month |
| PUT / DELETE | `/api/transactions/month/:YYYY-MM` | Replace or clear one month (used by CSV import) |
| GET | `/api/plaid/status` | Whether Plaid is set up, and your connections |
| POST | `/api/plaid/link-token` | Start Plaid Link (send `item_id` to fix a broken sign-in) |
| POST | `/api/plaid/exchange` | Save a new connection and run the first sync |
| POST | `/api/plaid/sync` | Pull new, changed and removed transactions |
| DELETE | `/api/plaid/items/:id` | Remove a connection |

## Scripts

- `npm start` runs the server.
- `npm run dev` runs it and restarts when you change server code.
- `npm run typecheck` checks the TypeScript.

## Ideas for next

- Fill in credit card balances, APRs and minimums from Plaid Liabilities.
- Learn each variable bill's estimate from the last few months of real amounts.
- A small "move my data over" import for the earlier prototype.
