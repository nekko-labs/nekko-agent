-- Retrying confirmation emails that failed.
--
-- signups.confirmation_failed_at: when the first try to send this row's
--   confirmation email failed (Resend down or refusing the address). Set once
--   and kept while the row has never been emailed. The hourly retry job sends
--   to every pending row that was never emailed; one that still fails 30 days
--   after its first failure is deleted, so an address that can't be emailed is
--   not kept forever.

alter table signups add column confirmation_failed_at timestamptz;

create index signups_never_emailed_idx on signups (created_at)
  where status = 'pending' and confirmation_sent_at is null;
