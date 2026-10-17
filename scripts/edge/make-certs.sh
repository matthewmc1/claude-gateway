#!/usr/bin/env bash
# Throwaway CA + leaf certificate for the local internal-load-balancer emulator (scripts/edge/ilb-emulator.mjs).
# Output (gitignored, under data/edge/ by default): ca.pem ca.key gateway.pem gateway.key gateway-chain.pem fingerprints.txt
#   leaf SAN: gateway.localhost, localhost, 127.0.0.1, ::1     leaf life: 397 days (browsers refuse longer)
# Idempotent: keeps existing certs unless they are missing, expire within 30 days, or --force is given.
#   scripts/edge/make-certs.sh [--force] [outdir]
# Needs openssl (OpenSSL 1.1+ or LibreSSL 3). Private keys are mode 600. These certs are for this laptop only: never distribute ca.key.
set -euo pipefail
FORCE=0; [ "${1:-}" = "--force" ] && { FORCE=1; shift; }
OUT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/data/edge}"
command -v openssl >/dev/null || { echo "make-certs: openssl not found" >&2; exit 1; }
mkdir -p "$OUT"; chmod 700 "$OUT"
if [ "$FORCE" = 0 ] && [ -s "$OUT/ca.pem" ] && [ -s "$OUT/gateway.pem" ] && [ -s "$OUT/gateway.key" ] && openssl x509 -in "$OUT/gateway.pem" -noout -checkend $((30*86400)) >/dev/null 2>&1 \
   && openssl verify -CAfile "$OUT/ca.pem" "$OUT/gateway.pem" >/dev/null 2>&1; then
  echo "certs ok: $OUT (use --force to regenerate)"; exit 0
fi
T="$(mktemp -d "${TMPDIR:-/tmp}/edge-certs.XXXXXX")"; trap 'rm -rf "$T"' EXIT
umask 077
# CA: P-256, 825 days
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$T/ca.key" 2>/dev/null
cat >"$T/ca.cnf" <<CNF
[req]
distinguished_name=dn
prompt=no
x509_extensions=ext
[dn]
CN=Claude gateway local edge CA (throwaway)
O=local development only
[ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CNF
openssl req -x509 -new -key "$T/ca.key" -sha256 -days 825 -config "$T/ca.cnf" -out "$T/ca.pem"
# Leaf
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$T/gateway.key" 2>/dev/null
cat >"$T/leaf.cnf" <<CNF
[req]
distinguished_name=dn
prompt=no
[dn]
CN=gateway.localhost
O=local development only
CNF
cat >"$T/leaf.ext" <<CNF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:gateway.localhost,DNS:localhost,IP:127.0.0.1,IP:::1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
CNF
openssl req -new -key "$T/gateway.key" -config "$T/leaf.cnf" -out "$T/gateway.csr"
openssl x509 -req -in "$T/gateway.csr" -CA "$T/ca.pem" -CAkey "$T/ca.key" -CAcreateserial -days 397 -sha256 -extfile "$T/leaf.ext" -out "$T/gateway.pem" 2>/dev/null
openssl verify -CAfile "$T/ca.pem" "$T/gateway.pem" >/dev/null
cat "$T/gateway.pem" "$T/ca.pem" >"$T/gateway-chain.pem"
{
  echo "ca sha256:      $(openssl x509 -in "$T/ca.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
  echo "leaf sha256:    $(openssl x509 -in "$T/gateway.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
  echo "leaf spki b64:  $(openssl x509 -in "$T/gateway.pem" -noout -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64 -A)"
} >"$T/fingerprints.txt"
for f in ca.pem ca.key gateway.pem gateway.key gateway-chain.pem fingerprints.txt; do cp "$T/$f" "$OUT/$f"; done
chmod 600 "$OUT/ca.key" "$OUT/gateway.key"; chmod 644 "$OUT/ca.pem" "$OUT/gateway.pem" "$OUT/gateway-chain.pem" "$OUT/fingerprints.txt"
echo "certs written: $OUT"; cat "$OUT/fingerprints.txt"
