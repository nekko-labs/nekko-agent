---
title: "CI runners"
area: automation
---

# CI runners

**Status: `[planned]` product; T211 helper and NAT implemented and run on a real macOS 15 guest.** Verified with the spike example on a macOS 15.7.7 guest: it boots, gets its address by DHCP, resolves through the gateway, and reaches the public internet, while curls from the guest to the host's LAN address, the router, Tailscale addresses, the gateway's other ports and DNS-rebinding names are all refused. Orphan behavior: when the example is SIGKILLed the helper exits about 0.56 s later and `count-vms` returns to 0; when the helper is SIGKILLed the VM is gone about 0.05 s later. Throughput is in [docs/perf-history.md](../../docs/perf-history.md). Not yet verified: the VPN binding against a real tunnel. Nothing in the app starts a runner yet: the runner is not wired into the shipped daemon until T212. All product journeys and remaining sections below are planned unless explicitly identified as T211 implementation details. Issue: [nekko-labs/nekko-agent#1038](https://github.com/nekko-labs/nekko-agent/issues/1038). Choices behind it: [decision 0022](../../docs/decisions/0022-ci-runners-vm-and-network.md). Tasks: T210 to T214 in [TASKS.md](../../TASKS.md).

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
| Fork PRs run on your Mac | Off by default, and a repo scope shows a warning when it is public. |
| A tampered image | Images are pinned by digest and checked before cloning. |

**Guest network, exactly.** Public unicast internet only. Never RFC 1918, loopback, link-local, 100.64.0.0/10, multicast, broadcast, 0.0.0.0/8, 240.0.0.0/4, 198.18.0.0/15, fc00::/7, fe80::/10, or any host address. "Host address" covers the Mac's own interface addresses, every on-link prefix of every host interface, and known WAN or gateway public addresses, because most LANs give devices global IPv6 addresses that the static list allows. The NAT refreshes that list whenever the Mac's network changes.

**Guest network, the P1 details.** Guests are IPv4 only: the guest is 10.233.0.2/24 behind gateway 10.233.0.1, and every IPv6 frame from the guest is dropped. DNS goes through the gateway: 53/udp and 53/tcp to the gateway are forwarded to the host's resolvers, which the supervisor chooses and which are never a loopback resolver or 100.100.100.100; every other packet to the gateway is dropped or reset. Each VM holds at most 256 flows at once, a host connect gives up after 15 s, and a guest TCP connection that stops answering (keep-alive probes included) is reset after an idle timeout and frees its slot. The supervisor refuses to start a VM if it cannot read the host's addresses, rather than run with an empty list.

**Guest network and VPNs (T211).** `nekko-vm egress` streams the Mac's physical egress interface from `NWPathMonitor` (the first Wi-Fi, wired or cellular interface on a monitor that excludes tunnels) and whether a tunnel leads the default route. The NAT creates every host socket unconnected, binds it to that interface with `IP_BOUND_IF`, then connects, so split-tunnel routes (a corporate VPN's ranges, Tailscale subnet routes) and full tunnels (an exit node) never carry job traffic. With no physical interface, or before the helper's first report, every flow is refused: TCP gets a reset, UDP and DNS get nothing. `nekkod` restarts the helper if it exits and refuses flows until it reports again. The VPN pause is the `nekko-runner` gate described under Limits; the supervisor that feeds it the helper's report lands with T212. Implemented and unit-tested only (binding checked on lo0); a check against a real tunnel (Tailscale exit node and subnet route, or a packet-tunnel VPN that enforces routes) is pending, owned by T212. Known risk: a packet-tunnel VPN with includeAllNetworks or enforceRoutes may capture or drop sockets bound to the physical interface (dropping is fail-safe).

**Who holds the virtualization entitlement.** Only `nekko-vm` carries `com.apple.security.virtualization`; `nekkod` and the app do not. Dev builds ad-hoc sign it; release packaging and signing land with T213/T214, together with a signed release dry-run, and until then packaged builds report no VM support.

**How the guest gets its config.** `nekkod` mints the single-use JIT runner config and puts it on a read-only seed disk attached to the VM. The host never connects into the guest: no SSH, no host-to-guest network.

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

A CI runners section in the Workflows tab: a first-visit card with Connect GitHub, a three-step connect sheet (install the app, choose the org or repo, choose how this Mac helps), a runner card per scope (slots, current job, gates, today's jobs), and runner settings (priority, keep awake, slots, memory with "Recommended: N GB for this Mac", CPU, disk, only-when, safety, max job time). A menu bar indicator shows while any VM runs.

## Phases `[planned]`

- **P0, pilot on our own CI** (internal use only): a docked Mac runs jobs for this repo's own CI, with a picker job that falls back to a hosted runner, trusted events only. Uses Tart internally, never shipped (see the decision record).
- **P1, one Mac, GitHub, local only:** supervisor, the gate chain, the three priority modes, drain and grace, keep awake, the `nekko-vm` helper, VM lifecycle, scopes, caches, the security-update gate, the network filter, GitHub App connect, JIT configs, the audit log, the CI section with on/off, slots and memory, and the menu bar indicator. Total runner memory is a setting with a recommended value for the Mac.
- **P2, more of one Mac:** Linux slots and the in-app image builder from Apple's restore image.
- **P3, Buildkite and GitLab.**
- **P4, Nekko Cloud fleet:** presence, picker endpoint, JIT broker, fleet view.
- **P5, other hosts** if asked.

## Open questions `[planned]`

- Mirroring golden images between fleet Macs (which Mac builds, discovery, behavior when it is offline).
- Default cache cap per scope and eviction when the disk budget is tight.
