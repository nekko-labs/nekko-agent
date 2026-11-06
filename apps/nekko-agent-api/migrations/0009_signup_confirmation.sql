-- Double opt-in for signups.
--
-- A new signup stays 'pending' until its owner clicks the link in the
-- "Confirm you want to join" email; then it is 'confirmed'.
--
-- confirm_token_hash: SHA-256 of the confirm link's token (the token itself is
--   only ever in the email). Cleared when used, so a link works once. A new
--   email replaces it, so only the latest link works.
-- confirm_expires_at: the link stops working 7 days after it was sent.
-- confirmation_sent_at: when the last confirmation email went out; at most one
--   per address per day.
-- unsubscribe_token: the one-click unsubscribe link's token. Kept as is (not
--   hashed) because every email to the address carries the same link; all it
--   can do is unsubscribe that one row. Two random UUIDs, so no pgcrypto.

alter table signups drop constraint signups_status_check;
alter table signups add constraint signups_status_check
  check (status in ('pending', 'confirmed', 'invited', 'joined', 'unsubscribed'));

alter table signups
  add column confirm_token_hash   text,
  add column confirm_expires_at   timestamptz,
  add column confirmation_sent_at timestamptz,
  add column confirmed_at         timestamptz,
  add column unsubscribe_token    text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

create unique index signups_confirm_token_key on signups (confirm_token_hash) where confirm_token_hash is not null;
create unique index signups_unsubscribe_token_key on signups (unsubscribe_token);
