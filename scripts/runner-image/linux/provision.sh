#!/bin/bash
# Turns Ubuntu 24.04's arm64 cloud image into the Nekko Linux CI runner golden image (decision 0053).
# nekkod hands it to cloud-init as user-data on a CIDATA seed, beside nekko-runner-boot.sh and
# nekko-runner-boot.service, and boots the image once with the NAT network. It runs as root, ends
# with NEKKO-PROVISION-OK (or NEKKO-PROVISION-FAILED) on the console for nekkod to read, and powers
# off. Jobs run in throwaway clones of the result; the golden image never boots again.
set -euo pipefail

# Pins. Update with ../provision.sh, from the official release pages, never from a mirror:
#   https://github.com/actions/runner/releases (the linux-arm64 SHA in the release notes)
#   https://gitlab-runner-downloads.s3.amazonaws.com/v<version>/release.sha256
RUNNER_VERSION=2.338.1
RUNNER_SHA256=475e0c149fd3b611610127b9664ba5bacf5c6928795cc448ab520bb5f324bede
GITLAB_RUNNER_VERSION=19.5.1
GITLAB_RUNNER_SHA256=bc002aa164508682664b761ee737a992f3cae1ae085469d7667870dfa30c2301

runner_home=/home/runner
seed=/run/nekko-cidata
step() { echo "provision: $*"; }
# Every exit says how it went, then powers off: nekkod waits for the guest to stop.
finish() {
  rc=$?
  if [ "$rc" = 0 ]; then echo NEKKO-PROVISION-OK; else echo "NEKKO-PROVISION-FAILED $rc"; fi
  sync
  systemctl poweroff --no-block
}
trap finish EXIT

[ "$(id -u)" = 0 ] && [ "$(uname -m)" = aarch64 ] || { echo "provision: root on arm64 only"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

step "the files beside this script"
mkdir -p "$seed"
mount -o ro "$(blkid -L CIDATA || blkid -L cidata)" "$seed"
for f in nekko-runner-boot.sh nekko-runner-boot.service; do [ -s "$seed/$f" ] || { echo "provision: no $f on the seed"; exit 1; }; done
# The guest has no clock of its own and boots at the image's build date, which apt refuses as
# "not valid yet". nekkod wrote the seed moments ago, so its file time is the Mac's clock.
seed_secs="$(stat -c %Y "$seed/meta-data")"
if [ "$seed_secs" -gt "$(date +%s)" ]; then date -s "@$seed_secs" >/dev/null; fi

step "packages"
# What ubuntu-latest jobs reach for first, and Docker for `services:` and `container:`.
apt-get update -q
apt-get install -y -q --no-install-recommends \
  build-essential ca-certificates curl docker-buildx docker-compose-v2 docker.io file git git-lfs gnupg \
  jq lsb-release pkg-config python3 python3-pip python3-venv rsync sudo unzip wget xz-utils zip zstd
# Nothing in a job VM should change under the job or listen for anyone.
apt-get purge -y -q snapd unattended-upgrades openssh-server || true
apt-get autoremove -y -q
systemctl disable apt-daily.timer apt-daily-upgrade.timer man-db.timer fstrim.timer motd-news.timer 2>/dev/null || true
systemctl enable docker.service containerd.service

step "the runner user"
# uid 1001 and passwordless sudo, as on GitHub's hosted Ubuntu runners. The VM is thrown away after one job.
id runner >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash runner
usermod -aG docker runner
echo 'runner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/runner
chmod 440 /etc/sudoers.d/runner

tmp="$(mktemp -d)"
step "GitHub Actions runner $RUNNER_VERSION"
curl -fsSL -o "$tmp/actions-runner.tar.gz" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-arm64-$RUNNER_VERSION.tar.gz"
echo "$RUNNER_SHA256  $tmp/actions-runner.tar.gz" | sha256sum -c
mkdir -p "$runner_home/actions-runner"
tar -xzf "$tmp/actions-runner.tar.gz" -C "$runner_home/actions-runner"
"$runner_home/actions-runner/bin/installdependencies.sh"
chown -R runner:runner "$runner_home"

step "gitlab-runner $GITLAB_RUNNER_VERSION"
curl -fsSL -o "$tmp/gitlab-runner" "https://gitlab-runner-downloads.s3.amazonaws.com/v$GITLAB_RUNNER_VERSION/binaries/gitlab-runner-linux-arm64"
echo "$GITLAB_RUNNER_SHA256  $tmp/gitlab-runner" | sha256sum -c
install -m 755 "$tmp/gitlab-runner" /usr/local/bin/gitlab-runner

step "the boot service"
install -D -m 755 "$seed/nekko-runner-boot.sh" /usr/local/libexec/nekko-runner-boot.sh
install -D -m 644 "$seed/nekko-runner-boot.service" /etc/systemd/system/nekko-runner-boot.service
systemctl enable nekko-runner-boot.service
umount "$seed"

step "one-time setup off"
# cloud-init's default user: locked, but no job needs it.
userdel -r ubuntu 2>/dev/null || true
# The image has no EFI partition: nekko-vm boots its kernel directly.
sed -i '\|/boot/efi|d' /etc/fstab
# cloud-init ran once, here; a job's seed must never be read as cloud-init data.
touch /etc/cloud/cloud-init.disabled
# Each clone makes its own machine id, so two VMs never share a DHCP client id on nekkod's NAT.
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
apt-get clean
rm -rf /var/lib/apt/lists/* "$tmp"

printf '{"version":1,"os":"linux","distro":"ubuntu-24.04","runner":"%s","gitlabRunner":"%s","docker":"%s","kernel":"%s"}\n' \
  "$RUNNER_VERSION" "$GITLAB_RUNNER_VERSION" "$(dpkg-query -W -f '${Version}' docker.io)" "$(uname -r)" \
  >/usr/local/share/nekko-runner-image.json
cat /usr/local/share/nekko-runner-image.json
fstrim -av || true
