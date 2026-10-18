import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Plan } from './entitlements.js';

/**
 * File-backed account + token store. Mirrors the host's "JSON in the data dir"
 * approach (no native DB dep) behind a small interface so a Postgres-backed
 * impl can drop in for production Nekko Cloud without touching callers.
 */
export interface Account {
  id: string;
  email: string;
  plan: Plan;
  /** scrypt hash, stored as `salt:hash` hex. Never leaves the server. */
  passwordHash: string;
  createdAt: number;
  /** Stripe customer id, set once the account starts a checkout/subscription. */
  stripeCustomerId?: string;
}

/** The account shape safe to return to a client (no secrets). */
export type PublicAccount = Pick<Account, 'id' | 'email' | 'plan' | 'createdAt'>;

interface Token {
  accountId: string;
  createdAt: number;
}

interface CloudData {
  accounts: Account[];
  tokens: Record<string, Token>;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function publicAccount(a: Account): PublicAccount {
  return { id: a.id, email: a.email, plan: a.plan, createdAt: a.createdAt };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class CloudStore {
  private readonly file: string;
  private readonly accountsDir: string;
  private data: CloudData;

  constructor(private readonly root: string) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    this.accountsDir = join(root, 'accounts');
    if (!existsSync(this.accountsDir)) mkdirSync(this.accountsDir, { recursive: true });
    this.file = join(root, 'cloud.json');
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as CloudData)
      : { accounts: [], tokens: {} };
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Per-account data dir, handed to `withDataDir`/`createHost` for isolation. */
  dataDirFor(accountId: string): string {
    return join(this.accountsDir, accountId);
  }

  findByEmail(email: string): Account | undefined {
    const e = email.trim().toLowerCase();
    return this.data.accounts.find((a) => a.email === e);
  }

  get(accountId: string): Account | undefined {
    return this.data.accounts.find((a) => a.id === accountId);
  }

  findByStripeCustomer(customerId: string): Account | undefined {
    return this.data.accounts.find((a) => a.stripeCustomerId === customerId);
  }

  /** Create an account; throws on bad email, weak password, or duplicate. */
  signup(email: string, password: string): Account {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new Error('Enter a valid email address.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    if (this.findByEmail(e)) throw new Error('An account with that email already exists.');
    const account: Account = {
      id: randomUUID(),
      email: e,
      plan: 'free',
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
    };
    this.data.accounts.push(account);
    this.save();
    return account;
  }

  /** Verify credentials and mint a session token. Throws on failure. */
  login(email: string, password: string): { token: string; account: Account } {
    const account = this.findByEmail(email);
    if (!account || !verifyPassword(password, account.passwordHash)) {
      throw new Error('Incorrect email or password.');
    }
    const token = randomBytes(32).toString('hex');
    this.data.tokens[token] = { accountId: account.id, createdAt: Date.now() };
    this.save();
    return { token, account };
  }

  /** Resolve a bearer token to its account, or undefined if invalid. */
  verifyToken(token: string | undefined): Account | undefined {
    if (!token) return undefined;
    const t = this.data.tokens[token];
    return t ? this.get(t.accountId) : undefined;
  }

  logout(token: string | undefined): void {
    if (token && this.data.tokens[token]) {
      delete this.data.tokens[token];
      this.save();
    }
  }

  /** Change an account's plan (driven by Stripe webhooks; see billing.ts). */
  setPlan(accountId: string, plan: Plan): Account | undefined {
    const account = this.get(accountId);
    if (account) {
      account.plan = plan;
      this.save();
    }
    return account;
  }

  /** Remember the Stripe customer so later subscription events map back to the account. */
  setStripeCustomer(accountId: string, customerId: string): Account | undefined {
    const account = this.get(accountId);
    if (account && account.stripeCustomerId !== customerId) {
      account.stripeCustomerId = customerId;
      this.save();
    }
    return account;
  }
}
