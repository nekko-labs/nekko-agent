---
title: "CI runners"
area: automation
---

# CI runners

**Status: `[planned]`.** Nothing on this page is built yet. Every section carries its own status, and all of them are planned. Issue: [nekko-labs/nekko-agent#1038](https://github.com/nekko-labs/nekko-agent/issues/1038). Choices behind it: [decision 0022](../../docs/decisions/0022-ci-runners-vm-and-network.md). Tasks: T210 to T214 in [TASKS.md](../../TASKS.md).

## What it is for `[planned]`

One button turns a Mac running Nekko Agent into a CI runner. The provider's own job queue hands it `runs-on` jobs, and every job runs in a throwaway macOS VM that is deleted when the job ends. Job code never runs on the host.

- **The problem.** A public repo gets free hosted macOS minutes, but the capacity is small: a few macOS jobs at once, and per-PR macOS jobs can queue for an hour or more. So macOS checks run rarely or behind a label, and a macOS break shows up hours after the change that caused it.
- **The opportunity.** Teams that ship Mac or iOS software already own fast Apple Silicon Macs that sit idle at night and between builds. Doing this by hand means building VM images, scripts and launchd jobs, then hoping nothing on the host gets touched. Nekko Agent already has a daemon, an Automations tab, a scheduler and a phone app.

**Relation to the "Local CI runner" template.** [`docs/git-runner.md`](../../docs/git-runner.md) documents a workflow template that runs shell steps on the host and posts a commit status. That template stays, as the lightweight option. It is not a self-hosted runner: it does not speak the runner protocol, never picks up `runs-on: self-hosted` jobs, and runs on the host. This feature is the real runner: it takes jobs from the provider's queue, and the job runs only inside a VM.

## Principles `[planned]`

- **A job can only hurt itself.** Fresh VM, own kernel and disk, no host folders (except that scope's own cache volume, for trusted runs), no host credentials, public-internet-only networking, deleted afterward.
- **Your work comes first by default.** The default mode takes jobs only when the Mac is idle, on power, cool and has memory to spare. Being a runner is opt-in and adjustable.
- **Apple's rules, enforced in code.** At most 2 macOS VMs per Mac, only for the owner's own development and testing. The settings cannot exceed it.
- **Local first.** One Mac works fully with no Nekko Cloud account.
- **Off means off.** The Off switch and "Pause all automations" stop every runner within seconds and delete its VMs. A menu bar indicator shows whenever a VM is running.
- **Never block a merge.** When no Mac is available, jobs fall back to hosted runners.

## Journeys `[planned]`

1. **One developer, one button.** Workflows tab, CI runners section, Connect this Mac, pick GitHub. Install the Nekko GitHub App on one repo; Nekko creates a runner group limited to it. Nekko builds the pinned macOS image once (tens of GB) and shows the label to use. The user changes `runs-on` (or adds the picker job), and the next push runs on their Mac in a VM.
2. **A team pools several Macs.** Each person connects their Mac to the same GitHub org, each in their own priority mode. With a Cloud account the fleet view shows which are idle, busy or away, and the picker job falls back to a hosted runner when none is free.
3. **The lid closes mid-job.** macOS announces sleep; the runner marks the slot as leaving. The job is lost and GitHub fails it. An automatic re-run lands on another Mac or a hosted runner. On wake, leftover VMs and disk clones are deleted before anything new starts.
4. **The owner starts a heavy build.** In Do not disturb, local CPU above the threshold for 30 seconds stops new jobs at once. The running job keeps going for the grace period, then the VM is stopped and the job is re-run elsewhere. When the Mac is quiet again the slot comes back on its own.

## Scopes `[planned]`

Every runner is set up per repo or per org (a `Scope`): its own label, trust settings and cache volume. All scopes on a Mac share that Mac's slots, so the 2 macOS VM limit holds however many scopes are connected.

## Priority modes `[planned]`

Exact labels. The default is the first.

| Mode | Meaning | Grace for a running job when a gate fails | Warm VMs while idle | CPU per VM |
|---|---|---|---|---|
| **Do not disturb: Only run when I'm idle** (default) | Only when you are away and plugged in; steps aside the moment you need the Mac | 2 min | 0 (start on demand) | 4 |
| **Balanced: in the background** | Takes jobs while you work if there is headroom; keeps one VM ready | 10 min | 1 | 6 |
| **Runner first** | For a docked Mac that mostly runs CI; jobs finish even when you are busy | until max job time | all slots | all but 2 |

The host always keeps at least 2 cores. A supervisor checks a chain of gates every 5 seconds (switched on, schedule, power, network, headroom, your activity); a slot takes a new job only when every gate passes, and the mode sets the thresholds. Signals come from public macOS APIs and are read on the device only.

**Hard limits for every mode.** These stop a running VM at once: memory pressure critical, thermal state critical, free disk below the floor, Low Power Mode, Off, and Pause all automations. A macOS security update available for more than **7** days blocks new VMs until the Mac is updated.

## Keep awake `[planned]`

Exact labels.

- **System default.** The Mac follows its own Energy settings. If it idles to sleep mid-job, the job is lost and re-run elsewhere.
- **While a runner is active** (default). Holds a sleep-prevention power assertion while any slot is Running or Draining and releases it when the last job ends. The display can still sleep.
- **Always.** Holds the assertion whenever the runner is on and its gates pass.

None can stop sleep when the lid closes on battery, when Low Power Mode turns on, or when the user chooses Sleep. The menu bar indicator shows when Nekko is keeping the Mac awake.

## Limits and defaults `[planned]`

- **macOS slots:** at most **2** VMs at once per Mac, counting macOS VMs started by other apps. Default 1.
- **Linux slots:** default 0. Not counted against the macOS limit.
- **Memory:** 8 GB per VM; total runner memory 50% of RAM by default, at most 75%. Slots that do not fit are greyed out with the reason.
- **CPU per VM:** 4 / 6 / all but 2 by mode.
- **Disk:** image disk budget 150 GB; free disk floor 25 GB (below it no new VM starts and running ones stop).
- **Max job time:** 2 h. The VM is destroyed at the limit whatever the provider's timeout.
- **Only when:** on power, on trusted networks, never on hotspots.
- **Safety:** fork PRs off, re-run lost jobs on, build cache for trusted runs on.

## The sandbox `[planned]`

| Threat | Control |
|---|---|
| A job reads your files, keys or tokens | Separate VM with its own disk. No host folder, clipboard or keychain reaches it. The only secret inside is a single-use runner config. |
| A job attacks your LAN or other devices | The VM's only network is a userspace NAT inside `nekkod` that forwards to public unicast internet addresses only, judged after DNS resolution. |
| A job reaches services on the host | There is no host-to-guest and no guest-to-host network. The NAT answers DHCP and DNS for the guest and forwards nothing to a host address. |
| Malware persists into the next job | Every job starts from a new copy-on-write clone of a read-only golden image; the clone is deleted after the job. |
| A job poisons the build cache | One cache volume per scope, attached only for trusted runs (never fork PRs), size-capped, wipeable from the runner card. |
| A job eats the Mac | Fixed vCPU, RAM and disk per VM, the disk floor, memory and thermal hard limits, max job time. |
| Stolen runner credentials | A JIT config works for one job and expires. The GitHub App private key lives in the macOS keychain and never reaches a guest. |
| Fork PRs run on your Mac | Off by default, and a repo scope shows a warning when it is public. |
| A tampered image | Images are pinned by digest and checked before cloning. |

**Guest network, exactly.** Public unicast internet only. Never RFC 1918, loopback, link-local, 100.64.0.0/10, multicast, broadcast, 0.0.0.0/8, 240.0.0.0/4, 198.18.0.0/15, fc00::/7, fe80::/10, or any host address.

**How the guest gets its config.** `nekkod` mints the single-use JIT runner config and puts it on a read-only seed disk attached to the VM. The host never connects into the guest: no SSH, no host-to-guest network.

**The honest limit.** No software promises zero risk. The target is that a job can only hurt its own VM. The remaining path is a VM-escape bug in macOS itself, the class of bug that affects every desktop virtualization product. It is narrowed by fork code being off by default, the 7-day security-update gate, and the network filter, which gives even an escaped job no LAN access.

## Apple's license `[planned]`

This is a product reading of the macOS license, not legal advice; check the current license text for each supported macOS version before launch.

- Up to 2 additional macOS copies in VMs on each Apple-branded Mac already running macOS. Nekko stops at 2, counts macOS VMs other apps already run, and Virtualization.framework itself refuses a third.
- The purpose is software development and testing. Runners serve only the repos and orgs the owner connects.
- The Mac is one the user owns or controls.
- No service bureau, time-sharing or terminal sharing. Nekko never matches a Mac to accounts outside its owner's orgs: no marketplace and no donate-to-any-project mode.
- Renting whole Macs to a customer is out of scope; a paid runner offering would need legal review first.
- Linux guests are not covered by the macOS VM limit.

## Providers `[planned]`

**GitHub Actions comes first.** Buildkite and GitLab are planned later, behind the same adapter shape (connect, mint a single-job credential, start the agent in the VM, read job status).

| Provider | Connect | One job per VM | Label |
|---|---|---|---|
| GitHub Actions (first) | Install the Nekko GitHub App on an org or repo | A JIT runner config per VM; the runner exits after one job | `self-hosted`, `macOS`, `ARM64`, `nekko-mac` |
| Buildkite (later) | Agent token | Single-job agent flags | `queue=nekko-mac` |
| GitLab (later) | Runner authentication token | One-job runner process | tag `nekko-mac` |

## Laptops that come and go, and the offline fallback `[planned]`

A queued self-hosted job can wait a long time, and a job on a runner that vanishes fails only after the provider loses contact. So the provider is never left waiting on a Mac that may leave:

- **Pick before you queue.** A small job on a hosted runner asks which Mac is free and outputs `runs-on`; with none free it outputs the hosted runner. Without a Cloud account the picker calls the provider's runners API with a read-only token. On a fork PR the token is absent, the call fails and the job falls back to hosted.
- **Announce leaving.** On sleep, lid close, leaving a trusted network or a failed gate, the runner stops being offered at once.
- **Re-run lost jobs.** A job lost because its runner vanished is re-run once automatically.
- **Clean up on wake or launch.** Leftover VMs, clones and runner registrations are removed before a slot opens.

## Free and Nekko Cloud `[planned]`

The runner itself is free in the open source app, with everything on one Mac: sandbox, slots, modes, keep awake, caches, audit log. Fleet features are part of the paid Nekko Cloud plan.

| | Free (open source app) | Nekko Cloud (paid) |
|---|---|---|
| Runner on your Mac | Everything | Same |
| Golden images | You build and host your own from Apple's restore image | Hosted by Cloud, or mirrored from one fleet Mac |
| Picking a Mac | Picker job calls the provider's runner API | Cloud picker endpoint with live presence |
| GitHub App key | In this Mac's keychain | In the Cloud JIT broker |
| Fleet view and notifications | No | Yes, desktop and phone |

Cloud is never required for one Mac.

## Settings and UI `[planned]`

A CI runners section in the Workflows tab: a first-visit card with Connect GitHub, a three-step connect sheet (install the app, choose the org or repo, choose how this Mac helps), a runner card per scope (slots, current job, gates, today's jobs), and runner settings (priority, keep awake, slots, memory, CPU, disk, only-when, safety, max job time). A menu bar indicator shows while any VM runs.

## Phases `[planned]`

- **P0, pilot on our own CI** (internal use only): a docked Mac runs jobs for this repo's own CI, with a picker job that falls back to a hosted runner, trusted events only. Uses Tart internally, never shipped (see the decision record).
- **P1, one Mac, GitHub, local only:** supervisor, the `nekko-vm` helper, VM lifecycle, scopes, caches, the security-update gate, the network filter, GitHub App connect, JIT configs, the CI section with on/off, slots and memory.
- **P2, conditions and modes:** the gate chain, the three modes, drain and grace, Linux slots, audit log, menu bar indicator.
- **P3, Buildkite and GitLab.**
- **P4, Nekko Cloud fleet:** presence, picker endpoint, JIT broker, fleet view.
- **P5, other hosts** if asked.

## Open questions

- Mirroring golden images between fleet Macs (which Mac builds, discovery, behavior when it is offline).
- Default cache cap per scope and eviction when the disk budget is tight.
