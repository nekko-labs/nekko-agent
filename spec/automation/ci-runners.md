---
title: "CI runners"
area: automation
---

# CI runners

**Status: `[planned]` product; T211 helper and NAT implemented and run on a real macOS 15 guest; T212 implemented: the supervisor, the Mac's signals, the VM lifecycle, GitHub App connect and the `runner:*` channels. T213 implemented: the CI runners section (first-visit card, connect sheet, runner card, settings sheet) and the menu bar dot; not yet seen against a live job (T214 pilot). T214 implemented: the image guide and provision script, the picker in Native iOS (off until NEKKO_MAC_RUNNERS is on), nekko-vm signed with its own entitlement in packaged builds; pilot pending.** Verified with the spike example on a macOS 15.7.7 guest: it boots, gets its address by DHCP, resolves through the gateway, and reaches the public internet, while curls from the guest to the host's LAN address, the router, Tailscale addresses, the gateway's other ports and DNS-rebinding names are all refused. Orphan behavior: when the example is SIGKILLed the helper exits about 0.56 s later and `count-vms` returns to 0; when the helper is SIGKILLed the VM is gone about 0.05 s later. Throughput is in [docs/perf-history.md](../../docs/perf-history.md). Not yet verified: the VPN binding against a real tunnel, and one real GitHub job end to end (the T214 pilot). The daemon runs the supervisor whenever the `nekko-vm` helper is staged beside it on an Apple silicon Mac; the UI is the CI runners section of the Workflows tab (T213), documented in [docs/ci-runners.md](../../docs/ci-runners.md); the golden image is built by hand with [docs/ci-runners-image.md](../../docs/ci-runners-image.md), not yet booted in a VM (the check waits on Tart being installed); the pilot runbook is [docs/runbooks/ci-runner-pilot.md](../../docs/runbooks/ci-runner-pilot.md). Not yet done: a Developer ID signed and notarized release with `nekko-vm`. All product journeys and remaining sections below are planned unless explicitly identified as T211 implementation details. Issue: [nekko-labs/nekko-agent#1038](https://github.com/nekko-labs/nekko-agent/issues/1038). Choices behind it: [decision 0022](../../docs/decisions/0022-ci-runners-vm-and-network.md). Tasks: T210 to T214 in [TASKS.md](../../TASKS.md).

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

The host always keeps at least 2 cores. A supervisor checks a chain of gates every 5 seconds (switched on, schedule, power, network, headroom, your activity); a slot takes a new job only when every gate passes, and the mode sets the thresholds. Signals come from public macOS APIs and are read on the device only. Input idle time and power come from the activity sampler; CPU and memory from the system stats, with the job VMs' own processes taken out; thermal state, Low Power Mode and memory pressure from the VM helper's `host` stream (ProcessInfo and a memory pressure source); a pending security update from `softwareupdate --list --no-scan` (an entry titled as a security update, or a macOS update for the running major version, so a declined upgrade to the next major release never blocks runners; when the version cannot be read every macOS update counts), where the 7 days count from the first time nekkod saw it listed; and a trusted network is identified by its router's hardware address (`route` and `arp`), which needs no Location access.

**Hard limits for every mode.** These stop a running VM at once: memory pressure critical, thermal state critical, free disk below the floor, Low Power Mode, Off, and Pause all automations. A macOS security update available for more than **7** days blocks new VMs until the Mac is updated.

### How a slot runs `[implemented, unit-tested; run by the daemon, not yet against a real job]`

Each slot runs one job in a throwaway VM and moves through five states: **starting** (the VM boots and its runner registers), **ready** (online, waiting for a job), **running**, **draining** (a gate failed and the job has its grace period) and **cleaning** (the VM is stopping; its clone and seed are deleted once the VM process has exited, and its registration is removed).

