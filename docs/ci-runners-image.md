# Build the CI runner image

[CI runners](ci-runners.md) run each job in a throwaway clone of a macOS image you build once.
This page builds that image.

## What the image is

A macOS VM bundle in Tart's format: `config.json`, `disk.img` and `nvram.bin`. Nekko never runs
it. For every job it makes a copy-on-write clone, boots the clone with a small read-only seed
disk that holds the job's one-time runner config, and deletes the clone when the job ends. So
the image itself never runs a job, and nothing a job does survives it.

## What you need

- An Apple silicon Mac.
- About 150 GB free: the Xcode base image is large, and building it needs room for a copy.
- [Tart](https://tart.run), to build the image only. Nekko does not use Tart to run jobs.
- FileVault off in the base image (Cirrus images have it off). `provision.sh` disables every
  admin, so with FileVault on nobody could unlock the disk and the VM would wait at the unlock
  screen forever.

## Build it

From the root of this repo:

```bash
tart clone ghcr.io/cirruslabs/macos-tahoe-xcode:<tag> nekko-golden
tart run --no-graphics --dir runner-image:scripts/runner-image:ro nekko-golden &
tart exec nekko-golden sudo mv /Applications/Xcode_<tag>.app /Applications/Xcode.app
tart exec nekko-golden sudo bash "/Volumes/My Shared Files/runner-image/provision.sh"
tart stop nekko-golden
mkdir -p ~/.nekko-agent/runners/images/default
cp -c ~/.tart/vms/nekko-golden/{config.json,disk.img,nvram.bin} ~/.nekko-agent/runners/images/default/
```

Pick `<tag>` from the [Cirrus image list](https://github.com/cirruslabs/macos-image-templates)
for the Xcode your jobs need. `--dir` shares `scripts/runner-image` into the guest read-only, so
`provision.sh` finds the boot script and LaunchDaemon beside it. Cirrus installs Xcode as
`Xcode_<version>.app`, and `provision.sh` refuses that name (the job user cannot `sudo
xcode-select`), so rename it first. `tart exec` stops working once `provision.sh` has run: it
removes the Tart guest agent it runs through, and disables the admin `tart exec` runs as.

`~/.nekko-agent` is Nekko's data folder (or `$NEKKO_DATA_DIR` when you set it). `cp -c` clones
the files on APFS, so the copy is instant and takes no extra space until one side changes.
After copying you can `tart delete nekko-golden`.

The runner card shows `No VM image yet.` until `runners/images/default/` holds all three files.

## From Apple's restore image

To use no third-party content at all, start from Apple's own restore image instead:

```bash
tart create --from-ipsw latest nekko-golden
tart run nekko-golden
```

Go through Setup Assistant by hand with one admin account, install Xcode and anything else your
jobs need, then share `scripts/runner-image` in and run `sudo bash provision.sh` in the guest's
Terminal. Stop the VM and copy the three files as above.

## What provision.sh does

1. Checks it runs as root on Apple silicon with macOS 14 or later, that no Xcode is named
   `Xcode_*.app` (rename it to `Xcode.app`: the job user cannot `sudo xcode-select`), that
   `/Users/runner` is free, and that FileVault is off. Cirrus images link `/Users/runner` to the
   admin's home for GitHub-hosted compatibility; that link is replaced, a real folder there stops
   the script. When `/Applications/Xcode.app` exists it selects it and accepts its license.
2. Creates the job user `runner`, a standard account (not an admin) with a random password that
   is never shown or saved. It copies the existing admin's Setup Assistant answers so `runner`'s
   first login shows no assistant, and turns its screen saver off.
3. Logs `runner` in automatically at boot, so jobs get a real GUI session for simulators and the
   keychain. It writes `/etc/kcpassword` (root only, mode 0600) and `autoLoginUser` itself:
   `sysadminctl -autologin set` writes nothing on macOS 15 in a VM and still reports success.
   That file is fine because `runner` is not an admin and cannot become root.
4. Downloads the pinned GitHub Actions runner, checks its SHA-256, and unpacks it into
   `/Users/runner/actions-runner`. It never registers it: each job's one-time config does that.
5. Downloads the pinned `gitlab-runner` to `/usr/local/bin`, checks its SHA-256. Not registered,
   no service.
6. Installs the boot script at `/usr/local/libexec/nekko-runner-boot.sh` and its LaunchDaemon
   `dev.nekkolabs.runner-boot`. At each boot of a clone it reads the seed, starts one job as
   `runner`, and powers the VM off when the job ends, fails, or the seed is wrong.
7. Gives `runner` ownership of `/opt/homebrew`, so jobs can `brew install` without sudo.
8. Turns off sleep, Spotlight indexing and automatic update downloads and installs (macOS,
   critical and configuration data updates). macOS 15 restores the automatic update check at
   boot, so a job VM may still check for updates; the download and install settings stay off.
9. Locks the guest down: every account in the `admin` group, however it got there (listed
   members, primary group 80, nested groups) and root included, is disabled (a base image's admin password is
   public, Cirrus's is `admin`, and root cannot change a secure-token admin's password without the
   old one, so disabling is what stops a job from `su admin`), every file in
   `/etc/sudoers.d` goes (and it fails if `/etc/sudoers` still allows passwordless sudo), SSH,
   Screen Sharing and Apple Remote Desktop are turned off, and Cirrus Labs' LaunchDaemons,
   LaunchAgents and the Tart guest agent are removed. Then it checks the result: it fails unless
   `sudo -l -U runner` says `runner` may not use sudo, `runner` is not in the `admin` group,
   `launchctl` lists SSH and Screen Sharing as disabled, every admin and root are refused
   authentication, and every local user got a plain answer from
   `dsmemberutil` (anything else stops it). Root keeps working for the system and for `sudo`; it
   just cannot be logged in as.
10. Writes `/usr/local/share/nekko-runner-image.json` with the build date and the macOS, Xcode,
    Actions runner and gitlab-runner versions.

The pinned versions sit at the top of `provision.sh`, with hashes taken from the official
release pages: the `osx-arm64` SHA in the
[actions/runner release notes](https://github.com/actions/runner/releases/tag/v2.338.1) and
`binaries/gitlab-runner-darwin-arm64` in
[gitlab-runner's release.sha256](https://gitlab-runner-downloads.s3.amazonaws.com/v19.5.1/release.sha256).

## What it does not install

Xcode, iOS simulator runtimes, Homebrew and the tools your jobs use. They come from the base
image: the Cirrus `-xcode` images carry them. Add anything else before running `provision.sh`,
while the admin account still works.

## GitLab

`gitlab-runner` is installed and unused until GitLab support lands (T215).

## Keeping it current

Rebuild the image when GitHub publishes a new runner. An outdated runner updates itself inside
every throwaway VM, which costs a download on every job, and once GitHub stops supporting that
version it gets no jobs at all. Rebuild for macOS and Xcode updates too. The image is rebuilt,
never patched: `provision.sh` refuses to run twice on the same image.

## Why there is no SSH or agent

Nothing on the host can reach into a job's VM: no SSH, no Screen Sharing, no Tart guest agent.
A job that broke out of its user would find no way back to your Mac beyond the private network
every job already has. See [decision 0022](decisions/0022-ci-runners-vm-and-network.md).

## Check it

Boot a clone of the image Nekko uses with a fake seed and no network, and watch it shut itself
down. From the repo root,
after `node apps/desktop/scripts/stage-daemon.mjs --dev`:

```bash
mkdir -p target/runner-image-check
target/dev-daemon/nekko-vm clone --from ~/.nekko-agent/runners/images/default --to target/runner-image-check/vm
seed="$(mktemp -d)" && chmod 700 "$seed" && printf not-a-config > "$seed/jit-config"
hdiutil makehybrid -iso -joliet -default-volume-name NEKKOSEED -o target/runner-image-check/seed.iso "$seed"
perl -MSocket -MPOSIX -e 'socketpair(my $a, my $b, AF_UNIX, SOCK_DGRAM, 0) or die $!;
  if (my $pid = fork) { waitpid($pid, 0); exit($? >> 8) }
  POSIX::dup2(fileno($b), 3); exec @ARGV' \
  target/dev-daemon/nekko-vm run --bundle target/runner-image-check/vm --cpus 4 --memory-mb 8192 --net-fd 3 --seed target/runner-image-check/seed.iso
rm -rf target/runner-image-check "$seed"
```

It prints `{"event":"started"}`, then within 10 minutes `{"event":"stopped"...}` and exits, with
nobody touching the VM: the guest logged in, read the seed, the runner rejected the config, and
the guest powered off. Past 10 minutes it failed: stop it, boot the clone in Tart with graphics,
and read `/var/log/nekko-runner-boot.log`.

Use the literal `not-a-config`. A well-formed JIT config that GitHub does not know (a made-up
one, or a runner that was deleted) makes the runner retry every 30 s forever ("Runner connect
error: The resource cannot be found.. Retrying until reconnected."), so that VM only stops at
the max job time.

## Verified on

2026-10-28, on an M1 Max running macOS 27.0.1, guest Cirrus `macos-tahoe-xcode:27.1` (macOS
26.6.2, Xcode 27.1), built with Tart 2.41.1 exactly as in [Build it](#build-it).

- The first build stopped at the lockdown: `systemsetup -setremotelogin off` needs Full Disk
  Access on macOS 26. By then the admin was disabled and sudoers emptied, so that VM was thrown
  away and rebuilt from a fresh clone. The `launchctl disable` before it is what keeps sshd off,
  and the script now checks `launchctl print-disabled` for sshd and Screen Sharing instead.
- Build: `provision.sh` ran in about 2 min. Boot with the `not-a-config` seed: `started` to
  `stopped`, reason `guest`, in 76 s with nobody touching the VM. The clone's boot log shows the
  runner starting, rejecting the config, `runner exited with 0`, `shutting down`.

2026-10-25, on a Mac with Apple silicon running macOS 27.0.1, guest Cirrus
`macos-sequoia-base` (macOS 15.7.7, no Xcode). Tart was not installed, so the image was built
with `nekko-vm` through the spike example
(`cargo run -p nekkod --features spike --example runner_vm_spike -- --bundle <dir> --seed <iso> --keep`),
which forwards 127.0.0.1:2222 to the guest's SSH for the build and copies
`scripts/runner-image` in with `scp` in place of `--dir`.

- Build: SSH up about 30 s after boot; `provision.sh` ran in 2 min (most of it the runner
  download and handing `/opt/homebrew` over), then `shutdown -h now`, and the helper reported
  `stopped`, reason `guest`.
- Checked in the guest as root before shutdown: `runner` is uid 502, not in `admin`, may not
  run sudo; `/etc/sudoers.d` is empty and `/etc/sudoers` has no `NOPASSWD`; both admins
  (`admin`, `_mbsetupuser`) are refused authentication and `su admin` as `runner` with the
  public password fails; `/etc/kcpassword` is root 0600 and `autoLoginUser` is `runner`; sshd and
  Screen Sharing are disabled in launchd and Remote Login is off; no `org.cirruslabs.*` plists
  and no `tart-guest-agent` on `PATH`; the boot script (root:wheel 0755), its LaunchDaemon
  (root:wheel 0644), gitlab-runner (root:wheel 0755) and `nekko-runner-image.json` are in place.
- Boot with the `not-a-config` seed: `started` to `stopped`, reason `guest`, in 49 s with nobody
  touching the VM. The runner was started about 8 s after `started` (the boot script waits for
  the auto-login session, so `runner` was logged in by then), rejected the config, and the guest
  powered off. Read from the clone's disk afterwards: the boot log shows start, the runner's
  error, `runner exited with 0`, `shutting down`; `~runner/.nekko` is empty.
- Boot with a well-formed fake JIT config: the runner started 4 s after `started`, reached
  GitHub, got a 404 and retried every 30 s; stopped by hand after 16 min (see above).
- Every clone gets its own MAC address (`nekko-vm clone` writes a new one into `config.json`).
- Found and fixed on the way: the `/Users/runner` link, `sysadminctl -autologin`, the admin
  password change (`dscl -passwd` asks for the old password of a secure-token admin), and
  `softwareupdate --schedule off` doing nothing.
- Rechecked after review: a fresh build with the all-users lockdown found three admins by
  `dsmemberutil` (`admin`, `_mbsetupuser`, root) and disabled all three. Root reported
  "Policy allows" before (it has no password, `Password: *`) and is refused after; `sudo` still
  works. `fdesetup status` says `FileVault is Off.`. A clone of that image with the
  `not-a-config` seed logged in, ran the runner and powered off in 51 s, and its disk still had
  `AutomaticDownload`, `CriticalUpdateInstall`, `ConfigDataInstall` and
  `AutomaticallyInstallMacOSUpdates` false after the boot (`AutomaticCheckEnabled` was gone
  again).
- Left alone: the Tart guest agent's Homebrew Cellar folder stays on disk, with nothing that
  starts it.
