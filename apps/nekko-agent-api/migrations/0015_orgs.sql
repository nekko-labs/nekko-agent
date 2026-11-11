-- Organizations own a shared computer fleet (docs/decisions/0086). The server
-- stores which accounts belong to an org, the org's key epoch number (never key
-- material) and sealed computer descriptors. A row is discovery, never access.
create table orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  -- The org's current org-key epoch; 0 means no key has been made yet.
  key_id      integer not null default 0 check (key_id >= 0)
);

create table org_members (
  org_id    uuid not null references orgs (id) on delete cascade,
  user_id   uuid not null references users (id) on delete cascade,
  role      text not null check (role in ('owner', 'admin', 'member')),
  added_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_idx on org_members (user_id);

-- Addressed to an email; no message is sent yet, the invitee sees it after
-- signing in. Email is stored lower-case.
create table org_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs (id) on delete cascade,
  email        text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role         text not null check (role in ('admin', 'member')),
  invited_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz
);

create unique index org_invites_pending_idx on org_invites (org_id, lower(email)) where accepted_at is null;
create index org_invites_email_idx on org_invites (email) where accepted_at is null;

-- A user's computer advertised to one org. Descriptors are sealed by trusted
-- clients under the org key; the server cannot read them.
create table org_fleet_computers (
  org_id       uuid not null references orgs (id) on delete cascade,
  device_id    uuid not null references sync_devices (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  token_id     uuid references api_tokens (id) on delete set null,
  org_key_id   integer not null check (org_key_id >= 1),
  revision     bigint not null check (revision between 1 and 9007199254740991),
  descriptor   bytea not null check (octet_length(descriptor) between 305 and 16384),
  seen_at      timestamptz not null default now(),
  withdrawn    boolean not null default false,
  primary key (org_id, device_id)
);

create index org_fleet_computers_org_idx on org_fleet_computers (org_id);
create index org_fleet_computers_user_idx on org_fleet_computers (user_id);
