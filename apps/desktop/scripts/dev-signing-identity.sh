#!/bin/bash
# Create the "Nekko Agent Development" code-signing identity, once per Mac.
#
# Development builds sign nekkod with it (scripts/dev-signing.cjs), so the
# Keychain keeps "Always Allow" across rebuilds instead of asking again for
# every item after each one. It is a self-signed certificate in your login
# keychain, trusted for code signing by you only: it signs nothing anyone else
# runs, and it is no Apple identity.
#
# macOS asks for your password once, to trust the certificate. The first build
# that signs with it may also ask to let codesign use the key: Always Allow.
#
# Undo: delete "Nekko Agent Development" (certificate and key) in Keychain
# Access, login keychain.
set -euo pipefail

NAME="Nekko Agent Development"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if [ "$(uname)" != Darwin ]; then
  echo "Only macOS builds need this." >&2
  exit 1
fi
if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "\"$NAME\" is already set up."
  exit 0
fi
if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "A \"$NAME\" certificate exists but is not trusted for code signing. Delete it in Keychain Access, then run this again." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat >"$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
# A one-off password only for the hand-over to `security import`. OpenSSL 3
# needs -legacy for a .p12 macOS can read; LibreSSL (/usr/bin/openssl) has no
# such flag and writes one already.
pass="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy -name "$NAME" -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$work/id.p12" -passout "pass:$pass" 2>/dev/null \
  || openssl pkcs12 -export -name "$NAME" -inkey "$work/key.pem" -in "$work/cert.pem" \
    -out "$work/id.p12" -passout "pass:$pass"
security import "$work/id.p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign >/dev/null
echo "Trusting \"$NAME\" for code signing (macOS asks for your password)..."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "Done. The next \`npm run dev\` signs nekkod with \"$NAME\"; answer the Keychain once more with Always Allow, and later rebuilds keep it."
else
  echo "The certificate was imported but macOS does not list it as a valid signing identity." >&2
  exit 1
fi
