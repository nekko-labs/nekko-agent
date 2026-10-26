#!/bin/bash
# Turns a copy of a macOS base image into the Nekko CI runner golden image. Run once, as root,
# inside the VM, with nekko-runner-boot.sh and dev.nekkolabs.runner-boot.plist in the same
# directory (or the current one, under `bash -s`). Shut the VM down afterwards; never boot the
# golden image again, since jobs run in throwaway clones. See docs/ci-runners-image.md.
set -euo pipefail

# Pins. Update both together from the official release pages, never from a mirror:
#   https://github.com/actions/runner/releases (the osx-arm64 SHA in the release notes)
#   https://gitlab-runner-downloads.s3.amazonaws.com/v<version>/release.sha256
RUNNER_VERSION=2.338.1
RUNNER_SHA256=52c3fb801b931fbd454979bae5ec3443ea3da2c4a1b4c44fa546fb630d61a0a9
GITLAB_RUNNER_VERSION=19.5.1
GITLAB_RUNNER_SHA256=1635a9d8791626bd3fe630ec09e3d5b4d9950fe6d6fa59f5f03367c02e044b5f

src="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
runner_home=/Users/runner

# /etc/kcpassword's format: the password XORed with Apple's fixed key, NUL-padded to a multiple of 12.
kcpassword() {
  local key=(125 137 82 35 210 188 221 234 163 185 31) p="$1" n i c
  n=$(((${#p} + 11) / 12 * 12))
  for ((i = 0; i < n; i++)); do
    c=0
    if [ "$i" -lt "${#p}" ]; then c="$(LC_ALL=C printf %d "'${p:i:1}")"; fi
    # shellcheck disable=SC2059 # the format is the octal escape being built
    printf "\\$(printf %03o $((c ^ key[i % 11])))"
  done
}

die() {
  echo "provision: $*" >&2
  exit 1
}
step() { echo "provision: $*"; }

# 1. Preflight: everything that can refuse does so before the image changes.
[ "$(id -u)" = 0 ] || die "run as root (sudo bash provision.sh)"
[ "$(uname -m)" = arm64 ] || die "Apple silicon only"
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 14 ] || die "macOS 14 or later"
for app in /Applications/Xcode_*.app; do
  [ -e "$app" ] && die "rename $app to /Applications/Xcode.app: the job user has no sudo, and ios-native.yml only switches Xcode for the Xcode_* pattern"
done
for f in nekko-runner-boot.sh dev.nekkolabs.runner-boot.plist; do
  [ -f "$src/$f" ] || die "missing $src/$f"
done
id runner >/dev/null 2>&1 && die "user runner already exists: rebuild from a fresh base image"
# Cirrus images link /Users/runner to the admin's home (GitHub-hosted path compatibility); step 2
# replaces the link. A real directory there is someone's data: refuse.
if [ -e "$runner_home" ] && [ ! -L "$runner_home" ]; then
  die "$runner_home already exists: rebuild from a fresh base image"
fi
if [ -d /Applications/Xcode.app ]; then
  step "selecting /Applications/Xcode.app"
  xcode-select -s /Applications/Xcode.app
  xcodebuild -license accept
fi

# 2. The job user: a standard account. Its password lives only in this shell.
step "creating user runner"
if [ -L "$runner_home" ]; then
  rm "$runner_home"
fi
runner_pw="$(openssl rand -base64 24)"
sysadminctl -addUser runner -fullName "CI runner" -home "$runner_home" -password "$runner_pw"
createhomedir -c -u runner >/dev/null
mkdir -p "$runner_home/Library/Preferences"
admins=()
for u in $(dscl . -read /Groups/admin GroupMembership | cut -d: -f2-); do
  [ "$u" = root ] || admins+=("$u")
done
for u in ${admins[@]+"${admins[@]}"}; do
  sa="/Users/$u/Library/Preferences/com.apple.SetupAssistant.plist"
  if [ -f "$sa" ]; then
    cp "$sa" "$runner_home/Library/Preferences/"
    break
  fi
done
chown -R runner:staff "$runner_home/Library"
sudo -u runner defaults -currentHost write com.apple.screensaver idleTime -int 0

# 3. Auto-login, so the job has a GUI session (simulators, keychain).
step "auto-login as runner"
# Not sysadminctl -autologin: on macOS 15 in a VM it fails (SACSetAutoLoginPassword error:22),
# writes nothing and still exits 0. This is what it would write.
rm -f /etc/kcpassword
(umask 077 && kcpassword "$runner_pw" >/etc/kcpassword)
unset runner_pw
chown root:wheel /etc/kcpassword
chmod 0600 /etc/kcpassword
defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser runner

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 4. The GitHub Actions runner, unconfigured: each job's JIT config registers it.
step "GitHub Actions runner $RUNNER_VERSION"
curl -fsSL -o "$tmp/actions-runner.tar.gz" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz"
echo "$RUNNER_SHA256  $tmp/actions-runner.tar.gz" | shasum -a 256 -c
mkdir -p "$runner_home/actions-runner"
tar -xzf "$tmp/actions-runner.tar.gz" -C "$runner_home/actions-runner"
chown -R runner:staff "$runner_home/actions-runner"

# 5. gitlab-runner for T215: installed, not registered, no service.
step "gitlab-runner $GITLAB_RUNNER_VERSION"
curl -fsSL -o "$tmp/gitlab-runner" "https://gitlab-runner-downloads.s3.amazonaws.com/v$GITLAB_RUNNER_VERSION/binaries/gitlab-runner-darwin-arm64"
echo "$GITLAB_RUNNER_SHA256  $tmp/gitlab-runner" | shasum -a 256 -c
mkdir -p /usr/local/bin
install -m 0755 -o root -g wheel "$tmp/gitlab-runner" /usr/local/bin/gitlab-runner

# 6. The boot script and its LaunchDaemon. Not loaded now: it runs at the next boot of a clone.
step "boot script and LaunchDaemon"
mkdir -p /usr/local/libexec
install -m 0755 -o root -g wheel "$src/nekko-runner-boot.sh" /usr/local/libexec/nekko-runner-boot.sh
install -m 0644 -o root -g wheel "$src/dev.nekkolabs.runner-boot.plist" /Library/LaunchDaemons/dev.nekkolabs.runner-boot.plist
plutil -lint /Library/LaunchDaemons/dev.nekkolabs.runner-boot.plist

# 7. Jobs may brew install without sudo; the VM is thrown away after each job.
if [ -d /opt/homebrew ]; then
  step "handing /opt/homebrew to runner"
  chown -R runner /opt/homebrew
fi

# 8. A quiet guest: no sleep, no indexing, no update checks.
step "power, Spotlight, software update"
pmset -a sleep 0 displaysleep 0 disksleep 0 powernap 0
mdutil -a -i off >/dev/null
# Not softwareupdate --schedule off: on macOS 15 it changes nothing. softwareupdated drops
# AutomaticCheckEnabled again at the next boot (a clone may still check); AutomaticDownload stays off.
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false

# 9. Lock down: no admin anyone can log in as, no passwordless sudo, no way in from the host.
# Disabled, not given a new password: root cannot reset a secure-token admin's password without the
# old one, and a base image's admin password is public (Cirrus: admin), so a job could `su admin`.
step "locking down"
for u in ${admins[@]+"${admins[@]}"}; do
  pwpolicy -u "$u" -disableuser >/dev/null
  [[ "$(pwpolicy -u "$u" -authentication-allowed 2>&1)" == *"not allowed to authenticate"* ]] || die "cannot disable $u"
done
find /etc/sudoers.d -mindepth 1 -delete
# Not grep -q: under pipefail its early exit can SIGPIPE the first grep and hide a match.
if grep -v '^[[:space:]]*#' /etc/sudoers | grep NOPASSWD >/dev/null; then
  die "/etc/sudoers grants passwordless sudo: remove it from the base image"
fi
launchctl disable system/com.openssh.sshd
systemsetup -f -setremotelogin off
launchctl disable system/com.apple.screensharing
kickstart=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart
if [ -x "$kickstart" ]; then
  "$kickstart" -deactivate -stop >/dev/null
fi
rm -f /Library/LaunchDaemons/org.cirruslabs.* /Library/LaunchAgents/org.cirruslabs.*
for d in ${PATH//:/ } /usr/local/bin /opt/homebrew/bin; do
  rm -f "$d/tart-guest-agent"
done

# Check the outcome, not just the steps: runner has no sudo and is not an admin.
sudo_l="$(sudo -l -U runner 2>&1 || true)"
[[ "$sudo_l" == *"is not allowed to run sudo"* ]] || die "runner can use sudo"
membership="$(dsmemberutil checkmembership -U runner -G admin 2>&1 || true)"
[[ "$membership" == *"is not a member"* ]] || die "runner is an admin"

# 10. What this image holds, for the app and for whoever debugs it.
xcode=null
if [ -d /Applications/Xcode.app ]; then
  xcode="\"$(xcodebuild -version | sed -n 1p)\""
fi
mkdir -p /usr/local/share
printf '{"built":"%s","macos":"%s","xcode":%s,"actionsRunner":"%s","gitlabRunner":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(sw_vers -productVersion)" "$xcode" "$RUNNER_VERSION" "$GITLAB_RUNNER_VERSION" \
  >/usr/local/share/nekko-runner-image.json
echo "provisioned: shut the VM down now"
