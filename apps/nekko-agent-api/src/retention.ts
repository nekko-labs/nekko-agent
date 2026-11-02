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
 * pending signups not confirmed within 30 days of their last confirmation
 * email (never one that wasn't emailed: the person must have had the chance
 * to confirm), and any signup marked
 * unsubscribed (its address goes on the suppression list first, so it is
 * never emailed again). Confirmed, invited and joined rows are never touched.
 */
export async function purgeSignups(db: Db): Promise<{ unconfirmed: number; unsubscribed: number }> {
  return db.transaction(async (tx) => {
    const unsub = await tx.query<{ email: string }>("select email from signups where status = 'unsubscribed'", []);
    for (const { email } of unsub.rows) {
      await tx.query("insert into email_suppressions (email_hash) values ($1) on conflict do nothing", [emailHash(email)]);
    }
    const u = await tx.query("delete from signups where status = 'unsubscribed' returning id", []);
    const p = await tx.query(
      `delete from signups
       where status = 'pending' and confirmed_at is null
         and confirmation_sent_at < now() - make_interval(days => ${UNCONFIRMED_DAYS})
       returning id`,
      [],
    );
    return { unconfirmed: p.rows.length, unsubscribed: u.rows.length };
  });
}
