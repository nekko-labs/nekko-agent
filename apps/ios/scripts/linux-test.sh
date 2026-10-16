#!/usr/bin/env sh
# Run the NekkoProtocol tests on Linux (no Mac needed) in the official Swift
# image. CryptoKit comes from swift-crypto there (see Protocol/Package.swift).
# Usage: apps/ios/scripts/linux-test.sh [swift test args]
set -eu
root="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${SWIFT_IMAGE:-swift:6.1-noble}"
proxy_env=""
[ -n "${HTTPS_PROXY:-}" ] && proxy_env="-e HTTPS_PROXY=$HTTPS_PROXY -e https_proxy=$HTTPS_PROXY"
ca=""
[ -f /root/.ccr/ca-bundle.crt ] && ca="-v /root/.ccr/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro -e GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt"
# shellcheck disable=SC2086
exec docker run --rm --network host $proxy_env $ca -v "$root:/repo" -w /repo/apps/ios/Protocol \
  -e SWIFTPM_BUILD_DIR=/tmp/build "$image" swift test --scratch-path /tmp/nekko-swift-build "$@"
