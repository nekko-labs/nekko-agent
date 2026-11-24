create table org_activity (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  actor uuid references users(id) on delete set null,
  action text not null,
  at timestamptz not null default now()
);
create index org_activity_recent on org_activity(org_id,id desc);
