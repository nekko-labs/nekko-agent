import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export const CONFIRM_FROM = "Nekko Agent <hello@mail.nekkoagent.com>";
export const CONFIRM_REPLY_TO = "hello@nekkoagent.com";
export const CONFIRM_SUBJECT = "Confirm you want to join the Nekko Agent beta";
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
  const { rows } = await db.query<{ email: string; name: string | null; unsubscribe_token: string; prev: string | null }>(
    `update signups s set
       confirm_token_hash = $2,
       confirm_expires_at = now() + make_interval(days => ${LINK_DAYS}),
       confirmation_sent_at = now()
     from (select confirmation_sent_at as prev from signups where id = $1) old
     where s.id = $1 and s.status = 'pending'
       and (s.confirmation_sent_at is null or s.confirmation_sent_at < now() - interval '1 day')
     returning s.email, s.name, s.unsubscribe_token, old.prev`,
    [signupId, hashToken(token)],
  );
  const row = rows[0];
  if (!row) return false;
  const base = publicUrl.replace(/\/$/, "");
  const confirm = `${base}/v1/signups/confirm?token=${token}`;
  const unsubscribe = `${base}/v1/signups/unsubscribe?token=${row.unsubscribe_token}`;
  try {
    await mailer({ to: row.email, subject: CONFIRM_SUBJECT, ...confirmationBody(row.name, confirm, unsubscribe), headers: unsubscribeHeaders(unsubscribe) });
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

function confirmationBody(name: string | null, confirm: string, unsubscribe: string) {
  const hi = name ? `Hi ${name},` : "Hi,";
  const text = `${hi}

Thanks for signing up for the Nekko Agent beta. Please confirm it was you:

${confirm}

The link works once and expires in ${LINK_DAYS} days. If you didn't sign up, ignore this email and we won't write again.

Unsubscribe: ${unsubscribe}

Nekko Labs LLC · hello@nekkoagent.com`;
  const html = `<!doctype html><html><body style="margin:0;background:#fbfaff;font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',sans-serif;color:#17151f">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="font-size:20px;font-weight:700;color:#453a92;margin:0 0 24px">Nekko Agent</p>
<p>${escape(hi)}</p>
<p>Thanks for signing up for the Nekko Agent beta. Please confirm it was you:</p>
<p style="margin:28px 0"><a href="${escape(confirm)}" style="background:linear-gradient(115deg,#453a92,#9d8ce6);color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px;display:inline-block">Confirm I want to join</a></p>
<p style="color:#5d5970;font-size:14px">The link works once and expires in ${LINK_DAYS} days. If you didn't sign up, ignore this email and we won't write again.</p>
<p style="color:#5d5970;font-size:12px;margin-top:32px">Nekko Labs LLC · <a href="mailto:hello@nekkoagent.com" style="color:#5d5970">hello@nekkoagent.com</a> · <a href="${escape(unsubscribe)}" style="color:#5d5970">Unsubscribe</a></p>
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

/** Unsubscribes the row the token belongs to. Idempotent; false for an unknown token. */
export async function unsubscribe(db: Db, token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const { rows } = await db.query(
    `update signups set
       status = 'unsubscribed',
       updated_at = case when status = 'unsubscribed' then updated_at else now() end,
       confirm_token_hash = null, confirm_expires_at = null
     where unsubscribe_token = $1
     returning id`,
    [token],
  );
  return rows.length > 0;
}

/** The small branded page the confirm and unsubscribe links land on. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Nekko Agent</title>
<style>
:root{--ink:#17151f;--muted:#5d5970;--bg:#fbfaff;--accent:#453a92}
@media (prefers-color-scheme:dark){:root{--ink:#f3f1fb;--muted:#aaa5bf;--bg:#121019;--accent:#9d8ce6}}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:460px;padding:32px 20px;text-align:center}
h1{font-size:28px;margin:0 0 12px;background:linear-gradient(110deg,#453a92,#9d8ce6);-webkit-background-clip:text;background-clip:text;color:transparent}
p{color:var(--muted);line-height:1.5}a{color:var(--accent)}
</style></head><body><main><h1>${escape(title)}</h1>${body}<p><a href="https://nekkoagent.com">nekkoagent.com</a></p></main></body></html>`;
}
