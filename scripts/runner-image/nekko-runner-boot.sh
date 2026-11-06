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
NEKKO_DEV_DIR="${NEKKO_DEV_DIR:-/dev}"
NEKKO_STATS_EVERY="${NEKKO_STATS_EVERY:-5}"
MAX_SEED_BYTES=65536
# sudo swaps the caller's PATH for its secure_path, which leaves out Homebrew. Jobs expect `brew`
# on the PATH, as on GitHub's hosted Macs.
RUNNER_PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

conf_dir="$NEKKO_RUNNER_HOME/.nekko"
stay_up=0
# The seed copy to remove on exit. Cleared before the job starts: after that the path is the
# job's to control, and root must not delete through it.
seed_copy=""

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# The raw disk nekkod attached for usage samples: the whole disk whose first block is its header.
# Only root can write a raw disk, so the job cannot touch it.
stats_disk() {
  local d
  for d in "$NEKKO_DEV_DIR"/disk[0-9]*; do
    case "$d" in *s[0-9]*) continue ;; esac
    if [ "$(dd if="$d" bs=512 count=1 2>/dev/null | head -c 11)" = NEKKOSTATS1 ]; then
      echo "$d"
      return
    fi
  done
}

# One sample over NEKKO_STATS_EVERY seconds: `<unix secs> <idle %> <used MB> <compressed MB>
# <swapped-out MB so far>`. Used is wired + app + compressed memory; file cache is given back.
sample() {
  local idle
  idle="$(top -l 2 -s "$NEKKO_STATS_EVERY" -n 0 | awk '/^CPU usage/ {v=$7} END {sub("%", "", v); print v}')"
  [ -n "$idle" ] || return 0
  vm_stat | awk -v t="$(date +%s)" -v idle="$idle" '
    /page size of/ {ps = $8}
    /^Pages wired down/ {w = $4}
    /^Anonymous pages/ {a = $3}
    /^Pages occupied by compressor/ {c = $5}
    /^Swapouts/ {s = $2}
    END {if (ps > 0) {mb = ps / 1048576; printf "%d %s %d %d %d\n", t, idle, (w + a + c) * mb, c * mb, s * mb}}'
}

# Appends a sample, then writes every sample so far after the header block; nekkod reads them
# after the VM stops. A full disk only stops new samples from landing.
stats_loop() {
  while :; do
    sample >> "$2"
    dd if="$2" of="$1" bs=512 seek=1 conv=sync,notrunc 2>/dev/null
  done
}
# Everything below, the runner's output included, also goes to the host's VM log through the
# virtio console when the helper attached one. Only what this log already holds: never the seed.
for console in /dev/cu.virtio*; do
  if [ -c "$console" ] && [ -w "$console" ]; then
    exec > >(tee -a "$console") 2>&1
    break
  fi
done

# GitHub's runner writes each step's output to _diag/pages while the step runs (masked, as on
# github.com), then uploads and deletes the page. Following each page onto the console gives the
# host a live log of the job. Read as the runner user, and never through a symlink: the job owns
# that folder, and root must not read a file for it.
follow_pages() {
  local pages="$1" seen="|" f
  while :; do
    for f in "$pages"/*.log; do
      if [ ! -f "$f" ] || [ -L "$f" ]; then continue; fi
      case "$seen" in *"|$f|"*) continue ;; esac
      seen="$seen$f|"
      # tail -f keeps the descriptor, so a page the runner deletes just goes quiet.
      sudo -u "$NEKKO_RUNNER_USER" -H -- tail -n +1 -f "$f" 2>/dev/null &
    done
    sleep "$NEKKO_POLL"
  done
}

finish() {
  if [ -n "$seed_copy" ]; then rm -f "$seed_copy"; fi
  if [ "$stay_up" != 1 ]; then
    log "shutting down"
    shutdown -h now
  fi
}
trap finish EXIT

# 1. Wait for the seed volume. macOS makes its mount point seconds before mounting it, so an
# empty folder is not the seed yet.
deadline=$((SECONDS + NEKKO_SEED_WAIT))
until [ -n "$(ls -A "$NEKKO_SEED_DIR" 2>/dev/null)" ]; do
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
seed_copy="$conf_dir/$name"
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

# 5. Run one job as the runner user in its session, sampling its usage. Provider-specific parts stay
# in the case.
uid="$(id -u "$NEKKO_RUNNER_USER")"
stats_pid=""
stats_dev="$(stats_disk)"
if [ -n "$stats_dev" ]; then
  stats_file="$(mktemp "${TMPDIR:-/tmp}/nekko-stats.XXXXXX")"
  stats_loop "$stats_dev" "$stats_file" &
  stats_pid=$!
fi
case "$name" in
  jit-config)
    jit="$(cat "$conf_dir/jit-config")"
    rm -f "$conf_dir/jit-config"
    seed_copy=""
    log "starting the GitHub Actions runner"
    follow_pages "$NEKKO_RUNNER_HOME/actions-runner/_diag/pages" &
    pages_pid=$!
    # The JIT config on argv shows in ps inside this single-tenant guest; it is single-use, so that is intended.
    launchctl asuser "$uid" sudo -u "$NEKKO_RUNNER_USER" -H -- /usr/bin/env PATH="$RUNNER_PATH" "$NEKKO_RUNNER_HOME/actions-runner/run.sh" --jitconfig "$jit"
    rc=$?
    unset jit
    # The tails it started end with the guest, which powers off next.
    kill "$pages_pid" 2>/dev/null
    ;;
  gitlab-runner.toml)
    seed_copy=""
    log "starting the GitLab runner"
    launchctl asuser "$uid" sudo -u "$NEKKO_RUNNER_USER" -H -- /usr/bin/env PATH="$RUNNER_PATH" /usr/local/bin/gitlab-runner run-single -c "$conf_dir/gitlab-runner.toml" -r nekko --max-builds 1
    rc=$?
    ;;
esac
log "runner exited with $rc"
if [ -n "$stats_pid" ]; then kill "$stats_pid" 2>/dev/null; fi

# 6. The EXIT trap powers the guest off.
