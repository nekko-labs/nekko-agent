import { createLocalJWKSet, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/**
 * Who a Supabase access token says the caller is. Supabase Auth only proves
 * identity here: the account, plan and tokens live in this service's own
 * database, and Supabase never sees a synced byte.
 */
export interface SupabaseIdentity {
  subject: string;
  email: string;
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

  return async (token) => {
    let payload: JWTPayload & { email?: unknown; is_anonymous?: unknown; role?: unknown };
    try {
      ({ payload } = await jwtVerify(token, key as never, { issuer, audience: "authenticated", algorithms, clockTolerance: 30 }));
    } catch {
      throw new InvalidSession("The sign-in didn't verify. Sign in again.");
    }
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    if (!payload.sub || payload.is_anonymous === true || payload.role !== "authenticated" || !email) {
      throw new InvalidSession("Sign in with an email address or a linked account.");
    }
    return { subject: payload.sub, email };
  };
}