- **Do not disturb** boots a VM only when a job is queued for the runner. **Balanced** keeps one VM ready. **Runner first** keeps every slot ready.
- At most one VM starts per tick across all runners, never more than Apple's cap counting other apps' VMs, and none when the count cannot be read. A VM that fails to start is cleaned up, registration included; after 3 failures in a row the runner shows an error until its settings change or it is switched off and on. A passing GitHub error while registering does not count: the runner waits 30 seconds and tries again. A refused GitHub key shows an error at once, and a runner with no golden image shows "No VM image yet."
- A ready VM above what is wanted stops after 3 minutes idle; one that never comes online stops after 10 minutes.
- Memory headroom, an unknown host state and an overdue security update only stop a new VM from starting. A booted VM without a job stays through them (macOS counts the VM's own memory as used); the hard limits and the mode's soft gates still stop it. Until `softwareupdate` has been read once after nekkod starts, the host state counts as unknown, so new VMs hold; a failed read is retried within a minute.
- A VM we stop is checked once for a job GitHub gave it since the last status poll; such a job is audited as stopped and re-run like any other.
- Runners are named `nekko-<host>-<install>-<unix secs>-<n>`: `<host>` is the Mac's name lowercased to `[a-z0-9-]`, and `<install>` is 8 hex digits generated once per install and kept in `<data>/runners/install-id`. Sweeping stale registrations removes only offline ones named exactly that way for this install, never another Mac's, even one with the same name.
- The max job time counts from when GitHub first reports the runner busy. A job that reaches it is stopped and not re-run. In Runner first, the grace for a failing gate never runs past it.
- When the Mac wakes from sleep (the wall clock moved more than a minute further than the monotonic clock since the last tick, so a slow tick is not a sleep), every VM is killed, `vms/` is cleared, and each lost job is queued for a re-run before anything new starts. Lost or stopped jobs (when "Re-run lost jobs" is on) are re-run once, tried every minute for up to 30 minutes; the queue lives in memory, so a daemon restart forgets it.
- Every job and every failed start appends one line to `<data>/runners/audit.jsonl`: `ts`, `runnerId`, `repo`, `workflow`, `job`, `result` (`finished`, `stopped`, `lost`, `failedToStart` or `notRemoved`), `seconds` and `reason` (gate reasons, `maxJobTime`, `slept`, `removed`, or the error). A `notRemoved` line names a CI registration nekkod could not delete within an hour of its runner's removal (the runner id, its name, and the repo, org, project or group with GitLab's id and base URL) so the owner can delete it by hand. The runner's "today" totals count lines since local midnight, failed starts and `notRemoved` lines excluded. The file is not rotated yet.

## Keep awake `[planned]`

Exact labels.

- **System default.** The Mac follows its own Energy settings. If it idles to sleep mid-job, the job is lost and re-run elsewhere.
- **While a runner is active** (default). Holds a sleep-prevention power assertion while any slot is Running or Draining and releases it when the last job ends. The display can still sleep.
- **Always.** Holds the assertion whenever the runner is on and its gates pass.

None can stop sleep when the lid closes on battery, when Low Power Mode turns on, or when the user chooses Sleep. The menu bar shows it `[implemented T213]`: the tray icon gets a green dot while any VM exists or a runner keeps the Mac awake, and its menu gains the information-only lines `CI runners: N VM(s) running` and `Keeping this Mac awake for CI`.

## Limits and defaults `[planned]`

- **macOS slots:** at most **2** VMs at once per Mac, counting macOS VMs started by other apps. Default 1.
- **Linux slots:** default 0. Not counted against the macOS limit.
- **Memory:** 8 GB per VM. Total runner memory is a setting. The default is a recommendation computed from the Mac's RAM and the owner's usual memory use (the owner keeps the larger of 8 GB and 1.25 times their usual use), shown in settings as "Recommended: N GB for this Mac". It is never above 75% of RAM, whatever the setting says. A VM starts only when macOS reports its memory plus 2 GB available right now; a running VM is not stopped by this check. Slots that do not fit are greyed out with the reason.
- **CPU per VM:** 4 / 6 / all but 2 by mode.
- **Disk:** image disk budget 150 GB; free disk floor 25 GB (below it no new VM starts and running ones stop).
- **Max job time:** 2 h. The VM is destroyed at the limit whatever the provider's timeout.
- **Only when:** on power, on trusted networks, never on hotspots, and not while a VPN carries all the Mac's traffic (a full-tunnel VPN or a Tailscale exit node). The setting **Let jobs use the internet directly while a VPN is on** (off by default) lifts the VPN pause; job traffic still leaves by the physical interface, never the tunnel. Like the other network gates, a VPN coming on drains a running job with the mode's grace (Runner first lets it finish).
- **Accepted ranges:** settings outside these are clamped when loaded: macOS slots 0 to 2, Linux slots 0 (none in P1), memory per VM 4 to 64 GB (0 means 8 GB), total runner memory at least 4 GB (below that, the recommendation), vCPUs per VM at least 2, image disk budget 50 to 4000 GB, free disk floor 10 to 1000 GB, max job time 10 to 1440 minutes. A hand-edited record that cannot be read is skipped, and a file that is not JSON is kept as `runners.json.bad`.
- **Trusted networks:** the networks you approved, recognised by the router's hardware address; connecting adds the current one. At most 32.
- **Unknown Mac state:** no new VM starts while the Mac's state, its egress interface or its addresses are unknown; a running job is not stopped by that alone.
- **Safety:** fork PRs off, re-run lost jobs on, build cache for trusted runs on.

