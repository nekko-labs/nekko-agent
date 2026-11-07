# CI runners P4: the Nekko Cloud fleet (design, 2026-11-07)

Status: **proposed, waiting on Philip's answers** (questions at the end). Decision record: [0064](../docs/decisions/0064-ci-runner-fleet-through-nekko-cloud.md). Spec: [CI runners](../spec/automation/ci-runners.md), "Free and Nekko Cloud" and "Phases". Umbrella issue: [#1038](https://github.com/nekko-labs/nekko-agent/issues/1038).

## What P4 is for

Today every Mac runner stands alone. The picker job asks GitHub's runner API with a read-only token stored as a repo secret, and only knows "online and idle", not whether the Mac is about to step aside for its owner. Each Mac holds its own GitHub App key. Nobody can see, from one place, which Macs are helping, which are away and which are stuck.

P4 adds four things, all optional and all behind a paid Nekko Cloud plan:

1. **Presence.** Each fleet Mac's nekkod tells Nekko Cloud what its runners are doing: slots, mode, gates, image.
2. **Picker endpoint.** The picker job asks Cloud for a Mac with live presence and a free slot, and falls back to a hosted runner.
3. **JIT broker.** The GitHub App key lives in Cloud. Macs get short-lived, narrowed tokens from it and never hold the key.
4. **Fleet view and notifications** on the desktop, the iPhone and Android.

**Never changes:** one Mac keeps working fully with no Cloud account, no sign-in and no network call to Cloud. Every P4 path is off until the owner turns it on, and a Cloud outage only sends jobs to hosted runners, never blocks one.

## What exists to build on

- **nekkod already signs in to Nekko Cloud** (`crates/nekko-cloud`): Supabase proves identity once, and the device keeps its own `nk_` token in the vault. Cloud stores tokens as SHA-256 and knows each one's user, plan and device.
- **Plans** are `users.plan` (`free`, `pro`, `team`), set by hand until Stripe writes them. Sync and Cloud machines already answer `402 plan-required` for free accounts.
- **Every GitHub call on the Mac** goes through one function, `token_for(app_id, installation_id)` in `crates/nekkod/src/runner/github.rs`. That is the one seam the broker needs.
- **The picker** (`scripts/pick-runner.mjs`, 51 lines) already never fails a workflow and falls back to hosted on any error.
- **Phones reach a computer's channels over the relay**; `runner:*` is not on the phone allowlist yet. The relay already sends content-free pushes to paired phones.
- **Not there:** Cloud has no teams (one user per account), and Android has no Nekko Cloud sign-in at all.

## Design

### Who is in a fleet

The Macs signed in to **one Nekko Cloud account**. Cloud has no teams yet, so a team pooling Macs across people (journey 2) waits for Cloud teams, which is its own project. Until then a team can share one Cloud account on its runner Macs. (My call, question 1.)

### Auth

- **nekkod to Cloud:** the device's existing `nk_` token. No new credential. Revoking the device in Cloud drops it from the fleet and stops its tokens.
- **Picker to Cloud:** GitHub Actions OIDC. The picker job asks for an ID token (`permissions: id-token: write`, audience `nekko-cloud`) and sends it; Cloud checks it against GitHub's published keys with Node's own crypto (no new dependency) and reads `repository`, `repository_owner`, `ref` and `event_name`. No secret goes in the repo. A fork PR gets no ID token, so it falls back to hosted, as it does today.
- **Phones:** through their paired computer, with a read-only `runner:fleet` channel added to the phone allowlist. The computer answers from Cloud with its own token. This keeps iPhone and Android the same (decision 0061) without building Cloud sign-in on Android, and a phone shows the fleet only when its computer is in one.

### Presence

- **Opt-in.** Runner settings gain **Share this Mac's runner status with Nekko Cloud**, off by default, shown only while signed in. On a free plan it is disabled with "Part of Nekko Cloud Pro".
- **What is sent** (`PUT /v1/fleet/macs/:installId`, on every runner view change, at most every 5 s, and at least every 60 s): the Mac's name, the app version, and per runner its provider, scope, repos, label, mode, on or off, state, each slot's guest kind and state, the running job (repo, workflow, job name, link), free macOS and Linux slots, the waiting reason codes, and the image (macOS and Xcode versions, built date).
- **Never sent:** keys or tokens, trusted networks or router addresses, battery level, activity figures, CPU or memory numbers, logs, audit lines.
- **Live** means seen in the last 90 s. Going to sleep, switching the setting off and signing out send `DELETE` first (best effort; the 90 s covers a Mac that just vanishes).
- **Stored** as one row per Mac (`fleet_macs`: user, install id, device, the body as JSON, seen at), deleted with the device token or the account, and after 30 days unseen.

### Picker endpoint

`POST /v1/fleet/pick` with the OIDC token and `{ label, guest }`. Cloud looks for a live Mac whose enabled runner serves that repository (or its org), has the label, has a free slot of that guest kind and no waiting reason that blocks a new job. It answers `{ runsOn: ["self-hosted", label] }`, or `{ runsOn: null }` when none qualifies or the repository is unknown (a stranger learns nothing). A pick holds that slot for 3 minutes, so two picker jobs at the same moment do not both pick one free slot (in memory: Cloud runs on one machine today).

`pick-runner` gains a `cloud` input. With it, the picker asks Cloud first; on `null` it falls back to hosted, and on any error it falls back to the current GitHub API check (when a token is set), then hosted. It still never fails the workflow.

