---
status: accepted
date: 2026-11-13
---

# 0092. Unreleased Cloud features sit behind a switch only verified team accounts can turn

## Context

Plans and billing (#2724) have to be built, deployed and tried on production before
launch, without anyone else seeing a price or a Subscribe button. Philip asked for it to
stay off, with the Nekko Agent team (philip, davide, travis, matt @nekkolabs.com) able to
sign in and turn it on. Orgs already narrow who may use them with an environment
allowlist (`NEKKO_ORGS_ALLOWED_EMAILS`), which needs a redeploy to change.

## Options considered

1. **A switch in the database, turned by team accounts through the API.** Three states:
   off, team, on. Team accounts are an email list that must also have been proven at
   sign-in. No redeploy to change it; every client asks the service what it may show.
2. **Environment flags only** (`NEKKO_BILLING_ENABLED=1`), like orgs and the fleet.
   Simplest, but turning it on or back off is a deploy, and there is no "team only"
   step to try production before everyone sees it.
3. **A build-time flag in each app.** Hides the UI but not the routes, and needs a release
   of every app to launch.
4. **A third-party flag service** (LaunchDarkly, PostHog flags). More than one switch
   needs, a new vendor seeing account ids, and the API still has to enforce it.

## Decision

Option 1. `feature_flags` holds one row per switched feature (no row means off);
`GET /v1/auth/me` tells the app what this account may see and whether it is a team
account; `PUT /v1/staff/features/:key` turns a switch. The routes behind a switch answer
404 to anyone it is not on for, and the team routes answer 404 to anyone not on the team.
A team account needs `users.email_verified`, set only when Supabase proved the address.
A feature the service cannot run (billing without Stripe keys) stays hidden whatever its
switch says.

## Consequences

- An account made before this ships becomes a team account only after signing in again.
- The team list is in code with an environment override (`NEKKO_STAFF_EMAILS`); a new
  team member needs a deploy, which is rare and acceptable.
- Later unreleased Cloud features add a name to `FEATURES` in `src/features.ts` instead of
  a new environment flag. Orgs and the fleet keep their environment flags for now.
