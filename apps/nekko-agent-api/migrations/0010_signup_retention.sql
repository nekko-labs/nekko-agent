-- Retention for signups (privacy policy: unconfirmed sign-ups deleted 30 days after
-- their confirmation email, unsubscribed ones removed promptly).
--
-- email_suppressions: who asked never to be emailed again. Only a SHA-256 of
--   the lowercased address, so the list can't be read back as addresses but
--   still stops a later email to the same one. Kept when the signup row is
--   deleted, which is what the opt-out record is for. Removed by hand only, on
--   the person's own request to hello@nekkoagent.com.

create table email_suppressions (
  email_hash  text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now()
);

-- used_unsubscribe_tokens: hashes of unsubscribe links already used, so
-- clicking one again (after its row is gone) still shows "unsubscribed"
-- rather than an error. Holds no address.
create table used_unsubscribe_tokens (
  token_hash  text primary key,
  created_at  timestamptz not null default now()
);
