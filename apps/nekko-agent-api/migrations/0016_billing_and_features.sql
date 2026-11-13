-- Plans and billing (issue #2724): the Stripe customer behind a paid plan,
-- whether the account's email was ever proven (team accounts need it), and
-- the switches that keep unreleased Cloud features off.

alter table users add column stripe_customer_id text unique;
alter table users add column email_verified boolean not null default false;

-- One row per feature that has been switched; no row means off.
-- 'team' shows it only to Nekko team accounts, 'on' to everyone.
create table feature_flags (
  key        text primary key check (key ~ '^[a-z][a-z0-9-]{0,39}$'),
  state      text not null check (state in ('off', 'team', 'on')),
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);
