import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { emailHash, isSuppressed } from "./retention.js";

export const CONFIRM_FROM = "Nekko Agent <hello@mail.nekkoagent.com>";
export const CONFIRM_REPLY_TO = "hello@nekkoagent.com";
export const CONFIRM_SUBJECT = "Confirm you want to join the Nekko Agent beta";

/** What the confirmation says per list: the website's beta form, or the app's setup wizard. */
const COPY: Record<string, { subject: string; line: string; button: string }> = {
  beta: { subject: CONFIRM_SUBJECT, line: "Thanks for signing up for the Nekko Agent beta.", button: "Confirm I want to join" },
  app: {
    subject: "Confirm your email for Nekko Agent updates",
    line: "Thanks for asking for Nekko Agent updates: at most one email a month about new features and important fixes.",
    button: "Confirm my email",
  },
};
const copyFor = (list: string) => COPY[list] ?? COPY.beta;
const LINK_DAYS = 7;

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** Sends one email; throws on failure. */
export type Mailer = (email: Email) => Promise<void>;

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export function resendMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
  return async (email) => {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: CONFIRM_FROM,
        reply_to: CONFIRM_REPLY_TO,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
      }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Sends the confirmation email for a pending signup, unless one went out in
 * the last day. Claims the send in the database first (one statement), so two
 * signups at once can't both send. A failed send releases the claim.
 * Returns whether an email was sent.
 */
export async function sendConfirmation(
  db: Db,
  signupId: string,
  mailer: Mailer | undefined,
  publicUrl: string,
  log: (msg: string) => void = console.log,
): Promise<boolean> {
  if (!mailer) {
    log("RESEND_API_KEY not set: signup saved, confirmation email skipped.");
    return false;
  }
  const token = randomBytes(32).toString("base64url");
  // Never email an address that unsubscribed. A failed check throws, so it
  // sends nothing rather than risk it.
  const target = await db.query<{ email: string }>("select email from signups where id = $1", [signupId]);
  if (!target.rows[0] || (await isSuppressed(db, target.rows[0].email))) return false;
  const { rows } = await db.query<{ email: string; name: string | null; list: string; unsubscribe_token: string; prev: string | null }>(
    `update signups s set
       confirm_token_hash = $2,
       confirm_expires_at = now() + make_interval(days => ${LINK_DAYS}),
       confirmation_sent_at = now()
     from (select confirmation_sent_at as prev from signups where id = $1) old
     where s.id = $1 and s.status = 'pending'
       and (s.confirmation_sent_at is null or s.confirmation_sent_at < now() - interval '1 day')
     returning s.email, s.name, s.list, s.unsubscribe_token, old.prev`,
    [signupId, hashToken(token)],
  );
  const row = rows[0];
  if (!row) return false;
  const base = publicUrl.replace(/\/$/, "");
  const confirm = `${base}/v1/signups/confirm?token=${token}`;
  const unsubscribe = `${base}/v1/signups/unsubscribe?token=${row.unsubscribe_token}`;
  try {
    const copy = copyFor(row.list);
    await mailer({ to: row.email, subject: copy.subject, ...confirmationBody(row.name, copy, confirm, unsubscribe), headers: unsubscribeHeaders(unsubscribe) });
    return true;
  } catch (e) {
    await db.query(
      "update signups set confirm_token_hash = null, confirm_expires_at = null, confirmation_sent_at = $2 where id = $1",
      [signupId, row.prev],
    );
    throw e;
  }
}

/** RFC 8058 one-click unsubscribe, so mail apps can show their own Unsubscribe button. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

function confirmationBody(name: string | null, copy: { line: string; button: string }, confirm: string, unsubscribe: string) {
  const hi = name ? `Hi ${name},` : "Hi,";
  const text = `${hi}

${copy.line} Please confirm it was you:

${confirm}

The link works once and expires in ${LINK_DAYS} days. If you didn't sign up, ignore this email and we won't write again.

Unsubscribe: ${unsubscribe}

Nekko Labs LLC · hello@nekkoagent.com`;
  const html = `<!doctype html><html><body style="margin:0;background:#fbf6f8;font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',sans-serif;color:#000000">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="font-size:20px;font-weight:700;color:#5a2352;margin:0 0 24px">Nekko Agent</p>
<p>${escape(hi)}</p>
<p>${escape(copy.line)} Please confirm it was you:</p>
<p style="margin:28px 0"><a href="${escape(confirm)}" style="background:linear-gradient(115deg,#190019,#3a1438);color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px;display:inline-block">${escape(copy.button)}</a></p>
<p style="color:#52525e;font-size:14px">The link works once and expires in ${LINK_DAYS} days. If you didn't sign up, ignore this email and we won't write again.</p>
<p style="color:#52525e;font-size:12px;margin-top:32px">Nekko Labs LLC · <a href="mailto:hello@nekkoagent.com" style="color:#52525e">hello@nekkoagent.com</a> · <a href="${escape(unsubscribe)}" style="color:#52525e">Unsubscribe</a></p>
</div></body></html>`;
  return { html, text };
}

export type ConfirmResult = "confirmed" | "invalid";

/** Uses a confirm token once. An expired, used or unknown token is "invalid". */
export async function confirmSignup(db: Db, token: string): Promise<ConfirmResult> {
  if (!token || token.length > 100) return "invalid";
  const { rows } = await db.query(
    `update signups set status = 'confirmed', confirmed_at = now(), updated_at = now(),
       confirm_token_hash = null, confirm_expires_at = null
     where confirm_token_hash = $1 and confirm_expires_at > now() and status = 'pending'
     returning id`,
    [hashToken(token)],
  );
  return rows.length ? "confirmed" : "invalid";
}

/**
 * Unsubscribes the address the token belongs to: puts it on the suppression
 * list and deletes its signup row, in one transaction (both or neither).
 * Idempotent: an already-used token answers true. False for an unknown token.
 */
export async function unsubscribe(db: Db, token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ email: string }>("select email from signups where unsubscribe_token = $1", [token]);
    if (!rows.length) {
      const used = await tx.query("select 1 from used_unsubscribe_tokens where token_hash = $1", [hashToken(token)]);
      return used.rows.length > 0;
    }
    await tx.query("insert into email_suppressions (email_hash) values ($1) on conflict do nothing", [emailHash(rows[0].email)]);
    await tx.query("insert into used_unsubscribe_tokens (token_hash) values ($1) on conflict do nothing", [hashToken(token)]);
    // Every list row for the address goes: they asked not to hear from us.
    await tx.query("delete from signups where lower(email) = lower($1)", [rows[0].email]);
    return true;
  });
}

/** The small branded page the confirm and unsubscribe links land on. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Nekko Agent</title>
<style>
:root{--ink:#000000;--muted:#52525e;--bg:#fbf6f8;--accent:#5a2352}
@media (prefers-color-scheme:dark){:root{--ink:#ffffff;--muted:#a3a1b0;--bg:#0c0c11;--accent:#c99bb3}}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:460px;padding:32px 20px;text-align:center}
h1{font-size:28px;margin:0 0 12px;background:linear-gradient(110deg,#5a2352,#c084b5);-webkit-background-clip:text;background-clip:text;color:transparent}
@media (prefers-color-scheme:dark){h1{background-image:linear-gradient(110deg,#854f6c,#e6d0dc)}}
p{color:var(--muted);line-height:1.5}a{color:var(--accent)}
</style></head><body><main><h1>${escape(title)}</h1>${body}<p><a href="https://nekkoagent.com">nekkoagent.com</a></p></main></body></html>`;
}
