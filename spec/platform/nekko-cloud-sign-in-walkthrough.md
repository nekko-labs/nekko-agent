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

## Privacy and security

- Unchanged from the sign-in it replaces: Supabase Auth checks who you are, the engine keeps the device token, the renderer never sees it.
- The test checkout handles no card data and makes no network call.
- Whether this device has been welcomed is one local flag (`nekko.cloud.welcomed` in the renderer's storage); it holds no account data.

## Status

- Implemented in the shared renderer (desktop and Local Web UI): `CloudSignIn` (the walkthrough), `CloudWelcomeScene` (the picture), `CloudWelcomePlan` (plans and the test checkout), styles in `cloud.css`. Turning sync on after sign-in moved from Settings into the walkthrough's Sync step.
- Verified with `apps/desktop/scripts/cloud-welcome-evidence.cjs` against a stand-in engine in hidden Chromium (every step, Light and Dark, a narrow window). Not yet verified against the real Cloud API and daemon (`sync-evidence.cjs` was updated for the new flow but not run).
- Planned: the same walkthrough on iPhone and Android; the test checkout goes away once billing is live for everyone.
- Before Nekko Cloud opens beyond the invite list with billing still off, decide whether to keep showing the test checkout to the public or hide the plan step.
