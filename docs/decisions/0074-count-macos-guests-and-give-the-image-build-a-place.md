---
status: accepted
date: 2026-11-09
---

# 0074. Count only macOS guests against Apple's cap; an image build takes a place from idle runner VMs

## Context

Apple's Virtualization framework allows two macOS guests per Mac. `nekko-vm count-vms` counted every
framework VM process, because a Linux guest's process looks the same ([decision 0053](0053-linux-runner-vms-boot-ubuntu-directly.md)).
So Docker Desktop's Linux VM took one of the two places.

The image builder waits for a free place before its stages, and the supervisor never gave one up.
On 2026-11-09 a Tools update waited with no end: Docker's Linux VM and Nekko's own ready runner VM
made a count of 2.

## Decision

- **A macOS guest is counted by its identity process.** Each macOS guest runs a
  `com.apple.Virtualization.AppleVirtualPlatformIdentity` process (AppleVirtualPlatform's Virtio
  identity plugin) beside its `com.apple.Virtualization.VirtualMachine` process. A Linux guest has
  none. Seen on macOS 27.2: two macOS guests, two identity processes; Docker Desktop's Linux VM,
  none. `count-vms` prints `{"count":N,"macos":M}`, `M` at most `N`. nekkod reads `macos` (and
  `count` from an older helper).
- **The count never drops below what nekkod knows.** The supervisor takes the larger of `macos` and
  its own macOS runner VMs plus the build's VMs, so a helper that misses ours never adds a third.
- **An image build takes one place from the runners.** From its first stage that boots a VM to its
  end, the build wants a place. The supervisor then counts one more macOS VM than the helper sees
  while the build has none up (between stages, or before it starts), so it starts no VM and refills
  no slot. An idle runner VM that no longer fits stops at once, not after the 3 idle minutes. A
  running job is never stopped: the build waits for it and says "Waiting for a CI job to finish".
- **Only stages that boot a VM wait for a place**: Install, Xcode, Lockdown, Tools and Test. Check,
  Download, Scripts and Finish do not.

## Consequences

- Docker Desktop, OrbStack and other Linux VMs no longer block macOS runner VMs or a build.
- If Apple ever starts a macOS guest without the identity process, another app's macOS VM is missed.
  Apple still enforces its cap, so the extra VM fails to start with Apple's error: a runner VM counts
  toward the 3 failures in a row, and a build stage fails and can be resumed.
- While a build runs, a runner has one macOS VM fewer. With another app's macOS VM up as well, it
  has none until the build ends.
