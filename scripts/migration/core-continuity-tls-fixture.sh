#!/usr/bin/env bash
# Ephemeral synthetic PKI only. The caller removes this directory after testing.
set -euo pipefail
umask 077
dir="${1:?An unused private fixture directory is required}"
test ! -e "$dir"
mkdir -p "$dir"
cat > "$dir/server.cnf" <<'CONFIG'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
CONFIG
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj /CN=continuity-synthetic-test-ca -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -config "$dir/server.cnf" \
  -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
openssl x509 -req -sha256 -days 1 -in "$dir/server.csr" -CA "$dir/ca.crt" \
  -CAkey "$dir/ca.key" -CAcreateserial -extfile "$dir/server.cnf" -extensions server \
  -out "$dir/server.crt" 2>/dev/null
# Only the server key and public certificates need to reach the PG fixture.
rm "$dir/ca.key" "$dir/ca.srl" "$dir/server.csr" "$dir/server.cnf"
chmod 755 "$dir"
chmod 644 "$dir/ca.crt" "$dir/server.crt"