## The sandbox `[planned]`

| Threat | Control |
|---|---|
| A job reads your files, keys or tokens | Separate VM with its own disk. No host folder, clipboard or keychain reaches it. The VM has a display device with no view and no input devices (a macOS guest needs one to boot), so nothing of its screen reaches the host. That display is a paravirtualized GPU (`VZMacGraphicsDeviceConfiguration`): the guest's GPU commands are processed in the host's VM process against the host GPU stack, an accepted risk because a macOS guest does not boot without it, and it supersedes the original "no graphics" constraint. The only secret inside is a single-use runner config. |
| A job attacks your LAN or other devices | The VM's only network is a userspace NAT inside `nekkod` that forwards to public unicast internet addresses only, judged after DNS resolution, and never to the Mac's own addresses or any network the Mac is on, even a public one. |
| A job reaches networks behind your VPN | Every host socket the NAT opens, DNS included, is bound to the Mac's physical interface (Wi-Fi, Ethernet or cellular), so no VPN route, split or full tunnel, ever carries job traffic. With no physical interface, or before it is known, every flow is refused. A full-tunnel VPN pauses the runner by default. Implemented; a check against a real tunnel (Tailscale exit node and subnet route, or a packet-tunnel VPN that enforces routes) is pending, owned by T212. Known risk: a packet-tunnel VPN with includeAllNetworks or enforceRoutes may capture or drop sockets bound to the physical interface (dropping is fail-safe). |
| A job reaches services on the host | There is no host-to-guest and no guest-to-host network. The NAT answers DHCP and DNS for the guest and forwards nothing to a host address. |
| Malware persists into the next job | Every job starts from a new copy-on-write clone of a read-only golden image; the clone is deleted after the job. |
| A job poisons the build cache | One cache volume per scope, attached only for trusted runs (never fork PRs), size-capped, wipeable from the runner card. |
| A job eats the Mac | Fixed vCPU, RAM and disk per VM, the disk floor, memory and thermal hard limits, max job time. |
| Stolen runner credentials | A JIT config works for one job and expires. The GitHub App private key lives in the macOS keychain and never reaches a guest. |
| Fork PRs run on your Mac | A PR runs its own workflow file, so the picker is no boundary. On a public repo: GitHub's approval for all external contributors, and the runner's org group restricted to selected workflows on trusted branches. The VM is the second layer. The connect sheet refuses public repos unless allowed, and then shows the approval callout. |
| A tampered image | Images are pinned by digest and checked before cloning. |

**Guest network, exactly.** Public unicast internet only. Never RFC 1918, loopback, link-local, 100.64.0.0/10, multicast, broadcast, 0.0.0.0/8, 240.0.0.0/4, 198.18.0.0/15, fc00::/7, fe80::/10, or any host address. "Host address" covers the Mac's own interface addresses, every on-link prefix of every host interface, and known WAN or gateway public addresses, because most LANs give devices global IPv6 addresses that the static list allows. The NAT refreshes that list whenever the Mac's network changes.

**Guest network, the P1 details.** Guests are IPv4 only: the guest is 10.233.0.2/24 behind gateway 10.233.0.1, and every IPv6 frame from the guest is dropped. DNS goes through the gateway: 53/udp and 53/tcp to the gateway are forwarded to the physical interface's own resolvers, keeping only ones a guest could connect to anyway (never loopback, link-local, 100.100.100.100 or anything on the LAN, such as the home router, because DNS over TCP is a raw pipe to the resolver); with none left, DNS goes to 1.1.1.1 and 8.8.8.8. Every other packet to the gateway is dropped or reset. The router's public address is learned from the router itself (NAT-PMP, else UPnP), never from an internet lookup, and is refused like the Mac's own addresses; when the router answers neither, a guest can reach that address, a known limit. Each VM holds at most 256 flows at once, a host connect gives up after 15 s, and a guest TCP connection that stops answering (keep-alive probes included) is reset after an idle timeout and frees its slot. The supervisor refuses to start a VM if it cannot read the host's addresses, rather than run with an empty list.

