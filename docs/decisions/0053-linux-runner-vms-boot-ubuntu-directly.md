---
status: accepted
date: 2026-11-05
---

# 0053. Linux runner VMs boot Ubuntu's own kernel directly, ARM64 only, with Docker

## Context

Apple's macOS license caps a Mac at two macOS VMs, and Virtualization.framework enforces that.
Linux guests are not covered by that limit (Apple DTS confirmed on the developer forums that
the cap applies only to `VZMacPlatformConfiguration` guests). Most CI jobs (lint, unit tests,
server builds) do not need macOS, so Linux slots are the largest capacity gain one Mac can
give. Philip asked for them on 2026-11-05 and chose Ubuntu 24.04, Docker in the image, and
ARM64 only. Spec: [CI runners](../../spec/automation/ci-runners.md).

Decision [0022](0022-ci-runners-vm-and-network.md) still holds: no shared folders, the
filtered userspace NAT as the only network, and the job's credential on a read-only seed disk.

## Options considered

**Boot path**

1. **EFI boot of Ubuntu's qcow2 cloud image.** The "normal" disk, but it needs a qcow2 to raw
   converter (macOS has none) and an EFI variable store per bundle.
2. **`VZLinuxBootLoader` with Ubuntu's published kernel, initrd and ext4 root filesystem**
   (`unpacked/*-vmlinuz-generic`, `*-initrd-generic`, and the `.img` inside `*.tar.gz`). Only
   `gunzip` and `tar`, both on every Mac. The kernel is the image's, fixed at build time; a
   rebuild picks up a newer one.

**Provisioning**

3. **SSH into a build VM**, as the macOS builder does (decision 0038). Needs a forward in and
   a build admin.
4. **cloud-init from a CIDATA seed**, with the provision script as user-data. The guest
   provisions itself over the NAT and powers off; nekkod reads the result from the console.
   No path into the guest.

**x86_64 jobs**

5. **Rosetta for Linux.** Needs a `VZLinuxRosettaDirectoryShare`, a shared folder, which 0022
   forbids for guests that run untrusted jobs.
6. **ARM64 only.** Linux VMs register `Linux` and `ARM64`, never `X64`, so an amd64 job is
   never counted or sent here.

## Decision

Options 2, 4 and 6.

- **Bundle:** `config.json` (`"os": "linux"`, `macAddress`), `disk.img` (the ext4 root grown
  to a sparse 64 GB), `vmlinux` (uncompressed arm64 Image) and `initrd`. `nekko-vm` builds a
  `VZGenericPlatformConfiguration` with a fixed kernel command line, no graphics device and the
  same disks, NAT and virtio console as a macOS job.
- **Image:** `runners/images/linux`, built by `linux_image.rs` from Canonical's current noble
  images, each checked against the `SHA256SUMS` beside it over HTTPS. Docker Engine from
  Ubuntu's archive (`docker.io`), the same runner pins as the macOS image, passwordless `sudo`
  for the `runner` user (uid 1001, as on GitHub's hosted Ubuntu). SSH, snapd and unattended
  upgrades are removed, cloud-init is disabled after its one run, and the machine id is cleared
  so every clone makes its own.
- **Clock:** the guest has no clock of its own and boots at the image's build date, which apt
  and TLS refuse. Both scripts set the clock forward to the seed file's time, which nekkod wrote
  moments earlier. NTP corrects it later where the network allows.
- **Scheduling:** Linux slots (0 to 8) have no Apple cap. They share the runner memory budget
  after the macOS slots that may run, so Linux never takes a macOS VM's place. They boot only
  for a queued Linux job (no warm VMs). nekkod's own Linux VMs are subtracted from
  `count-vms` before Apple's cap is applied; other apps' Linux VMs still count against it,
  because a framework VM process does not say which kind it is. Superseded by
  [decision 0074](0074-count-macos-guests-and-give-the-image-build-a-place.md): `count-vms`
  now counts macOS guests only.
- **Labels:** a Linux VM registers `self-hosted, Linux, ARM64, <label>-linux` on GitHub and
  `<label>-linux,linux,arm64` on GitLab, so a job asking for one kind never lands on the other.

## Consequences

- A job that needs amd64 binaries or images stays on hosted runners.
- The guest kernel is Ubuntu's at build time; kernel updates arrive with **Rebuild Linux image**.
- A queued job whose labels fit both kinds (only `self-hosted`) counts for both, so one VM of
  each may boot; the one that gets no job stops after the usual 3 idle minutes.
- The `SHA256SUMS` files' GPG signatures are not checked (a `shortcut:` in the code); HTTPS to
  Canonical is the trust root for now.
- Docker Desktop on the same Mac (a Linux VM of another app) still takes one of Apple's two
  macOS places in our count, as before. No longer so since
  [decision 0074](0074-count-macos-guests-and-give-the-image-build-a-place.md).
