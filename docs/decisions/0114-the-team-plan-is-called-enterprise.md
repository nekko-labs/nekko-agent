# 0114. The Team plan is called Enterprise

Date: 2026-11-22. Status: accepted. Builds on the plan comparison in #3191 and the pricing page in #3192.

## Context

Nekko Cloud's paid plans were Pro and Team. The walkthrough's plan step and the website's pricing page (#3191, #3192) already showed the third plan as Enterprise, while Settings, the iPhone, the engine's messages and the docs still said Team. Philip settled it: "it should be pro and enterprise".

## Decision

- **The plans are Free, Pro and Enterprise** everywhere people read them: the desktop and Local Web UI, the iPhone, messages from the engine (nekko-cloud), the docs and the specs.
- **The stored plan value stays `team`**: the account's `plan` column, the Cloud API, Stripe and every client keep comparing against `team`. Only the name changes.

## Alternatives not taken

- **Rename the value to `enterprise` too.** Touches the database, the API's plan checks and entitlements, the relay authorization, Stripe metadata and every client at once, and needs every installed app to understand both values during the switch, for no change anyone can see.
- **Keep Team in the app and Enterprise only on the pricing page.** Two names for one plan.

## Consequences

- Code and logs keep saying `team`; a comment where it matters says it is the Enterprise plan.
- Decision records, task history and old reports keep the name they were written with.
- Unrelated "team" words stay: the Nekko team's staff accounts and their **Team only** billing switch, GitHub's and Claude's own Team plans.
