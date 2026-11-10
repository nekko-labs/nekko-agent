#!/usr/bin/env sh
# Run the NekkoProtocol tests on Linux (no Mac needed) in the official Swift
# image. CryptoKit comes from swift-crypto there (see Protocol/Package.swift).
# Usage: apps/ios/scripts/linux-test.sh [swift test args]
#
# The container is bounded: SWIFT_MEMORY (default 6g) caps its memory and,
# as --memory-swap too, its memory plus swap, and SWIFT_CPUS (default 4, or
# fewer when the machine has fewer) caps its CPUs and the build's parallel
# jobs. The jobs matter most: SwiftPM sizes them from the host's cores, not the
# CPU cap (an uncapped run on a 32-core machine held 21.7 GiB). On
# Windows that lands in Docker's WSL VM, which otherwise grows to about half
# the RAM and keeps it (23.6 GB once, enough to run the machine out of commit).
set -eu
root="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${SWIFT_IMAGE:-swift:6.1-noble}"
memory="${SWIFT_MEMORY:-6g}"
cpus="${SWIFT_CPUS:-}"
if [ -z "$cpus" ]; then
  cpus=4
  online="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  [ "$online" -lt "$cpus" ] 2>/dev/null && cpus="$online"
fi
proxy_env=""
[ -n "${HTTPS_PROXY:-}" ] && proxy_env="-e HTTPS_PROXY=$HTTPS_PROXY -e https_proxy=$HTTPS_PROXY -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1"
ca=""
[ -f /root/.ccr/ca-bundle.crt ] && ca="-v /root/.ccr/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro -e GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt"
# shellcheck disable=SC2086
exec docker run --rm --network host --memory "$memory" --memory-swap "$memory" --cpus "$cpus" \
  $proxy_env $ca ${SWIFT_ENV:-} -v "$root:/repo" -w /repo/apps/ios/Protocol \
  -e SWIFTPM_BUILD_DIR=/tmp/build "$image" swift test --scratch-path /tmp/nekko-swift-build --jobs "$cpus" "$@"
