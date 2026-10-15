# Payday

A personal budget app built around your pay cycle instead of the calendar month. Every bill is assigned to the paycheck that pays it. Debt payoff comes next, and the totals use what you actually paid. Bank and card transactions come in through Plaid, or from a CSV file your bank lets you download.

- **App:** plain HTML in `public/`, hosted free on GitHub Pages. Add it to your phone's home screen and it opens like an app.
- **Backend:** a Cloudflare Worker in `worker/`, with your data in a Cloudflare D1 database. Free tier, always on.
- **Banks:** Plaid, called only from the Worker so your Plaid secret never reaches the browser.

```
Phone / laptop  ──►  GitHub Pages (the app)
       │
       └── API calls with your sign-in ──►  Cloudflare Worker  ──►  D1 database
                                                   └──────────────►  Plaid
```

## What it does

- **Paycheck view.** Shows what's left from each paycheck after its bills. Bills land on the last paycheck before they're due, and you can move them.
- **Look-ahead.** If a later paycheck can't cover its bills, the one before it tells you how much to set aside.
- **Static and variable bills.** Variable bills use an estimate until you enter the real amount.
- **Real amounts.** When you mark a bill paid you record what you actually paid. Monthly totals compare paid against planned.
- **Bank matching.** Plaid transactions and imported CSV payments are matched to bills. Review the matches and link them in one tap. When a pending charge posts, its link follows it.
- **Daily sync.** The Worker pulls new transactions every morning, and again whenever you open the app.
- **Debt payoff plan.** Pay the highest interest first or the smallest balance first, with a debt-free date.

## Set it up

You'll do this once, on a computer. You need [Node.js](https://nodejs.org) 20 or newer, a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, and a free [Plaid](https://dashboard.plaid.com) account.

### 1. Get the code

```bash
git clone https://github.com/smoyamendez/budgetTool.git
cd budgetTool
npm install
npx wrangler login
```

`wrangler login` opens your browser so you can allow access to your Cloudflare account.

### 2. Create the database

```bash
npx wrangler d1 create payday
```

It prints a `database_id`. Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with it. Then create the tables:

```bash
npm run db:migrate
```

### 3. Add your secrets

Each command asks you to paste a value. Secrets are stored encrypted by Cloudflare and never go in the code.

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
```

- **APP_PASSWORD** is what you'll type to sign in. Use something long.
- **TOKEN_ENCRYPTION_KEY** encrypts your bank connections in the database. Make one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  Save a copy somewhere safe, like a password manager. If it's lost or changed, you'll have to reconnect your banks.
- **PLAID_CLIENT_ID** and **PLAID_SECRET** come from the Plaid dashboard under **Developers → Keys**. Start with the Sandbox secret.

If wrangler asks whether to create the Worker first, say yes.

### 4. Deploy the backend

```bash
npm run deploy
```

It prints your Worker's address, something like `https://payday-api.yourname.workers.dev`. Copy it.

### 5. Publish the app on GitHub Pages

In this repo on GitHub:

1. **Settings → Pages.** Under "Build and deployment", set Source to **GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables tab → New repository variable.** Name it `PAYDAY_API_URL` and paste your Worker address.
3. Commit the `wrangler.toml` change from step 2 and push to `main`.

The "Deploy app to GitHub Pages" action runs and publishes the app at **https://smoyamendez.github.io/budgetTool/**.

### 6. Put it on your phone

Open that address in Safari (iPhone) or Chrome (Android) and sign in. Then:

- **iPhone:** tap Share, then **Add to Home Screen**.
- **Android:** tap the menu, then **Add to Home screen** or **Install app**.

## Plaid

**Testing.** With `PLAID_ENV = "sandbox"` in `wrangler.toml`, go to **Settings → Connect a bank or card**, pick any bank and sign in with `user_good` / `pass_good`.

**Your real accounts.** Apply for Plaid's free Trial plan from the dashboard home page (or dashboard.plaid.com/trial-plan). Once approved:

```bash
npx wrangler secret put PLAID_SECRET     # paste your Production secret
```

Then set `PLAID_ENV = "production"` in `wrangler.toml` and deploy again. The Trial plan allows 10 bank connections in total, and removing one doesn't give the slot back. If a connection breaks, use **Sign in again** instead of removing it.

**Banks that sign in on their own website (OAuth),** like Chase. In the Plaid dashboard go to **Developers → API → Allowed redirect URIs** and add `https://smoyamendez.github.io/budgetTool/`. Then:

```bash
npx wrangler secret put PLAID_REDIRECT_URI   # https://smoyamendez.github.io/budgetTool/
```

## Automatic deploys (optional)

The "Deploy backend to Cloudflare" action deploys the Worker whenever you push changes to `worker/`, `migrations/` or `wrangler.toml` to `main`. It skips itself until you add two repository **secrets** under Settings → Secrets and variables → Actions:

- `CLOUDFLARE_ACCOUNT_ID`: in the Cloudflare dashboard, on the Workers & Pages overview page.
- `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → Create Token. Start from the **Edit Cloudflare Workers** template and add **Account → D1 → Edit**.

## Security

- Every API call needs a sign-in. The Worker keeps only a hash of each session token, and sessions last 60 days.
- Five wrong passwords from one network, or 20 overall, lock sign-in for 15 minutes.
- Plaid access tokens are encrypted with AES-GCM before they're stored.
- The API only accepts requests from the websites listed in `ALLOWED_ORIGINS` in `wrangler.toml`.
- **Settings → Sign out on all devices** ends every session if you lose a phone.
- Your sign-in token is kept in the browser's local storage on each device you use.

## Work on it locally

```bash
cp .dev.vars.example .dev.vars     # fill in a password, key and Plaid sandbox keys
npm run db:migrate:local
npm run dev
```

Open http://localhost:8787. The Worker serves the app itself, so no separate web server is needed.

## Project layout

```
public/                The app: index.html, config.js, manifest and icons
worker/src/index.ts    Routes, CORS and the daily sync
worker/src/auth.ts     Sign-in, sessions, rate limiting
worker/src/plaid.ts    Plaid Link, token exchange, /transactions/sync
worker/src/store.ts    D1 reads and writes
worker/src/crypto.ts   Hashing and token encryption
migrations/            Database tables
.github/workflows/     GitHub Pages and Cloudflare deploys
```

### API

All routes except `/api/login` need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/login` | Sign in with `{ password }`, returns `{ token }` |
| POST | `/api/logout`, `/api/logout-everywhere` | Sign out this device, or all of them |
| GET / PUT | `/api/state` | Read or save the whole budget |
| GET | `/api/transactions` | All payments, grouped by month |
| PUT / DELETE | `/api/transactions/month/:YYYY-MM` | Add imported payments to a month, or clear it |
| GET | `/api/plaid/status` | Whether Plaid is set up, and your connections |
| POST | `/api/plaid/link-token` | Start Plaid Link (send `item_id` to fix a broken sign-in) |
| POST | `/api/plaid/exchange` | Save a new connection and run the first sync |
| POST | `/api/plaid/sync` | Pull new, changed and removed transactions |
| DELETE | `/api/plaid/items/:id` | Remove a connection |

## Ideas for next

- Fill in credit card balances, APRs and minimums from Plaid Liabilities.
- Learn each variable bill's estimate from the last few months of real amounts.
- Work offline on the phone and catch up when back online.
