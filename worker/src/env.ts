export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  PLAID_ENV: string;
  ALLOWED_ORIGINS: string;
  APP_PASSWORD?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_REDIRECT_URI?: string;
  /** Only for tests against a fake Plaid server. */
  PLAID_BASE_URL?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR') {
    super(message);
  }
}

export const now = () => new Date().toISOString();
