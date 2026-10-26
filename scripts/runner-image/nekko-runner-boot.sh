#!/bin/bash
# Guest boot: run one CI job from the NEKKOSEED volume as the runner user, then power off.
# Runs as root from dev.nekkolabs.runner-boot. The seed is untrusted input and holds a credential:
# never log or eval its contents. No `set -e`: the guest must always shut down once a seed was found.
set -u

NEKKO_SEED_DIR="${NEKKO_SEED_DIR:-/Volumes/NEKKOSEED}"
NEKKO_RUNNER_USER="${NEKKO_RUNNER_USER:-runner}"
NEKKO_RUNNER_HOME="${NEKKO_RUNNER_HOME:-/Users/runner}"
NEKKO_SEED_WAIT="${NEKKO_SEED_WAIT:-120}"
NEKKO_LOGIN_WAIT="${NEKKO_LOGIN_WAIT:-300}"
NEKKO_POLL="${NEKKO_POLL:-2}"
MAX_SEED_BYTES=65536

conf_dir="$NEKKO_RUNNER_HOME/.nekko"
stay_up=0

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

finish() {
  rm -f "$conf_dir/jit-config"
  if [ "$stay_up" != 1 ]; then
    log "shutting down"
    shutdown -h now
  fi
}
trap finish EXIT

# 1. Wait for the seed volume.
deadline=$((SECONDS + NEKKO_SEED_WAIT))
until [ -d "$NEKKO_SEED_DIR" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "no seed: no runner, staying up"
    stay_up=1
    exit 0
  fi
  diskutil mount readOnly NEKKOSEED >/dev/null 2>&1
  sleep "$NEKKO_POLL"
done

# 2. Exactly one regular file (not a symlink) with a known name, 1 to 64 KiB.
shopt -s nullglob dotglob
entries=("$NEKKO_SEED_DIR"/*)
shopt -u nullglob dotglob
name=""
if [ "${#entries[@]}" -eq 1 ] && [ -f "${entries[0]}" ] && [ ! -L "${entries[0]}" ]; then
  candidate="$(basename "${entries[0]}" | tr '[:upper:]' '[:lower:]')"
  size="$(wc -c < "${entries[0]}" | tr -d ' ')"
  case "$candidate" in
    jit-config | gitlab-runner.toml)
      if [ "$size" -ge 1 ] && [ "$size" -le "$MAX_SEED_BYTES" ]; then name="$candidate"; fi
      ;;
  esac
fi
if [ -z "$name" ]; then
  log "unexpected seed contents"
  exit 1
fi

# 3. Copy it where only the runner user can read it, then let go of the seed.
rm -rf "$conf_dir"
(umask 077 && mkdir -p "$conf_dir" && cp "${entries[0]}" "$conf_dir/$name")
chmod 700 "$conf_dir"
chmod 600 "$conf_dir/$name"
chown -R "$NEKKO_RUNNER_USER" "$conf_dir"
diskutil unmount force "$NEKKO_SEED_DIR" >/dev/null 2>&1
if [ ! -s "$conf_dir/$name" ]; then
  log "cannot copy the seed"
  exit 1
fi

# 4. Wait for the auto-login session.
deadline=$((SECONDS + NEKKO_LOGIN_WAIT))
until [ "$(stat -f %Su /dev/console 2>/dev/null)" = "$NEKKO_RUNNER_USER" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "runner user never logged in"
    exit 1
  fi
  sleep "$NEKKO_POLL"
done

# 5. Run one job as the runner user in its session. Provider-specific parts stay in this case.
uid="$(id -u "$NEKKO_RUNNER_USER")"
case "$name" in
  jit-config)
    jit="$(cat "$conf_dir/jit-config")"
    rm -f "$conf_dir/jit-config"
    log "starting the GitHub Actions runner"
    launchctl asuser "$uid" sudo -u "$NEKKO_RUNNER_USER" -H -- "$NEKKO_RUNNER_HOME/actions-runner/run.sh" --jitconfig "$jit"
    rc=$?
    unset jit
    ;;
  gitlab-runner.toml)
    log "starting the GitLab runner"
    launchctl asuser "$uid" sudo -u "$NEKKO_RUNNER_USER" -H -- /usr/local/bin/gitlab-runner run-single -c "$conf_dir/gitlab-runner.toml" -r nekko --max-builds 1
    rc=$?
    ;;
esac
log "runner exited with $rc"

# 6. The EXIT trap powers the guest off.
