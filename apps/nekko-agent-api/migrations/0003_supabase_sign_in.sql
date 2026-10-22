-- Sign-in through Supabase Auth (identity only; data stays in this database).
--
-- users.auth_subject: the Supabase user id (the access token's `sub`). A user
--   is found by it first; a beta signup's user row with the same verified email
--   and no subject yet is linked on first sign-in.
-- api_tokens.label: the device's own short name for the session, shown in the
--   account's session list. expires_at: tokens last 180 days from their last
--   use and are then refused; signing in again issues a new one.

alter table users add column auth_subject text check (length(auth_subject) between 1 and 128);
create unique index users_auth_subject_key on users (auth_subject) where auth_subject is not null;

alter table api_tokens add column label text check (length(label) between 1 and 60);
alter table api_tokens add column expires_at timestamptz;

-- The recovery wrap is now sealed to the recovery key's public half (ECIES,
-- like a device wrap), so it is the same 146 bytes. Nothing was stored in the
-- earlier 113-byte format.
alter table sync_keyrings drop constraint sync_keyrings_recovery_wrap_check;
alter table sync_keyrings add constraint sync_keyrings_recovery_wrap_check check (octet_length(recovery_wrap) = 146);
