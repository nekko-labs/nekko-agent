import { createHash } from "node:crypto";
import type { Db } from "./db.js";

export const UNCONFIRMED_DAYS = 30;

/** The suppression key for an address: SHA-256 of it trimmed and lowercased. */
export const emailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** True when the address asked never to be emailed again. */
export async function isSuppressed(db: Db, email: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from email_suppressions where email_hash = $1", [emailHash(email)]);
  return rows.length > 0;
}

/**
 * Deletes what the privacy policy says we don't keep, in one transaction:
 * - pending signups not confirmed within 30 days of their last confirmation
 *   email;
 * - pending signups never emailed because sending kept failing for 30 days
 *   after the first failure (the hourly retry gives up on them);
 * - any row for an address on the suppression list (saved before signups of
 *   unsubscribed addresses were refused);
 * - any signup marked unsubscribed (its address goes on the suppression list
 *   first, so it is never emailed again).
 * A pending signup never tried (no Resend key yet) is kept for the retry job.
 * Confirmed, invited and joined rows are never touched.
 */
export async function purgeSignups(db: Db): Promise<{ unconfirmed: number; undeliverable: number; suppressed: number; unsubscribed: number }> {
  return db.transaction(async (tx) => {
    const unsub = await tx.query<{ email: string }>("select email from signups where status = 'unsubscribed'", []);
    for (const { email } of unsub.rows) {
      await tx.query("insert into email_suppressions (email_hash) values ($1) on conflict do nothing", [emailHash(email)]);
    }
    const u = await tx.query("delete from signups where status = 'unsubscribed' returning id", []);
    // Suppression holds hashes only, so the match is made here, not in SQL.
    // Only rows never confirmed can carry a suppressed address (unsubscribing
    // deletes every row for it), and those are few.
    const open = await tx.query<{ id: string; email: string }>("select id, email from signups where status = 'pending'", []);
    const hashes = new Set((await tx.query<{ email_hash: string }>("select email_hash from email_suppressions", [])).rows.map((r) => r.email_hash));
    const gone = open.rows.filter((r) => hashes.has(emailHash(r.email))).map((r) => r.id);
    const s = gone.length ? await tx.query("delete from signups where id = any($1::uuid[]) returning id", [gone]) : { rows: [] };
    const p = await tx.query(
      `delete from signups
       where status = 'pending' and confirmed_at is null
         and confirmation_sent_at < now() - make_interval(days => ${UNCONFIRMED_DAYS})
       returning id`,
      [],
    );
    const f = await tx.query(
      `delete from signups
       where status = 'pending' and confirmation_sent_at is null
         and confirmation_failed_at < now() - make_interval(days => ${UNCONFIRMED_DAYS})
       returning id`,
      [],
    );
    return { unconfirmed: p.rows.length, undeliverable: f.rows.length, suppressed: s.rows.length, unsubscribed: u.rows.length };
  });
}

export const FEEDBACK_SCREENSHOT_DAYS = 90;

/** Deletes Send feedback screenshots 90 days after their note arrived; the note itself stays. */
export async function purgeFeedbackScreenshots(db: Db): Promise<number> {
  const { rows } = await db.query(
    `delete from feedback_screenshots s using feedback f
     where s.feedback_id = f.id and f.received_on < current_date - ${FEEDBACK_SCREENSHOT_DAYS}
     returning s.feedback_id`,
    [],
  );
  return rows.length;
}
