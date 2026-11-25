#!/bin/sh
# Start the API with V8's whole heap capped at a share of this machine's memory
# (issue #3342, README "Memory"). Node's own default ignores the machine: on
# Fly's 256 MB size (210 MB usable) it is 259 MB, so V8 never collects hard
# enough and the kernel kills or stalls the process instead.
#
# The share is read from /proc/meminfo at every start, so `fly scale memory`
# moves the cap with the machine and nothing here needs editing.
#
# V8's limit is old space plus the young generation (three semi-spaces), so the
# semi-space is pinned and old space gets the rest: on Node 22,
# --max-old-space-size=104 alone reports a 152 MB heap limit.
set -eu
percent="${NODE_HEAP_PERCENT:-50}"
semi_mb=8
total_kb=""
while read -r key value _; do
  if [ "$key" = "MemTotal:" ]; then total_kb="$value"; break; fi
done < /proc/meminfo
if [ -z "$total_kb" ]; then
  echo "start.sh: no MemTotal in /proc/meminfo; starting without a heap cap" >&2
  exec node dist/index.js
fi
heap_mb=$(( total_kb * percent / 100 / 1024 ))
old_mb=$(( heap_mb - 3 * semi_mb ))
if [ "$old_mb" -lt 32 ]; then old_mb=32; fi
exec node --max-old-space-size="$old_mb" --max-semi-space-size="$semi_mb" dist/index.js
