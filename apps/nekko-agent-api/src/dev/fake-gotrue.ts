import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * A stand-in for Supabase Auth (GoTrue) with the same REST shapes the apps
 * use: email codes (`/otp`, `/verify`), OAuth with PKCE (`/authorize`,
 * `/token?grant_type=pkce`) and the JWKS. For the local dev stack and tests
 * only; production signs in against the real Supabase project.
 *
 * Codes are printed to the console (or fixed with `code`), and every OAuth
 * provider signs in at once as `<provider>-dev@example.com`.
 */
export async function fakeGoTrue(app: FastifyInstance, opts: { baseUrl: () => string; code?: string; log?: (line: string) => void }) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "dev", alg: "ES256", use: "sig" }] };
  const codes = new Map<string, string>();
  const grants = new Map<string, { email: string; challenge: string }>();
  const log = opts.log ?? ((line: string) => console.log(line));
  const subject = (email: string) => {
    const h = createHash("sha256").update(email.toLowerCase()).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const session = async (email: string) => {
    const sub = subject(email);
    const access_token = await new SignJWT({ email, role: "authenticated", is_anonymous: false, aal: "aal1", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }], user_metadata: { email_verified: true } })
      .setProtectedHeader({ alg: "ES256", kid: "dev" })
      .setSubject(sub)
      .setIssuer(`${opts.baseUrl()}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    return { access_token, token_type: "bearer", expires_in: 3600, refresh_token: randomBytes(16).toString("hex"), user: { id: sub, email } };
  };

  app.get("/auth/v1/.well-known/jwks.json", async () => jwks);

  app.post("/auth/v1/otp", async (req, reply) => {
    const email = String((req.body as { email?: unknown })?.email ?? "").trim();
    if (!plausibleEmail(email)) return reply.code(400).send({ msg: "Unable to validate email address: invalid format" });
    const code = opts.code ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
    codes.set(email.toLowerCase(), code);
    log(`[fake supabase] sign-in code for ${email}: ${code}`);
    return {};
  });

  app.post("/auth/v1/verify", async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; token?: string; type?: string };
    const email = String(b.email ?? "").trim();
    if (b.type !== "email" || !email || codes.get(email.toLowerCase()) !== b.token) {
      return reply.code(403).send({ code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
    }
    codes.delete(email.toLowerCase());
    return session(email);
  });

  app.get("/auth/v1/authorize", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.provider || !q.redirect_to || !q.code_challenge || (q.code_challenge_method ?? "").toLowerCase() !== "s256") {
      return reply.code(400).send({ msg: "provider, redirect_to and an S256 code_challenge are required" });
    }
    const code = randomBytes(16).toString("hex");
    grants.set(code, { email: `${q.provider}-dev@example.com`, challenge: q.code_challenge });
    const to = new URL(q.redirect_to);
    to.searchParams.set("code", code);
    return reply.redirect(to.toString());
  });

  app.post("/auth/v1/token", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const b = (req.body ?? {}) as { auth_code?: string; code_verifier?: string };
    const grant = b.auth_code ? grants.get(b.auth_code) : undefined;
    const challenge = createHash("sha256").update(String(b.code_verifier ?? "")).digest("base64url");
    if (q.grant_type !== "pkce" || !grant || grant.challenge !== challenge) {
      return reply.code(400).send({ code: 400, error_code: "bad_code_verifier", msg: "invalid flow state" });
    }
    grants.delete(b.auth_code!);
    return session(grant.email);
  });

  return { jwks };
}

/** `local@domain.tld` with no spaces, checked without a backtracking regex. */
function plausibleEmail(email: string): boolean {
  if (email.length > 320 || /\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0]) return false;
  const dot = parts[1].lastIndexOf(".");
  return dot > 0 && dot < parts[1].length - 1;
}
