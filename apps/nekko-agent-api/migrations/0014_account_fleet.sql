-- User-owned computers, not provisioned cloud_machines. Descriptors are sealed
-- by trusted clients; a row is discovery, never a remote-execution credential.
create table fleet_computers (
  user_id      uuid not null references users (id) on delete cascade,
  device_id    uuid primary key references sync_devices (id) on delete cascade,
  token_id     uuid references api_tokens (id) on delete set null,
  key_id       integer not null,
  revision     bigint not null check (revision between 1 and 9007199254740991),
  descriptor   bytea not null check (octet_length(descriptor) between 305 and 16384),
  seen_at      timestamptz not null default now(),
  withdrawn    boolean not null default false,
  foreign key (user_id, key_id) references sync_keyrings (user_id, key_id) on delete cascade
);

create index fleet_computers_user_idx on fleet_computers (user_id);