**Guest network and VPNs (T211).** `nekko-vm egress` streams the Mac's physical egress interface from `NWPathMonitor` (the first Wi-Fi, wired or cellular interface on a monitor that excludes tunnels) and whether a tunnel leads the default route. The NAT creates every host socket unconnected, binds it to that interface with `IP_BOUND_IF`, then connects, so split-tunnel routes (a corporate VPN's ranges, Tailscale subnet routes) and full tunnels (an exit node) never carry job traffic. With no physical interface, or before the helper's first report, every flow is refused: TCP gets a reset, UDP and DNS get nothing. `nekkod` restarts the helper if it exits and refuses flows until it reports again. The VPN pause is the `nekko-runner` gate described under Limits; the supervisor that feeds it the helper's report lands with T212. Implemented and unit-tested only (binding checked on lo0); a check against a real tunnel (Tailscale exit node and subnet route, or a packet-tunnel VPN that enforces routes) is pending, owned by T212. Known risk: a packet-tunnel VPN with includeAllNetworks or enforceRoutes may capture or drop sockets bound to the physical interface (dropping is fail-safe).

**Who holds the virtualization entitlement.** Only `nekko-vm` carries `com.apple.security.virtualization`; `nekkod` and the app do not. Dev builds ad-hoc sign it. Packaged builds stage it and sign it with its own entitlements file (the electron-builder `mac.sign` hook for Developer ID, after-pack for unsigned builds), and `scripts/check-mac-entitlements.sh` fails a macOS release or installer build if `nekko-vm` lacks the entitlement, anything else has it, or a file cannot be read. CI proves this with an ad-hoc signed dry-run through the real hook; a Developer ID signed and notarized release is still pending (T214).

**Golden image** `[implemented T214, boot-checked in a VM 2026-10-25, on macOS 26 with Xcode 27.1 2026-10-28]`. Jobs run in clones of an image you build and host yourself in P1, from a Cirrus `macos-tahoe-xcode` base (or Apple's restore image) with `scripts/runner-image/provision.sh`, following [docs/ci-runners-image.md](../../docs/ci-runners-image.md). Tart is used only to build the image, never at job time. In each clone, one root LaunchDaemon (`dev.nekkolabs.runner-boot`) runs the boot script: (1) wait for the `NEKKOSEED` volume; (2) accept exactly one regular file named `jit-config` (GitHub) or `gitlab-runner.toml` (GitLab), 1 byte to 64 KiB, else run nothing and power off; (3) copy it where only the job user can read it and unmount the seed; (4) wait for the auto-login session; (5) run one job as `runner` in that session with `launchctl asuser` (no LaunchAgent; GitLab's runner starts the same way, untested until T215); (6) power off whatever the outcome. With no seed at all the guest stays up and starts nothing. provision.sh makes `runner` a standard user with a random password, logs it in automatically, installs the pinned GitHub Actions runner and gitlab-runner (each checked by SHA-256 from its official release), gives `runner` Homebrew without sudo, and locks the guest down: every admin account and root are disabled (FileVault must be off), no passwordless sudo, SSH, Screen Sharing, Remote Desktop and the Tart guest agent off or removed, and it fails unless `runner` has no sudo, is not an admin, and SSH and Screen Sharing are disabled. An image is rebuilt from the base, never patched. Still planned: pinning images by digest and checking them before cloning, the image disk budget, and an in-app builder.

**How the guest gets its config.** `nekkod` mints the single-use JIT runner config and puts it on a read-only seed disk attached to the VM. The host never connects into the guest: no SSH, no host-to-guest network.

### GitLab guest `[implemented in the Layer E image scripts; untested in a real guest]`

What the golden image must hold for a GitLab runner, read by the image work (T214, Layer E):

