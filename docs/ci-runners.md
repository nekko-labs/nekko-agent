# CI runners on your Mac

Run your GitHub Actions jobs on this Mac. Each job gets its own throwaway macOS VM that is
deleted when the job ends, and your own work comes first: by default the runner only takes jobs
while you are away and the Mac is plugged in.

## What it does

Nekko Agent registers this Mac as a GitHub Actions **self-hosted runner** for one repo or one
org. When a job asks for it, Nekko clones a VM from your image, starts the job inside it with a
one-time runner config from GitHub, and deletes the VM afterward. The job cannot see your files,
your home network or your other devices: its only way out is a private network that reaches the
internet and nothing on your LAN.

This is not the [Local CI runner](git-runner.md) workflow template. That one runs your build
directly on the machine and reports a commit status; this one picks up real `runs-on:` jobs from
the GitHub Actions queue, each in its own VM.

You find it in **Workflows**, under the **Workflows | CI runners** switch at the top.

**What is not verified yet.** The pieces are built and tested, and a VM has been booted and
checked on a real macOS 15 guest, but one real GitHub job has not yet run end to end, and the
rule that keeps job traffic off a VPN has not yet been checked against a real tunnel. Both are
part of the pilot (T214). The [image guide](ci-runners-image.md) and the job picker are in place;
the image itself has not yet been booted in a VM.

## Before you start

- **An Apple silicon Mac.** Windows and Linux show "CI runners aren't available here", and a Mac
  that cannot run VMs shows "VM support unavailable" on the runner card.
- **A VM image.** Jobs run in clones of a macOS image stored in Nekko's data folder. On macOS 27
  Nekko builds it from Apple's restore image; on macOS 26 you
  [bring your own](ci-runners-image.md). Until an image exists, the runner card shows `No VM image yet.`
