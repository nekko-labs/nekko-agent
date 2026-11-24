create table hypergate_setups (
  user_id uuid primary key references users(id) on delete cascade,
  revision integer not null check (revision > 0),
  setup jsonb not null,
  updated_at timestamptz not null default now()
);
