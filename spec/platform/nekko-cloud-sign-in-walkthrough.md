---
title: Signing in to Nekko Cloud is an animated walkthrough
area: platform
status: in-progress
---

# Signing in to Nekko Cloud is an animated walkthrough

Tracking: [#3187](https://github.com/nekko-labs/nekko-agent/issues/3187). Design: [nekko-designs/cloud-welcome-walkthrough-design.html](../../nekko-designs/cloud-welcome-walkthrough-design.html). Related: [plans and billing](plans-and-billing.md), [invite-only](nekko-cloud-invite-only.md).

## Goal

Someone pressing Sign in to Nekko Cloud for the first time, or choosing to create an account, understands what they are signing up for and comes out the other side signed in, on a plan, and syncing with their recovery key saved, in one calm, animated window instead of a bare sign-in box.

## How it works

- **Entry.** Settings > Nekko Cloud, signed out: **Sign in to Nekko Cloud**, and under it **New here? Create an account**. Sign in opens the walkthrough at Welcome the first time on this device and at Account after that (this device remembers it has signed in before); Create an account always starts at Welcome. A sign-in code already sent still reopens straight at the code.
- **One window, one picture.** The frosted sign-in window with the prism edge. At the top, one drawing (laptop, phone, Nekko, a lock) morphs from step to step: the devices step aside for Account, Nekko slides over to watch the browser, an envelope lands for the emailed code, the ring turns green when you are in, ciphertext flows to the cloud during Sync, and everything connects at the end. Content fades in from the side it came from and the window eases to each step's height. Reduced motion keeps only fades and a still picture.
- **Steps.**
  1. **Welcome** (first run only): "Your Nekko, on every device". Create your account, or I already have an account.
  2. **Account**: GitHub, Google, Apple (finished in the browser, with a waiting view that can reopen the page or cancel) or an emailed 6-digit code. Errors, including the invite-only refusal, show under the choices.
  3. **You're in**: the signed-in email. No Back from here on: closing keeps you signed in.
  4. **Choose a plan** (only when the account can't sync yet): Free, Pro (chosen by default) or Team as rows. Free goes on; Team opens an email to hello@nekkoagent.com; Pro pays.
  5. **Sync** (only when the plan allows it): turns sync on for this computer and shows the recovery key to save and type back. An account that already syncs elsewhere is told to finish adding this computer in Settings > Sync.
  6. **All set**: the account and plan, whether sync is on and the key saved (or why not), and a nudge to sign in on the iPhone.
- Step dots show on the first run only, and drop the plan or sync dot once the account shows they don't apply.

## Paying (test mode until billing is live)

- With billing switched on for the account ([plans and billing](plans-and-billing.md)), Pro opens the real Stripe Checkout in the browser and the walkthrough waits, checking again whenever the window comes back, until the plan changes.
- Otherwise Pro runs a **test checkout** in the window: the Stripe test card (4242…) on a card that tips into place and types its number in, Pay, about a second and a half of paying, then a green check and "You're on Pro" with the line "Test mode: nothing was charged and your account's plan hasn't changed." There are no card fields, so nobody can type a real card into a page that charges nothing, and nothing is sent anywhere. The price shown is the draft Pro price ($12 a month).
- Because the plan does not really change, a free account that "pays" in test mode skips Sync and All set says sync is waiting for Pro.

## v2 (#3190 to #3193)

Design: [nekko-designs/cloud-welcome-walkthrough-design-v2.html](../../nekko-designs/cloud-welcome-walkthrough-design-v2.html).

- **The Nekko Cloud mark.** A cloud outline with two wide, round-tipped ears out at the edges of its top lobe (widened 2026-11-23, design v3) and caret eyes, nothing else of a cat (`NekkoCloudMark`). It is the centre of every picture in place of the pixel head, and hops 4px with a small echo every 7 seconds. Philip asked for the hop, so it is the one bounce in the app; reduced motion keeps it still.
- **Several devices.** Welcome, Sync and All set show a laptop, a desktop, a phone and a tablet linked up to the mark, with packets running both ways (all upward and locked during Sync, solid green links at the end).
- **Your way.** Welcome reads "Your way, on every device: your profile, computers, fleet and settings follow you to every device, end-to-end encrypted." Nothing says "your Nekko".
- **Choose a plan.** The window widens to 640 for this step. Free, Pro and Enterprise sit side by side (stacked under 600px), each with its price, a line and three main points; Show the full list opens the whole comparison underneath (it eases open, rows rise in one after another, the chevron turns over), with the chosen plan's column washed and not-yet-shipped rows marked Soon. Both come from one shared list, `packages/shared/src/plan-catalog.json`, which the website's pricing page reads too. Enterprise is the plan stored as `team`; other screens still call it Team.
- **Paying.** The test checkout shows the ways to pay a subscription where you are, as tiles (three and "N more" when there are over four; the chosen one always shows): cards everywhere; Apple Pay on Apple devices and Google Pay elsewhere (neither in India); Link (not in India); ACH, Cash App Pay, Amazon Pay and Klarna in the US; SEPA debit across the EEA and iDEAL in the Netherlands; Korean cards, Kakao Pay and Naver Pay in South Korea; Pix in Brazil; UPI in India, with the notice Indian rules require. Country is guessed from the time zone and language, device from the platform, and both can be changed. A card shows the test card typing in (a JCB in Japan), a wallet shows its confirm sheet, a bank debit shows the mandate in plain words with a test account, other apps say where you'll finish. The button says **Pay now** (or Continue to the app). The rules live in `packages/shared/src/paymentMethods.ts`, from Stripe's docs as of 2026-11-22: only methods that renew by themselves in Checkout's subscription mode, so Konbini, bank transfer and Bancontact (one invoice at a time) and Afterpay, Affirm, PayPay and Samsung Pay (no subscriptions) are left out.
- **Assumption to confirm:** the Stripe account belongs to Nekko Labs LLC (US). With a US account, PayPal, Revolut Pay, Bacs and BECS can't be offered; `STRIPE_ACCOUNT_COUNTRY` switches them on for an EU, UK or Australian account.
- Paying by invoice (`customer_balance`) is listed for Enterprise owners and admins only; nothing in the walkthrough reaches it yet, since Enterprise is Email us.

## Privacy and security

- Unchanged from the sign-in it replaces: Supabase Auth checks who you are, the engine keeps the device token, the renderer never sees it.
- The test checkout handles no card data and makes no network call.
- Whether this device has been welcomed is one local flag (`nekko.cloud.welcomed` in the renderer's storage); it holds no account data.

## Status

- Implemented in the shared renderer (desktop and Local Web UI): `CloudSignIn` (the walkthrough), `CloudWelcomeScene` (the picture), `CloudWelcomePlan` (plans and the test checkout), styles in `cloud.css`. Turning sync on after sign-in moved from Settings into the walkthrough's Sync step.
- Verified with `apps/desktop/scripts/cloud-welcome-evidence.cjs` against a stand-in engine in hidden Chromium (every step, Light and Dark, a narrow window). Not yet verified against the real Cloud API and daemon (`sync-evidence.cjs` was updated for the new flow but not run).
- Planned: the same walkthrough on iPhone and Android; the test checkout goes away once billing is live for everyone.
- Before Nekko Cloud opens beyond the invite list with billing still off, decide whether to keep showing the test checkout to the public or hide the plan step.
