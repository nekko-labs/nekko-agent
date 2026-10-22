-- End-to-end encrypted sync (Pro and Team) and anonymous sealed donations.
-- Design: docs/SYNC-ENCRYPTION.md. Nothing here can be decrypted with what
-- the server holds: blobs are sealed on the user's devices with keys the
-- server never sees (see crates/nekko-sync).
--
-- users.plan: what the account pays for. Sync writes need 'pro' or 'team';
--   reading and deleting your own synced data never depends on the plan.
-- api_tokens: bearer tokens, stored as SHA-256 only. A token can be bound to
--   one sync device, and revoking that device revokes the token.
-- sync_devices: each device's P-256 public key (65 bytes). The label is the
--   user's own short name for it and is the only plaintext a device adds.
-- sync_keyrings: one row per key epoch, holding the keyring wrapped to the
--   recovery key. A new epoch follows a revocation.
-- sync_key_wraps: the keyring of an epoch wrapped to each device.
-- sync_objects: the latest sealed revision of each object. object_id is an
--   HMAC the server can't link to a chat; seq orders changes for pulling.
-- sync_usage: stored bytes per account, kept in step with sync_objects.
-- donations: opt-in samples sealed to the offline research key. No user,
--   device or IP column on purpose; created_on is the day only, so a
--   donation can't be lined up with an account's sync activity by time.

alter table users add column plan text not null default 'free' check (plan in ('free', 'pro', 'team'));

create table sync_devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  public_key  bytea not null check (octet_length(public_key) = 65),
  label       text not null check (length(label) between 1 and 40),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create unique index sync_devices_key on sync_devices (user_id, public_key);

create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),
  device_id     uuid references sync_devices (id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index api_tokens_device_idx on api_tokens (device_id) where device_id is not null;

create table sync_keyrings (
  user_id        uuid not null references users (id) on delete cascade,
  key_id         integer not null check (key_id >= 1),
  recovery_wrap  bytea not null check (octet_length(recovery_wrap) = 113),
  created_at     timestamptz not null default now(),
  primary key (user_id, key_id)
);

create table sync_key_wraps (
  user_id    uuid not null,
  key_id     integer not null,
  device_id  uuid not null references sync_devices (id) on delete cascade,
  wrap       bytea not null check (octet_length(wrap) = 146),
  primary key (user_id, key_id, device_id),
  foreign key (user_id, key_id) references sync_keyrings (user_id, key_id) on delete cascade
);

create sequence sync_change_seq;

create table sync_objects (
  user_id     uuid not null references users (id) on delete cascade,
  collection  text not null check (collection ~ '^[a-z][a-z0-9-]{0,31}$'),
  object_id   text not null check (object_id ~ '^[A-Za-z0-9_-]{43}$'),
  revision    bigint not null check (revision >= 1),
  key_id      integer not null,
  blob        bytea not null,
  seq         bigint not null default nextval('sync_change_seq'),
  updated_at  timestamptz not null default now(),
  primary key (user_id, collection, object_id),
  foreign key (user_id, key_id) references sync_keyrings (user_id, key_id)
);

create index sync_objects_seq_idx on sync_objects (user_id, seq);

create table sync_usage (
  user_id  uuid primary key references users (id) on delete cascade,
  bytes    bigint not null default 0 check (bytes >= 0)
);

create table donations (
  id           text primary key check (id ~ '^[A-Za-z0-9_-]{22}$'),
  blob         bytea not null,
  delete_hash  bytea not null check (octet_length(delete_hash) = 32),
  created_on   date not null default current_date,
  expires_on   date not null default current_date + 180
);

create index donations_expires_idx on donations (expires_on);
