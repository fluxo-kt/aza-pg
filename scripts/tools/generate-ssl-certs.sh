#!/bin/bash
# Generate self-signed SSL certificates for PostgreSQL
# For production, replace with real certificates from a CA

set -e

CERT_DIR="${1:-./certs}"
DAYS_VALID="${2:-3650}"

if [ -z "$1" ]; then
  echo "Usage: $0 <cert-directory> [days-valid]"
  echo "Example: $0 stacks/primary/certs 3650"
  echo ""
  echo "Generates self-signed certificates for PostgreSQL TLS/SSL."
  echo "Default validity: 3650 days (10 years)"
  exit 1
fi

echo "[SSL] Generating certificates in: $CERT_DIR"
echo "[SSL] Validity period: $DAYS_VALID days"

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/server.key" ] || [ -f "$CERT_DIR/server.crt" ]; then
  echo "[SSL] WARNING: Certificates already exist in $CERT_DIR"
  read -p "Overwrite existing certificates? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "[SSL] Aborted"
    exit 0
  fi
  rm -f "$CERT_DIR/server.key" "$CERT_DIR/server.crt" "$CERT_DIR/ca.crt"
fi

HOSTNAME="${POSTGRES_HOSTNAME:-postgres.local}"

echo "[SSL] Generating private key..."
openssl req -new -x509 -days "$DAYS_VALID" -nodes -text \
  -out "$CERT_DIR/server.crt" \
  -keyout "$CERT_DIR/server.key" \
  -subj "/CN=$HOSTNAME/O=PostgreSQL/C=US"

if [ $? -ne 0 ]; then
  echo "[SSL] ERROR: Failed to generate certificates"
  exit 1
fi

chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt"

cp "$CERT_DIR/server.crt" "$CERT_DIR/ca.crt"

echo "[SSL] Certificates generated successfully!"
echo ""
echo "Files created:"
echo "  - $CERT_DIR/server.key  (private key, 600 permissions)"
echo "  - $CERT_DIR/server.crt  (certificate)"
echo "  - $CERT_DIR/ca.crt      (CA certificate, copy of server.crt)"
echo ""
echo "Next steps:"
echo "  1. Uncomment SSL lines in postgresql.conf"
echo "  2. Mount certs in compose.yml volumes section"
echo "  3. Restart PostgreSQL stack"
echo ""
echo "For production, replace these self-signed certificates with real ones from a CA."
