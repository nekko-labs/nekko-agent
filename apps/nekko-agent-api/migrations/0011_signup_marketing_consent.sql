-- Marketing consent apart from the beta signup (GDPR Art. 7(2)).
--
-- signups.marketing_opt_in: the person also ticked "send me product updates".
--   Beta invites and the confirmation email never depend on it; any other mail
--   (product updates) goes only to rows where it is true. Rows from before this
--   migration stay false: their consent was bundled with the beta request.
-- signups.policy_version: the privacy policy version the form showed when the
--   person last signed up, as the site sends it. Null for older rows.

alter table signups
  add column marketing_opt_in boolean not null default false,
  add column policy_version   text check (policy_version ~ '^[A-Za-z0-9._-]{1,32}$');
