create table privacy_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('export','erasure')),
  state text not null default 'received' check (state in ('received','reviewing','closed')),
  created_at timestamptz not null default now()
);
create unique index privacy_case_open on privacy_cases(user_id,kind) where state <> 'closed';
create index privacy_case_queue on privacy_cases(created_at,id) where state <> 'closed';
create table privacy_case_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references privacy_cases(id) on delete cascade,
  actor uuid references users(id) on delete set null,
  state text not null,
  created_at timestamptz not null default now()
);
create index privacy_case_history on privacy_case_events(case_id,id);