### JIT broker

- **One Nekko-owned GitHub App** ("Nekko Runner", under nekko-labs) that owners install, as the spec's provider table already says. Its key, client id and client secret are Cloud secrets on Fly. An owner links an installation to their account by authorizing the app on GitHub (the user-to-server OAuth flow); Cloud keeps the installation only if `GET /user/installations` lists it for that GitHub user, so nobody can link someone else's.
- **What Cloud hands out:** installation tokens, which GitHub limits to one hour, narrowed with GitHub's own `repositories` and `permissions` parameters to the runner's repos and to what nekkod uses (Actions write, Metadata read, and Administration write for a repo runner or Self-hosted runners write for an org). `POST /v1/runners/github/token { installationId, repos }`.
- **The Mac** keeps minting its own JIT configs, polling the queue, reading logs, cancelling and re-running, all with that token. A runner record gains a brokered GitHub link, and `token_for` asks Cloud for it instead of signing with a local key.
- **Why tokens and not only JIT configs:** the Mac also polls queues, job status and logs, and cancels and re-runs, with the same token. Brokering only the JIT config would mean proxying all of that through Cloud. A narrowed one-hour token gives the property that matters: no laptop holds the key, a lost laptop is cut off by revoking its device, and its last token dies within the hour. The spec's "Cloud mints JIT configs" becomes "Cloud mints short-lived tokens; the Mac mints its JIT configs with them".
- **Connect.** While signed in on a paid plan, the Connect GitHub sheet offers **Use Nekko Cloud** above the current click-through. The own-app flow stays for Free and for anyone who prefers it.

### Fleet view

- **Desktop:** with presence on, the CI runners section gains **Other Macs** below this Mac's runner cards: each Mac's name, **Idle**, **Busy (1 of 2)**, **Away** (gates holding) or **Offline since 14:02**, its labels, and the running job with its link. Read-only: P4 does not let one Mac switch another's runner on or off.
- **Phones:** the same list, read-only, on the paired computer's CI runners screen, iPhone and Android in one change or with the gap recorded.
- **Channel:** `runner:fleet` in nekkod, answered from `GET /v1/fleet` (cached 15 s).

### Notifications

Cloud derives events from presence. Recommended v1 set, nothing else:

- **A Mac went offline with a job running** (the job is lost and re-run).
- **A Mac's runner is in Error** (a refused key, no image, three failed starts in a row).

Each signed-in Mac with presence on reads new events with `GET /v1/fleet` every 60 s and shows a desktop notification for events about other Macs. For phones, Cloud names one live Mac per event as its sender; that Mac sends it through the relay's existing content-free push, tagged with the event id, so a phone paired with several fleet Macs gets it once. (Question 4.)

### Golden images: not in P4

Recommended out of P4, kept as a later phase. Images are tens of GB, pinning them by digest is not built yet (it is still planned in the spec), and building one is already one click on each Mac. Mirroring needs a Mac-to-Mac transfer path and a rule for which Mac builds. The spec's "Hosted by Cloud, or mirrored from one fleet Mac" row stays planned. (Question 2.)

### Paid-plan gating

Presence, the fleet view, notifications, the picker endpoint and the broker all need `pro` or `team`, answering `402 plan-required` like sync. A free account sends nothing. Plans are still set by hand until Stripe writes them, so Philip sets a plan on the test account.

## Pieces, each its own issue and PR

1. This design and decision 0064.
2. **Cloud presence and fleet API:** migration, `PUT`/`DELETE /v1/fleet/macs/:installId`, `GET /v1/fleet`, plan gating, tests. Deploy only with Philip's yes.
3. **nekkod presence:** the setting, the reporter, `DELETE` on sleep, off and sign-out, `runner:fleet`. Tested against an in-memory Cloud.
4. **Desktop fleet view:** Other Macs, with before and after captures.
5. **Picker endpoint:** OIDC check in Cloud, `/v1/fleet/pick`, the slot hold, `pick-runner` `cloud` input, tests.
6. **Broker:** installation linking and the token endpoint in Cloud, the brokered link in nekkod, **Use Nekko Cloud** in the connect sheet. Blocked on the Nekko Runner GitHub App existing and its secrets on Fly (Philip).
7. **Notifications:** events in Cloud, desktop notifications, phone push through the named sender.
8. **iPhone and Android fleet view.**

Live checks that need Philip: deploying Cloud, creating the GitHub App and setting its secrets, and a second Mac for a real two-Mac fleet. Without a second Mac, a fleet of one Mac plus a stand-in presence row is the most that can be shown live.

## Questions for Philip

1. **Who is in a fleet?** Recommended: the Macs on one Nekko Cloud account, until Cloud has teams. The alternative is building Cloud teams first (members, invites, roles), which is bigger than the rest of P4.
2. **Golden images:** leave mirroring out of P4 (recommended), or include it?
3. **The broker's GitHub App:** one Nekko-owned app whose key lives in Cloud (recommended; you would create it under nekko-labs and approve its Fly secrets), or keep each owner's own app and have its manifest flow hand the key to Cloud instead of the Mac?
4. **Notifications:** just "a Mac went offline mid-job" and "a runner is in Error", on desktops and phones (recommended), or a different set?
5. **Plan:** Pro and Team both (recommended, since one person with two Macs is a fleet), or Team only?
