---
status: proposed
date: 2026-11-11
---

# 0082. CI runners on a Windows PC use Hyper-V, an Internal switch and a filtering proxy

## Context

Philip asked (2026-11-11) for a Windows PC to take Windows and Linux CI jobs, as an Apple silicon
Mac takes macOS and Linux ones. The runner engine builds for Unix only and every VM goes through
`nekko-vm` on Virtualization.framework, whose guest NICs hand raw frames to the userspace NAT in
`nekkod` ([decision 0022](0022-ci-runners-vm-and-network.md)). Windows has no such attachment.
The promises do not change: one job per throwaway VM, nothing shared from the host, public
internet only, your work first. Full design: [reports/ci-runners-windows-host-design.md](../../reports/ci-runners-windows-host-design.md).
Issue [#2553](https://github.com/nekko-labs/nekko-agent/issues/2553).

## Options considered

**Virtualization**

1. **Hyper-V.** Built into Windows Pro, Enterprise and Education; differencing disks; Gen 2
   guests for Windows and Linux; no third-party install. Not on Windows Home.
2. **Windows Sandbox.** Boots the host's own Windows, so no golden image; one instance on most
   builds; an unfiltered NAT.
3. **WSL 2.** One shared VM and kernel, host drives mounted, the host's network. No boundary.
4. **VirtualBox or VMware.** Third-party installs and licenses, and they contend with Hyper-V.

**Guest network**

5. **Internal switch, no NAT, `nekkod` as DHCP, DNS and an HTTP CONNECT proxy** applying the
   Mac NAT's deny list after DNS, host sockets bound to the physical interface, and firewall
   rules on the switch's vNIC. Tools that ignore proxy settings get no network.
6. **A packet driver (Npcap or WinDivert) feeding the Mac's userspace NAT.** Transparent, same
   filter code, but a third-party kernel driver and its license.
7. **`NetNat` with Windows Firewall outbound rules.** Forwarded traffic is not filtered reliably,
   and the rules cannot follow DNS answers.

**Windows guest**

8. **Windows Server 2025 evaluation** (180 days, rebuilt before expiry).
9. Windows 11 developer evaluation VM. 10. The owner's own licensed ISO.

## Decision

Proposed: 1, 5 and 8. Hyper-V is the only built-in hypervisor that gives real per-job VMs with
cloneable images. The Internal switch with no route out makes the host the boundary without a
kernel driver, and it fails closed. Philip chose the Windows Server evaluation on 2026-11-11.
`nekkod` stays unelevated: setup asks once, through UAC, to add the user to **Hyper-V
Administrators** and install the firewall rules. That step is a new permission and needs
Philip's approval before it ships.

## Consequences

- The shared supervisor gains `VmHost` and `HostSignals` seams; macOS keeps `nekko-vm`.
- PCs register `X64` labels (`<label>-windows`, `<label>-linux`); Macs stay `ARM64`, so neither
  takes the other's jobs.
- Jobs whose tools ignore `HTTPS_PROXY` fail on a PC. If real jobs hit that often, option 6 is
  the fallback, as a new decision.
- Heat and Low Power Mode gates have no Windows source and are left out there; the security
  update gate is deferred.
- The evaluation license needs a read before launch; an expiring image is rebuilt from the card.
