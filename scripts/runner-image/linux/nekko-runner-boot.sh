#!/bin/bash
# Linux guest boot: run one CI job from the NEKKOSEED disk as the runner user, then power off.
# The Linux counterpart of ../nekko-runner-boot.sh, run as root by nekko-runner-boot.service, whose
# output goes to the virtio console nekkod keeps as the VM log. The seed is untrusted input and holds
# a credential: never log or eval its contents. No `set -e`: the guest must always power off once a
# seed was found.
set -u

NEKKO_SEED_LABEL="${NEKKO_SEED_LABEL:-NEKKOSEED}"
NEKKO_SEED_DIR="${NEKKO_SEED_DIR:-/run/nekko-seed}"
NEKKO_RUNNER_USER="${NEKKO_RUNNER_USER:-runner}"
NEKKO_RUNNER_HOME="${NEKKO_RUNNER_HOME:-/home/runner}"
NEKKO_SEED_WAIT="${NEKKO_SEED_WAIT:-120}"
NEKKO_POLL="${NEKKO_POLL:-2}"
NEKKO_DEV_GLOB="${NEKKO_DEV_GLOB:-/dev/vd[a-z]}"
NEKKO_STATS_EVERY="${NEKKO_STATS_EVERY:-5}"
NEKKO_POWEROFF="${NEKKO_POWEROFF:-systemctl poweroff --no-block}"
NEKKO_PROC="${NEKKO_PROC:-/proc}"
MAX_SEED_BYTES=65536

conf_dir="$NEKKO_RUNNER_HOME/.nekko"
stay_up=0
# The seed copy to remove on exit; cleared once the job owns the path.
seed_copy=""

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# The raw disk nekkod attached for usage samples: the one whose first block starts with its header.
stats_disk() {
  local d
  for d in $NEKKO_DEV_GLOB; do
    [ -b "$d" ] || [ -f "$d" ] || continue
    if [ "$(head -c 11 "$d" 2>/dev/null | tr -d '\0')" = NEKKOSTATS1 ]; then
      echo "$d"
      return
    fi
  done
}

# One sample over NEKKO_STATS_EVERY seconds, in the macOS script's format: `<unix secs> <idle %>
# <used MB> <compressed MB> <swapped-out MB so far>`. Linux has no compressor (0); used is what
# MemAvailable says is not reclaimable.
cpu_idle() {
  awk '/^cpu / {t = 0; for (i = 2; i <= NF; i++) t += $i; print $5 + $6, t}' "$NEKKO_PROC/stat"
}
sample() {
  local a b
  a="$(cpu_idle)"
  sleep "$NEKKO_STATS_EVERY"
  b="$(cpu_idle)"
  awk -v t="$(date +%s)" -v a="$a" -v b="$b" '
    BEGIN {split(a, x, " "); split(b, y, " "); dt = y[2] - x[2]; idle = dt > 0 ? (y[1] - x[1]) * 100 / dt : 100}
    /^MemTotal:/ {total = $2} /^MemAvailable:/ {avail = $2}
    END {printf "%d %.1f %d 0 %d\n", t, idle, (total - avail) / 1024, swapped / 1024}
  ' swapped="$(awk '/^pswpout/ {print $2 * 4}' "$NEKKO_PROC/vmstat" 2>/dev/null || echo 0)" "$NEKKO_PROC/meminfo"
}
stats_loop() {
  while :; do
    sample >>"$2"
    dd if="$2" of="$1" bs=512 seek=1 conv=sync,notrunc 2>/dev/null
  done
}

finish() {
  if [ -n "$seed_copy" ]; then rm -f "$seed_copy"; fi
  if [ "$stay_up" != 1 ]; then
    log "shutting down"
    $NEKKO_POWEROFF
  fi
}
trap finish EXIT

