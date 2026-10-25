---
status: accepted
date: 2026-10-24
---

# 0022. CI runners: our own VM helper, a userspace network, and a seed disk

## Context

A Mac running Nekko Agent can become a CI runner ([spec](../../spec/automation/ci-runners.md), issue #1038): each job runs in a throwaway macOS VM that must not reach the host or the LAN. The product design first sketched a third-party VM tool and a privileged network helper. Four things need deciding: the VM layer, the guest network, how the guest receives its credential, and where the GitHub App key lives.

## Options considered

**VM layer**

1. **Tart.** Mature, ready-made clone and run commands. Its license is FSL-1.1-ALv2 (relicensed 2026-06-05): internal use is permitted, but shipping it inside a commercial product that offers substantially similar functionality is a "Competing Use" until each version becomes Apache 2.0 two years after its release. A CI runner product is that.
2. **Our own Swift helper, `nekko-vm`, on Apple's Virtualization.framework.** More to build, but no third-party license limit, and it follows Apple's own virtualization API.

**Guest network**

3. **vmnet plus a signed privileged network helper** that filters. Needs a privileged component and its signing, registration and review.
4. **A userspace NAT inside `nekkod`**, on a `VZFileHandleNetworkDeviceAttachment`, forwarding only to public internet addresses and checking the address after DNS resolution. No privilege needed.

**Guest credential**

5. **SSH or a host-to-guest network** to push the runner config in. Opens a path from host to guest.
6. **A read-only seed disk** holding the single-use JIT config, attached at boot.

**GitHub App private key**

7. A file or setting in the app's data folder.
8. **The macOS keychain** (Cloud's broker holds it later, in the paid plan).

## Decision

- **`nekko-vm`, our own Swift helper**, staged beside `nekkod` like `nekko-speech`. Tart is used only for the P0 pilot on our own CI (internal use). The shipped app uses `nekko-vm`, and no Tart code is copied. Reading the same VM bundle file layout is fine (our product reading of the license, not legal advice).
- **A userspace NAT inside `nekkod`.** The guest's only network forwards to public unicast addresses, checked after DNS resolution; never RFC 1918, loopback, link-local, 100.64.0.0/10, multicast, broadcast, 0.0.0.0/8, 240.0.0.0/4, 198.18.0.0/15, fc00::/7, fe80::/10, or any host address. The check has two parts: a static allow-list of globally reachable unicast, plus the host's own networks (every interface address, every on-link prefix of every host interface, and known WAN or gateway public addresses), rebuilt whenever the host's network changes. The static list alone is not enough, because most LANs give the Mac and every device global IPv6 addresses and a Mac or router may hold a public IPv4. There is **no privileged network helper**. This supersedes the "privileged network helper" in the HTML design, because every privileged piece is a new attack surface and a new thing to sign, and a userspace NAT can enforce the same rule where the packets already pass.
- **The JIT config reaches the guest on a read-only seed disk.** The host never connects into the guest: no SSH, no host-to-guest network.
- **The GitHub App private key lives in the macOS keychain.** Guests only ever receive a single-use JIT config.

## Consequences

- We own the VM lifecycle code (clone, boot, stop, delete) and must keep up with macOS releases. Reading Tart's bundle layout lets us share images during the pilot.
- The NAT is our code on the packet path: it needs unit tests for the address rules and a guest-side escape test (port scan of the host and LAN) before release. It is slower than vmnet, which is acceptable for CI traffic; measure it.
- No helper to install means no extra permission prompt, and a smaller review.
- If a user must run more than 2 macOS VMs or rent capacity, the license, not this design, is the limit (see the spec).
- We were wrong if the NAT cannot hold download-heavy jobs at usable speed, or a guest reaches a non-public address.

## Implementation notes (T211)

Added 2026-10-24. These record how T211 built the decision above; the decision itself is unchanged.

- P1 guests are IPv4 only (10.233.0.2/24, gateway 10.233.0.1). Every IPv6 frame from the guest is dropped.
- DNS goes through the gateway: 53/udp and 53/tcp are forwarded to the host's resolvers, chosen by the supervisor and never a loopback resolver or 100.100.100.100. The gateway answers DHCP and DNS only.
- At most 256 flows per VM, a 15 s host connect timeout, and an idle TCP timeout (60 s, with 30 s keep-alive probes) that resets a guest connection that stops answering and frees its slot.
- `nekko-vm` alone carries `com.apple.security.virtualization`. Dev builds ad-hoc sign it; release packaging and signing land with T213/T214 together with a signed release dry-run.
- The supervisor refuses to start a VM if the host's addresses cannot be read; there is no empty-list fallback.
- `nekko-vm` gives the guest a display device with no view and no input devices: one `VZMacGraphicsDeviceConfiguration` (1024x768 at 72 ppi), no `VZVirtualMachineView`, no keyboard or pointing device. A macOS guest does not boot without a graphics device (measured in T211: with none it never brought up its network); with no view, nothing of its screen reaches the host. There is still no shared folder, clipboard, serial console, audio or USB.
- A guest with a logged-in console session ignores `requestStop`, so SIGTERM ends in the helper's 20 s hard stop. That is acceptable: the clone is deleted after every job.
- VPN routes never carry job traffic (decided by Philip 2026-10-25). `nekko-vm egress` reports the physical egress interface from `NWPathMonitor` (first wifi, wired or cellular interface on a monitor that prohibits `.other`) and whether a tunnel leads the default path. `net::Direct` binds every host socket, DNS upstreams included, to that interface with `IP_BOUND_IF` before connecting, and refuses every flow with no interface or before the first report. A full-tunnel VPN or exit node pauses the runner (soft gate `vpnCarriesAllTraffic`) unless the runner setting `allowDirectWithVpn` is on; either way traffic leaves by the physical interface. This replaces the earlier plan to refuse destinations by route.
