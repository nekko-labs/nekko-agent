---
title: Nekko Cloud plans and billing, behind a team-only switch
area: platform
status: in-progress
---

# Nekko Cloud plans and billing

Tracking: [#2724](https://github.com/nekko-labs/nekko-agent/issues/2724). Decision: [0092](../../docs/decisions/0092-unreleased-cloud-features-sit-behind-a-team-switch.md). Plans and prices: [spec-web-and-hosted.md §6](../../spec-web-and-hosted.md).

## Goal

Someone on the free plan can subscribe to Nekko Cloud Pro, then manage or cancel it themselves, without anyone setting a plan by hand. Until launch none of it is visible: billing starts **off** and only the Nekko Agent team can switch it on.

## The switch

- Each unreleased Cloud feature has a switch with three states: **off** (the default, and what an unset switch means), **team** (only Nekko team accounts see it), **on** (everyone, signed in or not).
- A Nekko team account is one whose email is on the team list (philip, davide, travis and matt @nekkolabs.com; `NEKKO_STAFF_EMAILS` replaces it) **and** whose address was proven at sign-in (an emailed code or a provider's verified email). Typing the address is not enough. An account made before this existed becomes a team account the next time it signs in.
- To turn billing on: sign in to Nekko Cloud in the app with a team email, then use **Plans and billing** under the account in Settings > Sync. Everyone else never sees the switch, and its routes answer 404 to them.
- A feature the service can't run stays hidden whatever the switch says: billing needs Stripe keys on the service.

## Paying

- **Pro** is bought through Stripe Checkout (a Stripe-hosted page in the browser). Promotion codes are accepted. One subscription per account: an account already on Pro or Team is sent to manage it instead.
- **Team** is "talk to us" (hello@nekkoagent.com) until seats can be given to an organization's members. A Team plan is still set by hand.
- **Manage billing** opens Stripe's Customer Portal: card, invoices, cancel. A plan set by hand has nothing to manage there.
- After paying, the browser lands on a short "You're all set" page; the app shows the new plan on its next refresh.
- The plan follows Stripe, not the event that announced it: every subscription event makes the service ask Stripe what the customer pays for now. A failed card keeps the plan while Stripe retries (past due); when Stripe gives up, the account drops to Free. Data is not deleted on a downgrade: reading, revoking and deleting synced data never depend on the plan.
- Deleting the account deletes the Stripe customer first, which cancels the subscription at once. If Stripe can't be reached, nothing is deleted and the app can try again.

## Privacy and security

- Stripe holds the card; the service stores only the Stripe customer id. Stripe sees the account's email and id.
- Webhooks are accepted only with a valid Stripe signature from the last five minutes.
- Turning a switch is logged with the feature and state, and the switching account is recorded on the switch.

## Status

- Implemented: switches, team accounts, Checkout, Portal, webhook and account deletion in the Cloud API (`apps/nekko-agent-api`, `src/features.ts`, `src/billing.ts`), with tests against a stand-in Stripe.
- Implemented (desktop and Local Web UI): under the account in Settings > Sync, **Upgrade** with the Pro price on Free and **Manage billing** on a paid plan, both opening Stripe in the browser; the plan refreshes when the window comes back. Team accounts also see **Plans and billing: Off, Team only, Everyone** there (Everyone asks first). While billing is off nothing links to plans: the "See plans" buttons in Sync and Organization are gone, since nekkoagent.com/pricing doesn't exist yet; Organization's points to the Upgrade row once billing is on.
- Planned: a pricing page on nekkoagent.com shown only when billing is on for everyone, and a docs page at launch; phones; Team seats per organization; yearly prices.
- Not done, needs Philip: a Stripe account, the Pro product and price, the webhook endpoint, and the secrets on Fly. No live charge has been made.
