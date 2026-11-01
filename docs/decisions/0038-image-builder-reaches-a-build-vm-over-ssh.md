---
status: accepted
date: 2026-11-01
---

# 0038. The image builder reaches a build VM over SSH, from Apple's restore image, with no shared folder

Amends [0022](0022-ci-runners-vm-and-network.md) for build VMs only. Every rule 0022 sets for job VMs stands.

## Context

A new user should go from nothing to a Mac that takes CI jobs without a terminal, so Nekko has to build the VM image itself. Decision 0022 keeps Tart out of the shipped app (its license treats a similar product as competing use) and says the host never connects into a VM. Today's image guide uses `tart exec` and a Tart shared folder, so an in-app flow needs a replacement for both, and it needs a base image.

Tested on this Mac on 2026-11-01 (M1 Max, macOS 27.0.1): Apple's restore image installs headless with `VZMacOSInstaller` and macOS 27's first-boot options create an admin with Remote Login on, with no window. A real GitHub job then passed on the result.

## Options considered

**Where the image comes from**

1. **Apple's restore image, built on this Mac.** 25.6 GB plus the 8.3 GB iOS simulator. Depends only on Apple. First-boot options need macOS 27 on host and guest.
2. **Cirrus images, pulled directly.** 70.8 to 77 GB, a registry client for 260 chunks of Apple LZ4, and an admin password that is public until lockdown.
3. **A Nekko-hosted image.** Ruled out: the Xcode agreement bars hosting it (section 2.7).

**How files get in**

4. **`virtio-fs`.** It dropped all 11,204 symlinks in Xcode, which broke its signature. Gatekeeper then showed a dialog nobody could see, and the build waited four hours.
5. **A `tar` stream over SSH.** Keeps the symlinks, and needs nothing SSH does not already give.

## Decision

Options 1 and 5. `nekko-vm` gains `restore-image` (the catalog call fails without the virtualization entitlement, so it cannot live in `nekkod`), `install` and first-boot options on `run`. A job in `nekkod` builds in `images/default.new`, and swaps the result in only after a test boot passes.

A build VM is the one exception to "the host never connects into a VM":

| | Job VM (unchanged) | Build VM |
| --- | --- | --- |
| What runs | Other people's code | Apple's OS, the owner's Xcode, our pinned scripts. Never a job |
| Host path in | None | SSH on a loopback port, until lockdown turns SSH off |
| Network | Public internet only, through the NAT | The same |
| Credentials | One-time runner config | A random password in the keychain during the build, so a quit can resume. Deleted at the end, and useless after lockdown |

The forward lives in `NetConfig`, which job code builds through `job_net_config`. `HelperVm::start_build` is the only place that sets it. It is an inherent method, not part of the `Vm` trait, so the supervisor, which is generic over `Vm`, cannot reach it. A test scans the job path for it.

## Consequences

- First-boot setup needs macOS 27 on the host. Older Macs see "Update this Mac to macOS 27 to set it up here." and keep the [bring your own image](../ci-runners-image.md) guide.
- `nekko-vm` needs the macOS 27 SDK to carry first-boot support. Built with an older SDK it still builds, and a build stops at first boot with that same sentence.
- `tart run` with a window is gone as a debugging aid: the build log and `provision.sh`'s log, read from the stopped disk, replace it.
- Lockdown still proves itself: `provision.sh` turns SSH off partway, so nothing can be asked afterwards. `nekkod` reads its proof file from the disk read-only, and no proof file fails the build, even after a clean stop.
- Every guest command has a time limit, because the Gatekeeper stall above produced no output at all.
