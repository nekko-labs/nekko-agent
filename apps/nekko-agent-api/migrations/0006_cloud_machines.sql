-- Nekko Cloud machines (docs/decisions/0017, spec/phone/nekko-cloud-machines.md):
-- a sandboxed machine per user that the phone pairs with like any computer.
--
-- cloud_machines: one row per machine. The relay room and the pairing key are
--   minted here; the key reaches the machine's environment and the phone's
--   pairing link once, and only its hash stays, so this database can never open
--   the machine's relay frames. relay_access_hash is the hash of the token the
--   machine presents to the relay, which asks this service (POST
--   /v1/relay/authorize) before letting it enrol. scope is what the phone lets
--   the cloud see (repositories, Privacy Shield, memory, sync back), minimal
--   by default. provider_ref is the hosting provider's machine id (Fly).

create table cloud_machines (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  name               text not null check (length(name) between 1 and 80),
  region             text not null check (region ~ '^[a-z]{3}$'),
  size               text not null default 'small' check (size in ('small')),
  state              text not null default 'creating'
                     check (state in ('creating', 'running', 'stopped', 'deleted', 'failed')),
  provider_ref       text,
  room               text not null check (room ~ '^[a-z0-9]{8,32}$'),
  key_hash           bytea not null check (octet_length(key_hash) = 32),
  relay_access_hash  bytea not null check (octet_length(relay_access_hash) = 32),
  scope              jsonb not null default '{}'::jsonb,
  seconds_used       bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  started_at         timestamptz,
  last_used_at       timestamptz,
  deleted_at         timestamptz
);

create index cloud_machines_user_idx on cloud_machines (user_id) where deleted_at is null;
create unique index cloud_machines_room_key on cloud_machines (room);
create unique index cloud_machines_access_key on cloud_machines (relay_access_hash);