# 1. Wait for the seed disk and mount it read-only, never executable.
deadline=$((SECONDS + NEKKO_SEED_WAIT))
until [ -n "$(ls -A "$NEKKO_SEED_DIR" 2>/dev/null)" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "no seed: no runner, staying up"
    stay_up=1
    exit 0
  fi
  dev="$(blkid -L "$NEKKO_SEED_LABEL" 2>/dev/null)"
  if [ -n "$dev" ]; then
    mkdir -p "$NEKKO_SEED_DIR"
    mount -o ro,nosuid,nodev,noexec "$dev" "$NEKKO_SEED_DIR" 2>/dev/null
  fi
  sleep "$NEKKO_POLL"
done

# 2. Exactly one regular file (not a symlink) with a known name, 1 to 64 KiB. `nekko-test` is the
# image builder's test boot: it proves the image reaches this point, then powers off.
shopt -s nullglob dotglob
entries=("$NEKKO_SEED_DIR"/*)
shopt -u nullglob dotglob
name=""
if [ "${#entries[@]}" -eq 1 ] && [ -f "${entries[0]}" ] && [ ! -L "${entries[0]}" ]; then
  candidate="$(basename "${entries[0]}" | tr '[:upper:]' '[:lower:]')"
  size="$(wc -c <"${entries[0]}" | tr -d ' ')"
  case "$candidate" in
    jit-config | gitlab-runner.toml | nekko-test)
      if [ "$size" -ge 1 ] && [ "$size" -le "$MAX_SEED_BYTES" ]; then name="$candidate"; fi
      ;;
  esac
fi
if [ -z "$name" ]; then
  log "unexpected seed contents"
  exit 1
fi

# The guest has no clock of its own. The seed was written moments ago on the Mac, so its file time
# is close enough for TLS; NTP corrects it later where the network allows.
seed_secs="$(stat -c %Y "${entries[0]}")"
if [ "$seed_secs" -gt "$(date +%s)" ]; then date -s "@$seed_secs" >/dev/null; fi

if [ "$name" = nekko-test ]; then
  log "test seed: the image boots"
  exit 0
fi

# 3. Copy it where only the runner user can read it, then let go of the seed.
rm -rf "$conf_dir"
seed_copy="$conf_dir/$name"
(umask 077 && mkdir -p "$conf_dir" && cp "${entries[0]}" "$conf_dir/$name")
chmod 700 "$conf_dir"
chmod 600 "$conf_dir/$name"
chown -R "$NEKKO_RUNNER_USER:" "$conf_dir"
umount "$NEKKO_SEED_DIR" 2>/dev/null
if [ ! -s "$conf_dir/$name" ]; then
  log "cannot copy the seed"
  exit 1
fi

# 4. Run one job as the runner user, sampling its usage.
stats_pid=""
stats_dev="$(stats_disk)"
if [ -n "$stats_dev" ]; then
  stats_file="$(mktemp)"
  stats_loop "$stats_dev" "$stats_file" &
  stats_pid=$!
fi
as_runner() { runuser -u "$NEKKO_RUNNER_USER" -- env -i HOME="$NEKKO_RUNNER_HOME" USER="$NEKKO_RUNNER_USER" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 "$@"; }
case "$name" in
  jit-config)
    jit="$(cat "$conf_dir/jit-config")"
    rm -f "$conf_dir/jit-config"
    seed_copy=""
    log "starting the GitHub Actions runner"
    # The JIT config on argv shows in ps inside this single-tenant guest; it is single-use, so that is intended.
    (cd "$NEKKO_RUNNER_HOME/actions-runner" && as_runner ./run.sh --jitconfig "$jit")
    rc=$?
    unset jit
    ;;
  gitlab-runner.toml)
    seed_copy=""
    log "starting the GitLab runner"
    (cd "$NEKKO_RUNNER_HOME" && as_runner /usr/local/bin/gitlab-runner run-single -c "$conf_dir/gitlab-runner.toml" -r nekko --max-builds 1)
    rc=$?
    ;;
esac
log "runner exited with $rc"
if [ -n "$stats_pid" ]; then kill "$stats_pid" 2>/dev/null; fi

# 5. The EXIT trap powers the guest off.
