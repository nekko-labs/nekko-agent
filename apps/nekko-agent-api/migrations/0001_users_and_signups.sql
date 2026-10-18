-- Beta signups and long-term users.
--
-- signups: one row per email per list. The beta launch uses list 'beta'; later
--   waitlists reuse the table with another list name. A signup is an intent
--   (someone asked to join), not an account.
-- users: the long-term account record. A signup that gets let in becomes a
--   user, and signups.user_id points at it. Nothing writes users yet; the
--   table exists so the signup rows can link to it from day one.
--
-- Emails are stored as given (trimmed) and compared lowercased, so
-- "Ada@Example.com" and "ada@example.com" are the same person.

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (length(email) between 3 and 320),
  name        text check (length(name) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index users_email_key on users (lower(email));

create table signups (
  id            uuid primary key default gen_random_uuid(),
  email         text not null check (length(email) between 3 and 320),
  name          text check (length(name) <= 200),
  list          text not null default 'beta' check (list ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  status        text not null default 'pending'
                check (status in ('pending', 'invited', 'joined', 'unsubscribed')),
  user_id       uuid references users (id) on delete set null,
  -- Where the form was: page path and utm_* values only, never a full URL.
  source        text check (length(source) <= 200),
  utm           jsonb not null default '{}'::jsonb,
  consented_at  timestamptz not null default now(),
  invited_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index signups_list_email_key on signups (list, lower(email));
create index signups_list_status_idx on signups (list, status, created_at);
create index signups_user_id_idx on signups (user_id) where user_id is not null;
