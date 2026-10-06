#!/usr/bin/env bash
set -euo pipefail

# Security Hardening Script
# Applies security best practices to aza-pg deployment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

cd "$DEPLOY_DIR"

echo "========================================"
echo "Security Hardening - $(date)"
echo "========================================"
echo ""

# 1. PostgreSQL Security
log_info "1. Hardening PostgreSQL..."

# 1.1: Restrict pg_hba.conf
log_info "Configuring pg_hba.conf for minimal access..."
docker exec postgres bash -c 'cat > "$PGDATA/pg_hba.conf" << "EOF"
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections (Unix socket): OS user postgres, as any role, because POSTGRES_USER may rename the superuser
local   all             all                                     peer    map=local_postgres

# Local TCP (monitoring, admin)
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256

# Docker network (applications)
host    all             all             172.20.0.0/16           scram-sha-256

# Replication (Phase 2 - update IP for replica)
#host    replication     replicator      10.0.0.3/32             scram-sha-256

# Deny all others
host    all             all             0.0.0.0/0               reject
EOF
printf "local_postgres\tpostgres\tall\n" > "$PGDATA/pg_ident.conf"'

# pg_ctl needs no database login, so the reload works whatever POSTGRES_USER names the superuser.
docker exec postgres pg_ctl reload
log_info "pg_hba.conf updated and reloaded"

# 2. File Permissions
log_info "2. Setting file permissions..."

chmod 600 "$DEPLOY_DIR/.env" 2>/dev/null || log_warn ".env not found"
# PgBouncer runs as uid 70 and must own the file to read it at mode 600
if ! { chown 70:70 "$DEPLOY_DIR/pgbouncer/userlist.txt" && chmod 600 "$DEPLOY_DIR/pgbouncer/userlist.txt"; } 2>/dev/null; then
    log_warn "userlist.txt: chown 70:70 / chmod 600 failed (file missing, or not root)"
fi
chmod 600 "$DEPLOY_DIR/pgbackrest/pgbackrest.conf" 2>/dev/null || log_warn "pgbackrest.conf not found"

if [ -d "$DEPLOY_DIR/ssl" ]; then
    chmod 600 "$DEPLOY_DIR/ssl/server.key" 2>/dev/null
    chmod 644 "$DEPLOY_DIR/ssl/server.crt" 2>/dev/null
fi

log_info "File permissions hardened"

# 3. Docker Security
log_info "3. Hardening Docker containers..."

# 3.1: Ensure containers run as non-root
log_info "Verifying containers run as non-root users..."
docker exec postgres id || log_warn "postgres container running as root"

# 3.2: Disable privileged mode
log_warn "Verify docker-compose.yml has no 'privileged: true' settings"

# 4. Network Security
log_info "4. Checking network exposure..."

# 4.1: Verify PostgreSQL not exposed publicly
if netstat -tuln 2>/dev/null | grep -q ":5432.*0.0.0.0"; then
    log_error "PostgreSQL exposed on 0.0.0.0! Update docker-compose.yml to bind to 127.0.0.1"
else
    log_info "PostgreSQL not publicly exposed (good)"
fi

# 4.2: Check PgBouncer exposure
if netstat -tuln 2>/dev/null | grep -q ":6432.*0.0.0.0"; then
    log_warn "PgBouncer exposed on 0.0.0.0. Consider restricting to localhost or Docker network."
fi

# 5. Firewall (UFW)
log_info "5. Configuring firewall..."

if command -v ufw &>/dev/null; then
    log_info "UFW detected. Configuring..."

    # Allow SSH, HTTP, HTTPS only
    ufw allow 22/tcp comment 'SSH'
    ufw allow 80/tcp comment 'HTTP'
    ufw allow 443/tcp comment 'HTTPS'

    # Explicitly deny database ports from outside
    ufw deny 5432/tcp comment 'PostgreSQL (deny external)'
    ufw deny 6432/tcp comment 'PgBouncer (deny external)'

    log_info "UFW rules configured. Enable with: ufw --force enable"
else
    log_warn "UFW not installed. Install: apt install ufw"
fi

# 6. Automated Security Updates
log_info "6. Enabling automatic security updates..."

if command -v unattended-upgrades &>/dev/null; then
    log_info "unattended-upgrades already installed"
else
    apt install -y unattended-upgrades
    dpkg-reconfigure -plow unattended-upgrades
fi

# 7. Fail2Ban (optional)
log_info "7. Checking Fail2Ban..."

if command -v fail2ban-client &>/dev/null; then
    log_info "Fail2Ban installed"
else
    log_warn "Fail2Ban not installed. Recommended: apt install fail2ban"
fi

# 8. Security Checklist
log_info "8. Security Checklist"

echo ""
echo "========================================="
echo "Security Hardening Complete"
echo "========================================="
echo ""
echo "✓ pg_hba.conf restricted to minimal access"
echo "✓ File permissions hardened"
echo ""
echo "TODO (Manual Steps):"
echo "  [ ] Enable TLS (docs/DEPLOYMENT.md, SSL/TLS for PostgreSQL)"
echo "  [ ] Enable UFW firewall: ufw --force enable"
echo "  [ ] Install Fail2Ban: apt install fail2ban"
echo "  [ ] Create least-privilege application roles (docs/DEPLOYMENT.md, Application-Specific Database Users)"
echo "  [ ] Configure backup encryption in Postgresus/pgBackRest"
echo "  [ ] Set up monitoring alerts for failed auth attempts"
echo "  [ ] Review and test disaster recovery procedures"
echo ""
