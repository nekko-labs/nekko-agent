---
title: "Beta signups and website analytics (2026-10-17)"
area: brand
split-from: SPEC.md (2026-10-22)
---

# Beta signups and website analytics (2026-10-17)

**Beta signups.** People will join the beta from a form on nekkoagent.com with their email and, optionally, their name. The form is not on the site yet; the backend and database behind it are. Joining twice is harmless and looks the same as joining once, so the form never reveals whether an address is already on the list. We keep only what the form asks for, plus the page path and `utm_*` tags that brought someone there, never a full URL or IP. Each signup moves `pending → invited → joined`, or to `unsubscribed`; signing up again after unsubscribing puts the address back to pending. The same table serves later waitlists under another list name.

**Users.** A signup is a request, not an account. Someone let into the beta becomes a **user**, the long-term account record that Cloud accounts will grow from; the signup row links to it. Nothing creates users yet.

**Where it runs.** A small API (`apps/nekko-agent-api`) on one small Fly.io machine, paid from Fly credits, with Postgres on Neon's free plan. Supabase was ruled out on cost, because its two free projects are already in use. Spending stays far under $100 a month. Fly can't cap a bill, so the limit is built into the app's config: one small machine that stops when idle and never scales out, at about $2 a month if it ran nonstop. The signup page wakes the machine when it loads.

**Website analytics.** nekkoagent.com and its docs report to PostHog, in a Nekko Agent project of their own. They track pageviews, clicks and referrers without cookies or any browser storage, so there is no consent banner; there are no session recordings or person profiles. `[Implemented, not live: the PostHog project key and the Neon and Render accounts are owner-side; see TASKS.]`
