import { createLocalJWKSet, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/**
 * Who a Supabase access token says the caller is. Supabase Auth only proves
 * identity here: the account, plan and tokens live in this service's own
 * database, and Supabase never sees a synced byte.
 */
export interface SupabaseIdentity {
  subject: string;
  email: string;
  /**
   * The email was proven: this session was signed in with a code or link sent
   * to it, or Supabase Auth's own record of the user says the address is
   * confirmed (`email_confirmed_at`). Never from `user_metadata`, which the
   * user can write. Only a verified email can claim
   * an existing account (a beta signup's) or move an account to a new address.
   */
  emailVerified: boolean;
}

export type VerifyAccessToken = (token: string) => Promise<SupabaseIdentity>;

export class InvalidSession extends Error {}

export interface SupabaseConfig {
  /** The project URL, e.g. https://abcd.supabase.co. Tokens must be issued by `${url}/auth/v1`. */
  url: string;
  /**
   * Legacy HS256 projects only: the JWT secret. Projects on asymmetric signing
   * keys (the default since 2025) are verified against their public JWKS and
   * need no secret here.
   */
  jwtSecret?: string;
  /** Tests: a fixed key set instead of the project's JWKS endpoint. */
  jwks?: { keys: unknown[] };
  /** The project's public anon / publishable key, sent with the user lookup. */
  anonKey?: string;
  /** Tests: the auth user lookup (`GET /auth/v1/user` with the session). */
  fetchUser?: (token: string) => Promise<AuthUser | null>;
}

/** The fields of Supabase Auth's user record that matter here. */
export interface AuthUser {
  id?: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}

/** Supabase Auth's record of the session's user, or null when it can't be read. */
function authUserFetcher(base: string, anonKey: string | undefined): (token: string) => Promise<AuthUser | null> {
  return async (token) => {
    try {
      const res = await fetch(`${base}/auth/v1/user`, {
        headers: { authorization: `Bearer ${token}`, ...(anonKey ? { apikey: anonKey } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? ((await res.json()) as AuthUser) : null;
    } catch {
      return null;
    }
  };
}

/**
 * Verifies a Supabase access token: signature (the project's JWKS, or the
 * legacy secret), issuer, audience `authenticated`, expiry, a real (not
 * anonymous) user with an email.
 */
export function supabaseVerifier(cfg: SupabaseConfig): VerifyAccessToken {
  const base = cfg.url.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const key: JWTVerifyGetKey | Uint8Array = cfg.jwtSecret
    ? new TextEncoder().encode(cfg.jwtSecret)
    : cfg.jwks
      ? createLocalJWKSet(cfg.jwks as never)
      : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cacheMaxAge: 10 * 60 * 1000 });
  const algorithms = cfg.jwtSecret ? ["HS256"] : ["ES256", "RS256"];
  const fetchUser = cfg.fetchUser ?? authUserFetcher(base, cfg.anonKey);

  return async (token) => {
    let payload: JWTPayload & { email?: unknown; is_anonymous?: unknown; role?: unknown; user_metadata?: unknown; amr?: unknown };
    try {
      ({ payload } = await jwtVerify(token, key as never, { issuer, audience: "authenticated", algorithms, clockTolerance: 30 }));
    } catch {
      throw new InvalidSession("The sign-in didn't verify. Sign in again.");
    }
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    if (!payload.sub || payload.is_anonymous === true || payload.role !== "authenticated" || !email) {
      throw new InvalidSession("Sign in with an email address or a linked account.");
    }
    const amr = Array.isArray(payload.amr) ? payload.amr : [];
    const byEmail = amr.some((m) => ["otp", "magiclink"].includes((m as { method?: unknown })?.method as string));
    if (byEmail) return { subject: payload.sub, email, emailVerified: true };
    // Otherwise ask Supabase Auth whether it confirmed the address (an OAuth
    // provider's verified email, or a confirmed sign-up).
    const user = await fetchUser(token);
    const confirmed = !!user && user.id === payload.sub && !!user.email_confirmed_at
      && typeof user.email === "string" && user.email.trim().toLowerCase() === email.toLowerCase();
    return { subject: payload.sub, email, emailVerified: confirmed };
  };
}
