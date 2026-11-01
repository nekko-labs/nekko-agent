-- Machine hours per account per month (spec/phone/nekko-cloud-machines.md).
--
-- machine_usage: the seconds an account's machines ran in a calendar month
--   (UTC), deleted machines included. Time is accrued on every state change
--   (stop, an idle self-stop seen on refresh, start, delete) and by a periodic
--   sweep, so plan hours bound the account's total runtime, not one machine's.

create table machine_usage (
  user_id  uuid not null references users (id) on delete cascade,
  period   date not null,
  seconds  bigint not null default 0 check (seconds >= 0),
  primary key (user_id, period)
);