- `gitlab-runner` darwin-arm64, version 17.1 or later (`run-single -c` needs it), pinned and checked against the release's published checksum, at `/usr/local/bin/gitlab-runner`. `provision.sh` on the Layer E branch pins 19.5.1.
- The same auto-login `runner` user and LaunchAgent as the GitHub guest (GitLab supports only a user LaunchAgent, never a LaunchDaemon). The boot agent mounts `NEKKOSEED` read-only; when `gitlab-runner.toml` is present it copies it to `~/.nekko/gitlab-runner.toml` (0600), runs `gitlab-runner run-single -c ~/.nekko/gitlab-runner.toml -r nekko --max-builds 1` with no `--wait-timeout` (the supervisor owns idle time), and powers the VM off when the process exits, whatever its exit code. With `jit-config` it runs the GitHub runner as before. Layer E's `nekko-runner-boot.sh` already does all of this.
- `bash` present (the toml sets `shell = "bash"`). The shell executor creates `/Users/runner/builds` and `/Users/runner/cache` (the toml's `builds_dir` and `cache_dir`) under the runner-owned home; the first real guest run is the check.

**The honest limit.** No software promises zero risk. The target is that a job can only hurt its own VM. The remaining path is a VM-escape bug in macOS itself, the class of bug that affects every desktop virtualization product. The planned fork-code default and 7-day security-update gate reduce exposure. The network filter constrains traffic through the guest's virtual NIC, not code that has escaped into a host process; it cannot promise LAN isolation after a VM escape. The guest's paravirtualized GPU (needed for macOS guests to boot) is one more host surface of that kind: its commands run in the host's VM process against the host GPU stack.

## Apple's license `[planned]`

This is a product reading of the macOS license, not legal advice; check the current license text for each supported macOS version before launch.

- Up to 2 additional macOS copies in VMs on each Apple-branded Mac already running macOS. Nekko stops at 2, counts macOS VMs other apps already run, and Virtualization.framework itself refuses a third.
- The purpose is software development and testing. Runners serve only the repos and orgs the owner connects.
- The Mac is one the user owns or controls.
- No service bureau, time-sharing or terminal sharing. Nekko never matches a Mac to accounts outside its owner's orgs: no marketplace and no donate-to-any-project mode.
- Renting whole Macs to a customer is out of scope; a paid runner offering would need legal review first.
- Linux guests are not covered by the macOS VM limit.

## Providers `[planned]`

**GitHub Actions comes first**, then GitLab (T215). Buildkite is planned later, behind the same adapter shape (connect, mint a single-job credential, start the agent in the VM, read job status).

**Connecting GitHub** `[implemented T212]`. The owner makes a GitHub App, installs it on their org or repo, and gives this Mac its app id, installation id and private key (the PKCS#1 `.pem` GitHub downloads, under 16 KB). Before anything is saved, connect checks in order: the key mints an installation token (a refused key fails with "GitHub refused this app key. It may have been revoked; connect again with a new key."); the installation's account is the scope's org or owner, compared in any case, so only the owner's own accounts can be connected; every repo is reachable and private, and a public repo is refused unless the owner turns on public repos; for an org, the runner group `nekko-<label>` is created, or updated, limited to the chosen repos. An org that cannot create runner groups is refused ("This org cannot create runner groups. Connect a single repo instead."), never put in the Default group. Only then is the key stored in the keychain item `github-app-<appId>` of the runner vault, and the runner saved enabled, trusting the network the Mac is on. Any failure leaves nothing stored and nothing registered. Reconnecting a scope replaces its GitHub link and keeps its settings; if it moves to another app, the old app's key is deleted once no runner uses it. An org's runner group is shared by name: its repo list is whatever the last connect for that org and label set, so two Macs connected with the same label share one group. GitHub calls count as connector traffic, so turning connectors off in Settings > Connections also stops the runner from reaching GitHub. A runner whose key is later revoked or removed shows Error, not Waiting; a GitHub rate limit (a 403 whose message names a rate limit) is a passing error, not a revoked key. A repo runner's repo is checked again before each registration: if it became public and public repos are not allowed, the runner shows Error and registers nothing. Owner, org and repo names match in any case wherever scopes are compared.

| Provider | Connect | One job per VM | Label |
|---|---|---|---|
| GitHub Actions (first) | Install the Nekko GitHub App on an org or repo | A JIT runner config per VM; the runner exits after one job | `self-hosted`, `macOS`, `ARM64`, `nekko-cloud-mac` |
| Buildkite (later) | Agent token | Single-job agent flags | `queue=nekko-cloud-mac` |
| GitLab `[implemented T215, not yet run against a live GitLab]` | A project or group access token (or personal token) with `create_runner`, `manage_runner` and `read_api`, from an Owner | A runner created per VM, its token on the seed, `gitlab-runner run-single --max-builds 1`; paused once busy, deleted afterward | tags `nekko-cloud-mac`, `macos`, `arm64`; untagged jobs never; protected branches and tags only by default |

## Laptops that come and go, and the offline fallback `[planned]`

A queued self-hosted job can wait a long time, and a job on a runner that vanishes fails only after the provider loses contact. So the provider is never left waiting on a Mac that may leave:

- **Pick before you queue.** A small job on a hosted runner asks which Mac is free and outputs `runs-on`; with none free it outputs the hosted runner. Without a Cloud account the picker calls the provider's runners API with a read-only token. On a fork PR the token is absent, the call fails and the job falls back to hosted.
- **The picker** `[implemented T214, off until the pilot]`. `scripts/pick-runner.mjs` behind `.github/actions/pick-runner` outputs `["self-hosted","<label>"]` when an online, idle runner has the label, else the fallback (`macos-latest` by default, `macos-14` in Native iOS). It never fails the workflow: no token, an API error, a timeout or a bad reply all give the fallback. It lists the repo's runners, or with an `org` input the org's (an org runner does not appear in the repo's list). In `ios-native.yml` it runs only when the repo variable `NEKKO_MAC_RUNNERS` is `on`, and only for the schedule and dispatches on `main` or `ci/ios-batch`, the refs the runner group allows; a labeled PR always runs hosted. It uses the org from `NEKKO_MAC_RUNNER_ORG` and the fine-grained token `MAC_RUNNER_STATUS_TOKEN` (organization Self-hosted runners: read). A job lost to sleep is re-run, and the re-run keeps the first attempt's answer, so it waits for the same Mac. On a public repo the picker is not a boundary against fork code, since a PR runs its own workflow file: fork PR approval for all external contributors and a runner group restricted to selected workflows on the default branch are, with the VM as the second layer (see the pilot runbook).
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

**GitLab** `[implemented T215, unit-tested with scripted HTTP; never run against a live GitLab]`. A runner record holds a GitHub link or a GitLab link (never both); `runners.json` files written before T215 load unchanged, and GitLab records get ids `gl-<random>`. Instances are self-managed or gitlab.com, given as an https origin; no other scheme is accepted. Connect checks, in order, and stores nothing until all pass:

- The instance's host name must resolve only to public addresses, judged like guest traffic (not this Mac's networks, a LAN, Tailscale or loopback), because the guest must reach it. No request is sent otherwise. No request carrying the token ever follows a redirect; a 3xx is an error that names the redirect host.
- The project or group exists and the token's user can see it. A public project is refused unless the owner allows public projects. A group record lists 1 to 20 projects inside the group, because GitLab has no group-level pending jobs list; the list only drives start-on-demand, while the group runner still takes jobs from every project in the group.
- The token is active and has `create_runner` and `manage_runner` (`api` covers both), read from `/personal_access_tokens/self`, then a probe: a paused runner is created and deleted, which also proves the Owner role (GitLab refuses `POST /user/runners` otherwise). Only then is the token stored in the runner vault item `gitlab-token-<record id>`; it never reaches a guest.

Per VM, nekkod creates one runner with `POST /user/runners`: `locked`, `run_untagged` false, the tags above, `maximum_timeout` from the max job time, and `access_level` `ref_protected` unless the owner unticks "Protected branches and tags only" (default on). Its `glrt-` token goes into `gitlab-runner.toml` on the read-only seed, and the guest runs `gitlab-runner run-single --max-builds 1` from it. nekkod pauses the runner as soon as `GET /runners/:id/jobs?status=running` shows a job (pause fails closed), and deletes it when the VM ends. A failed delete is retried with backoff; auth failures hold a record's removals and show as its error. A removed record is kept up to 1 hour while removals are pending, then nekkod writes a `notRemoved` audit line naming the runner so the owner can delete it by hand. Start-up and a removed record's sweep delete every runner whose description has the exact name shape `nekko-<host>-<install>-<secs>-<n>`; a group sweep keeps any runner not owned by that group (GitLab lists ancestor groups' runners too), and two GitLab group records on one instance never sweep while the other has VMs.

Start-on-demand counts pending jobs per project (a group record counts its listed projects), only those whose tags are all ours and, under protected only, whose branch or tag is protected (looked up once and cached 10 minutes); merge request refs never count, so no VM boots for a job the runner would not take. Matching is provider-aware: a GitHub and a GitLab runner on the same path are separate records, and a GitHub connect never touches a GitLab record. Fork merge requests run on this Mac only when a member runs the pipeline in the parent project ([merge request pipelines](https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/)); with protected only on, merge request pipelines do not run here at all.

**GitLab known limits.** GitLab has no single-use runner, so a job can read its own runner's `glrt-` token inside the guest; the runner is locked, protected-only by default, paused once busy and deleted after, so the token takes nothing after the first job. The access token (365 days by default) is not tracked for expiry; a lapsed token shows the runner as Error with a plain sentence. The desktop has no GitLab connect sheet yet (the channel and the TypeScript types accept it). Nothing has run against a live GitLab or a real guest.

## Settings and UI `[implemented]`

**Channels** `[implemented T212]`. The daemon serves `runner:list()` (every `RunnerView`: settings, state, slots, reasons, available slots and their limit, keep awake, error, today's totals), `runner:connect(request)` (`provider` is `"github"` or `"gitlab"`), `runner:update(id, settings)` (a patch over the saved settings, sanitized), `runner:setEnabled(id, enabled)` and `runner:remove(id)` (stops its VMs; once they are cleaned and its failed registration removals have worked, or after a 1 h hold, removes its offline registrations and deletes its credential: the GitHub app key if no other runner or queued removal uses that app, or the GitLab record's `gitlab-token-<id>`), and pushes `runner:changed` with every view whenever they change. Channel calls never wait for the supervisor: `runner:list` answers from the last published views, and a change is saved, shown at once, and applied on the next tick (even while a VM is still booting). An unknown id is "No runner with that id.". Without the helper (or off Apple silicon) every enabled runner shows Error with "VM support unavailable" and nothing starts.

**The section** `[implemented T213, not yet seen against a live job]`. Workflows gains a **Workflows | CI runners** switch. CI runners shows one plain sentence when the daemon serves no runners (`runner:list` rejects), a first-visit card with Connect GitHub when none is connected, and otherwise a runner card per scope: title and state, the slots (job, elapsed time, or the slot limit's sentence on a greyed slot), every waiting reason as a sentence, power, network (trusted or not, with its router), today's jobs, recent jobs, and the on switch. The connect sheet has three steps (install the app: App ID, installation ID, private key; org or repo with repos, Allow public repos and the runner label; how this Mac helps with the three modes, plus the outside-collaborator callout when public repos are allowed); GitHub's refusal shows inline at step 3 and the pasted key lives only in the sheet until it closes or connects. The settings sheet shows the runner switch, priority, keep awake, macOS slots (0, 1, 2 and a disabled "3 not allowed"), memory per VM (4 to 64 GB), total runner memory (the recommendation, shown as "Recommended: N GB for this Mac", or a figure up to 75% of RAM), CPU per VM (mode default or 2 to cores minus 2), disk (image budget 50 to 4000 GB, keep free 10 to 1000 GB), only when (on power, trusted networks, never on hotspots, and "Let jobs use the internet directly while a VPN is on"), trusted networks (at most 32, with Trust this network), safety (re-run jobs lost to sleep), max job time, and Remove runner; after Save it shows what the daemon kept. P1 shows no Linux slots, schedule, fork pull request or build cache controls; their stored values pass through unchanged. The menu bar dot is under Keep awake. User docs: [docs/ci-runners.md](../../docs/ci-runners.md).

## Phases `[planned]`

- **P0, pilot on our own CI** (internal use only): a docked Mac runs jobs for this repo's own CI, with a picker job that falls back to a hosted runner, trusted events only. Uses Tart internally, never shipped (see the decision record).
- **P1, one Mac, GitHub, local only:** supervisor, the gate chain, the three priority modes, drain and grace, keep awake, the `nekko-vm` helper, VM lifecycle, scopes, caches, the security-update gate, the network filter, GitHub App connect, JIT configs, the audit log, the CI section with on/off, slots and memory, and the menu bar indicator. Total runner memory is a setting with a recommended value for the Mac.
- **P2, more of one Mac:** Linux slots and the in-app image builder from Apple's restore image.
- **P3, Buildkite and GitLab.** GitLab landed early as T215 (unverified against a live job); Buildkite is still deferred.
- **P4, Nekko Cloud fleet:** presence, picker endpoint, JIT broker, fleet view.
- **P5, other hosts** if asked.

## Open questions `[planned]`

- Mirroring golden images between fleet Macs (which Mac builds, discovery, behavior when it is offline).
- Default cache cap per scope and eviction when the disk budget is tight.
