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

## Build it

From the root of this repo:

```bash
tart clone ghcr.io/cirruslabs/macos-sequoia-xcode:<tag> nekko-golden
tart run --no-graphics --dir runner-image:scripts/runner-image:ro nekko-golden &
tart exec nekko-golden sudo bash "/Volumes/My Shared Files/runner-image/provision.sh"
tart stop nekko-golden
mkdir -p ~/.nekko-agent/runners/images/default
cp -c ~/.tart/vms/nekko-golden/{config.json,disk.img,nvram.bin} ~/.nekko-agent/runners/images/default/
```

Pick `<tag>` from the [Cirrus image list](https://github.com/cirruslabs/macos-image-templates)
for the Xcode your jobs need. `--dir` shares `scripts/runner-image` into the guest read-only, so
`provision.sh` finds the boot script and LaunchDaemon beside it. `tart exec` works only once:
`provision.sh` removes the Tart guest agent it runs through.

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

1. Checks it runs as root on Apple silicon with macOS 14 or later, that this macOS has
   `sysadminctl -autologin`, and that no Xcode is named `Xcode_*.app` (rename it to `Xcode.app`:
   the job user cannot `sudo xcode-select`). When `/Applications/Xcode.app` exists it selects it
   and accepts its license.
2. Creates the job user `runner`, a standard account (not an admin) with a random password that
   is never shown or saved. It copies the existing admin's Setup Assistant answers so `runner`'s
   first login shows no assistant, and turns its screen saver off.
3. Logs `runner` in automatically at boot, so jobs get a real GUI session for simulators and the
   keychain. macOS keeps that password in `/etc/kcpassword`, readable only by root; that is fine
   because `runner` is not an admin and cannot become root.
4. Downloads the pinned GitHub Actions runner, checks its SHA-256, and unpacks it into
   `/Users/runner/actions-runner`. It never registers it: each job's one-time config does that.
5. Downloads the pinned `gitlab-runner` to `/usr/local/bin`, checks its SHA-256. Not registered,
   no service.
6. Installs the boot script at `/usr/local/libexec/nekko-runner-boot.sh` and its LaunchDaemon
   `dev.nekkolabs.runner-boot`. At each boot of a clone it reads the seed, starts one job as
   `runner`, and powers the VM off when the job ends, fails, or the seed is wrong.
7. Gives `runner` ownership of `/opt/homebrew`, so jobs can `brew install` without sudo.
8. Turns off sleep, Spotlight indexing and scheduled software updates.
9. Locks the guest down: every admin gets a new random password nobody knows, every file in
   `/etc/sudoers.d` goes (and it fails if `/etc/sudoers` still allows passwordless sudo), SSH,
   Screen Sharing and Apple Remote Desktop are turned off, and Cirrus Labs' LaunchDaemons,
   LaunchAgents and the Tart guest agent are removed. Then it checks the result: it fails unless
   `sudo -l -U runner` says `runner` may not use sudo and `runner` is not in the `admin` group.
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
