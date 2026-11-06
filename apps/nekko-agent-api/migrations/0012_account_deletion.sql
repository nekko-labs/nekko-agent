-- Account deletion (DELETE /v1/account, docs/decisions/0043).
--
-- pending_auth_deletions: Supabase Auth users still to delete after their
--   account was deleted here. The row is written in the same transaction that
--   deletes the account, and removed once Supabase confirms; a failed call
--   leaves it for the hourly retry. Holds only the Supabase user id (no email).

create table pending_auth_deletions (
  auth_subject  text primary key,
  created_at    timestamptz not null default now()
);