- **A build with VM support.** The `nekko-vm` helper needs Apple's virtualization entitlement.
  Development builds sign it themselves, and packaged builds sign it with its own entitlement
  (see [signing](signing.md#the-vm-helpers-entitlement)). A Developer ID signed release with it
  has not shipped yet.

## Create the GitHub App

The runner talks to GitHub as a GitHub App you create and own, so its access is limited to what
you grant and you can revoke it at any time.

1. On GitHub, open **Settings > Developer settings > GitHub Apps > New GitHub App** for your
   account, or the same page under your org's settings for an org runner. Give it any name and
   homepage URL, and turn off **Webhook** (the runner asks GitHub itself).
2. Under **Permissions**, grant:
   - for a **repo runner**: Repository permission **Administration: Read and write**;
   - for an **org runner**: Organization permission **Self-hosted runners: Read and write**;
   - for both: Repository permission **Actions: Read and write** (to see queued jobs and re-run
     a job lost to sleep) and **Metadata: Read** (GitHub sets this one for every app).
3. Create the app and copy its **App ID** from the app's General page.
4. On the same page, **Generate a private key**. GitHub downloads a `.pem` file.
5. Choose **Install App**, install it on the account or org, and pick the repos it may use. The
   **installation ID** is the number at the end of the installation page's address
   (`.../settings/installations/12345678`).

Why those permissions: GitHub requires Administration (write) on the repo, or Self-hosted runners
(write) on the org, to create a just-in-time runner config and to remove a runner, and Actions to
list workflow runs and re-run a job. See GitHub's
[permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
(the "Self-hosted runners", "Administration" and "Actions" sections) and the
[self-hosted runners REST API](https://docs.github.com/en/rest/actions/self-hosted-runners).

## Connect this Mac

In **Workflows > CI runners**, choose **Connect GitHub**. The sheet has three steps:

1. **Install app.** Paste the App ID, the installation ID and the whole private key file. The key
   is saved in this Mac's keychain, and only after GitHub accepts it. It is never shown again,
   logged or kept by the window once the sheet closes.
2. **Org or repo.** Choose **A repo** (`owner/name`) or **An org** and list the org's repos the
   runner may serve (names or `org/name`, comma or newline separated). Public repos are refused
   unless you tick **Allow public repos**: anyone can open a pull request on a public repo, and its
   workflows could ask for this Mac. If you allow them, keep "Require approval for all external
   contributors" on in the repo's Actions settings so fork pull requests wait for you, and see
   [Use it in a workflow](#use-it-in-a-workflow). The
   **Runner label** defaults to `nekko-cloud-mac`; letters, digits, dot, dash and underscore, up to 64.
3. **How this Mac helps.** Pick a mode (below), then **Start runner**. If GitHub refuses (a
   revoked key, a public repo you did not allow, the wrong account), its reason shows on this
   step and everything you typed stays.

## Use it in a workflow

Point a job at the runner with all four labels:

```yaml
jobs:
  build:
    runs-on: [self-hosted, macOS, ARM64, nekko-cloud-mac]
```

Use your own label in place of `nekko-cloud-mac` if you changed it.

To fall back to a GitHub-hosted Mac when yours is busy or away, add a small job that picks the
runner first: [`.github/actions/pick-runner`](https://github.com/nekko-labs/nekko-agent/tree/main/.github/actions/pick-runner)
outputs your runner's labels when one is online and idle, and the hosted label otherwise. It
needs a read-only token in a secret (repository **Administration: Read-only** for a repo runner;
for an org runner, set its `org` input and use organization **Self-hosted runners: Read-only**
from an org admin, since for anyone else GitHub answers 403 and every run goes to hosted), and it never fails the run: no token (as on a fork pull
request), an API error or a timeout all give the hosted runner. Nekko Agent's own
`ios-native.yml` uses it.

**On a public repo, the picker does not keep fork code off your Mac.** A pull request runs its
own copy of the workflow file, so a fork could name your runner directly. Before you point a
public repo's jobs at this Mac, turn on **Require approval for all external contributors** in the
repo's **Settings > Actions > General**, connect the runner to an org, and in the org's
**Settings > Actions > Runner groups**, set the runner's group to **Selected workflows** listing
only the workflows on your default branch that may use it. See GitHub's
[managing access to self-hosted runners](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access).
Every branch you list there is trusted: a branch that collects other people's unreviewed changes
(such as a batch branch built from open pull requests) lets anyone with write access run code on
your Mac. The VM is the second layer: a job that gets in still only reaches the public internet.

## How this Mac helps

The mode decides when the runner may take a job. You choose it when you connect and can change
it any time in the runner's settings.

- **Do not disturb: Only run when I'm idle** (default). Only when you're away and plugged in.
  Steps aside the moment you need the Mac.
- **Balanced: in the background**. Takes jobs while you work if there's headroom. Keeps one VM
  ready.
- **Runner first**. For a docked Mac that mostly runs CI. All slots ready, jobs finish even when
  you're busy.

## Keep awake

- **System default**. The Mac follows its own Energy settings. If it sleeps mid-job, the job is
  lost and re-run (when **Re-run jobs lost to sleep** is on).
- **While a runner is active** (default). Keeps the Mac from sleeping while a job runs and lets
  it sleep when the last one ends. The display can still sleep.
- **Always**. Keeps the Mac awake whenever the runner is on and allowed to take jobs.

None of them can stop sleep when the lid closes on battery, when Low Power Mode turns on, or when
you choose Sleep.

## Settings

Open them with the gear on the runner card. The sheet always shows what the runner actually
kept: if you save a value outside its range, the saved value is the nearest allowed one.

- **Runner**: on or off. Turning it off stops and deletes any running VM.
- **Priority**: the three modes above.
- **Keep awake**: the three choices above.
- **macOS slots**: 0, 1 or 2 VMs at once. Apple allows 2 per Mac, so 3 is not offered. If
  another app is running a macOS VM, or memory allows only one, the card greys the extra slot and
  says why.
- **Memory per VM**: 4 to 64 GB.
- **Total runner memory**: **Use the recommendation** (the sheet shows
  `Recommended: N GB for this Mac`), or your own figure from 4 GB up to 75% of the Mac's memory.
- **CPU per VM**: **Mode default**, or 2 up to the Mac's cores minus 2.
- **Disk**: an image budget of 50 to 4000 GB, and a free-disk floor of 10 to 1000 GB below which
  no new VM starts.
- **Only when**: **On power**, **Trusted networks**, **Never on hotspots**, and
  **Let jobs use the internet directly while a VPN is on**. Job traffic never goes through a VPN
  tunnel; with that switch off, the runner waits while a VPN carries all of the Mac's traffic.
- **Trusted networks**: up to 32, recognised by the router's hardware address and listed as
  `gw:...` ids. **Trust this network** adds the one this Mac is on, shown with a
  **This network** badge.
- **Safety**: **Re-run jobs lost to sleep**.
- **Max job time**: 30 min, 1 h, 2 h or 6 h (the runner accepts 10 minutes to 24 hours).

Until the runner has read this Mac once, memory and CPU show "Waiting for this Mac's first
reading." instead of numbers. On a Mac that cannot run VMs they show the reason instead, and the
runner card's VM size reads "Unavailable".

Not in this version: Linux slots, a schedule, a switch for fork pull requests and a build cache
switch. Their stored values are kept as they are.

## Why a runner is waiting

A waiting runner card lists every reason it is not taking jobs:

- The runner is off.
- All automations are paused.
- It is outside the hours you allowed.
- This Mac is on battery, below what this mode allows.
- Low Power Mode is on.
- This network is not one you trust. Add it in runner settings.
- This Mac is on a hotspot or a metered network.
- A VPN carries all of this Mac's traffic. Turn on "Let jobs use the internet directly while a VPN is on" to take jobs anyway.
- Memory is under pressure.
- Memory is critically low, so any running VM was stopped.
- This Mac is running hot.
- This Mac is too hot, so any running VM was stopped.
- Free disk is below the floor you set.
- A macOS security update has waited more than 7 days. Update this Mac to take jobs again.
- There is not enough free memory for another VM right now.
- Still reading this Mac's state. No new VM starts until it is known.
- You're using the Mac.
- Your apps are using most of the CPU.

A newer version of the runner may add a reason this app does not know yet; it shows as
"A condition is not met."

## The menu bar dot

While any job VM exists (starting, running or cleaning up) or the runner is keeping the Mac
awake, the Nekko icon in the menu bar gets a small green dot, and its tooltip reads
"Nekko Agent · CI runner active". The menu then shows, under the service items,
`CI runners: 1 VM running` (or `2 VMs`) and, while the Mac is kept awake,
`Keeping this Mac awake for CI`. These lines are information only.

## Remove a runner

In the runner's settings, choose **Remove runner** and confirm. Its VMs stop and are deleted,
its GitHub registration is removed, and the app's private key is deleted from the keychain once
no other runner uses that app. Uninstall the GitHub App on GitHub if you no longer want it.
