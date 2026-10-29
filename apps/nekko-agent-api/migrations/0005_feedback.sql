-- "Send feedback": short notes people send from any app's feedback sheet.
-- No user, device or IP column on purpose, and received_on is the day only,
-- so a note can't be lined up with an account's activity by time. app_info is
-- null unless the sender switched on "Include app info", and then holds only
-- app, version, os, osVersion and arch (src/feedback.ts drops anything else).

create table feedback (
  id           uuid primary key default gen_random_uuid(),
  message      text not null check (char_length(message) between 1 and 4000),
  app_info     jsonb,
  received_on  date not null default current_date
);

create index feedback_received_idx on feedback (received_on);
