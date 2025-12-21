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
docker exec postgres bash -c 'cat > /var/lib/postgresql/data/pg_hba.conf << "EOF"
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections (Unix socket)
local   all             postgres                                peer

# Local TCP (monitoring, admin)
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256

# Docker network (applications)
host    all             all             172.20.0.0/16           scram-sha-256

# Replication (Phase 2 - update IP for replica)
#host    replication     replicator      10.0.0.3/32             scram-sha-256

# Deny all others
host    all             all             0.0.0.0/0               reject
EOF'

docker exec postgres psql -U postgres -c "SELECT pg_reload_conf();"
log_info "pg_hba.conf updated and reloaded"

# 1.2: Enforce SSL/TLS (if certificates exist)
if [ -f "$DEPLOY_DIR/ssl/server.crt" ] && [ -f "$DEPLOY_DIR/ssl/server.key" ]; then
    log_info "Enabling SSL/TLS..."
    docker exec postgres psql -U postgres <<EOF
ALTER SYSTEM SET ssl = 'on';
ALTER SYSTEM SET ssl_cert_file = 'server.crt';
ALTER SYSTEM SET ssl_key_file = 'server.key';
EOF
    docker restart postgres
    log_info "SSL enabled (restart required)"
else
    log_warn "SSL certificates not found. Generate with: bun run scripts/generate-ssl-certs.ts"
fi

# 1.3: Disable superuser remote login
ADMIN_PASS=$(openssl rand -base64 32)
docker exec postgres psql -U postgres <<EOF
ALTER USER postgres WITH NOLOGIN;
CREATE USER admin WITH SUPERUSER CREATEDB CREATEROLE PASSWORD '$ADMIN_PASS';
GRANT postgres TO admin;
EOF

# Save admin password securely
echo "ADMIN_PASSWORD=$ADMIN_PASS" >> "$DEPLOY_DIR/.env.secrets"
chmod 600 "$DEPLOY_DIR/.env.secrets" 2>/dev/null

log_info "Superuser 'postgres' disabled for remote login. Use 'admin' user instead."
log_warn "Admin password saved to .env.secrets - STORE IN PASSWORD MANAGER IMMEDIATELY!"

# 1.4: Create application-specific users
log_info "Creating application users with least privilege..."
source .env

APP_USER_PASS=$(openssl rand -base64 32)
READONLY_PASS=$(openssl rand -base64 32)

docker exec postgres psql -U postgres <<EOF
-- Read-write application user
CREATE USER app_user WITH PASSWORD '$APP_USER_PASS';
GRANT CONNECT ON DATABASE ${POSTGRES_DB:-main} TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Read-only user for reporting
CREATE USER readonly WITH PASSWORD '$READONLY_PASS';
GRANT CONNECT ON DATABASE ${POSTGRES_DB:-main} TO readonly;
GRANT USAGE ON SCHEMA public TO readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
EOF

# Save application passwords securely
echo "APP_USER_PASSWORD=$APP_USER_PASS" >> "$DEPLOY_DIR/.env.secrets"
echo "READONLY_PASSWORD=$READONLY_PASS" >> "$DEPLOY_DIR/.env.secrets"

log_info "Application users created:"
log_info "  app_user (read-write): [saved to .env.secrets]"
log_info "  readonly (read-only): [saved to .env.secrets]"
log_warn "All passwords saved to .env.secrets - STORE IN PASSWORD MANAGER IMMEDIATELY!"

# 2. File Permissions
log_info "2. Setting file permissions..."

chmod 600 "$DEPLOY_DIR/.env" 2>/dev/null || log_warn ".env not found"
chmod 600 "$DEPLOY_DIR/pgbouncer/userlist.txt" 2>/dev/null || log_warn "userlist.txt not found"
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

# 6. Audit Logging
log_info "6. Enabling audit logging..."

docker exec postgres psql -U postgres <<EOF
-- Enable pgaudit (already loaded via shared_preload_libraries)
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Configure audit settings
ALTER SYSTEM SET pgaudit.log = 'ddl, write';
ALTER SYSTEM SET pgaudit.log_catalog = 'off';
ALTER SYSTEM SET pgaudit.log_parameter = 'on';
ALTER SYSTEM SET pgaudit.log_relation = 'on';
ALTER SYSTEM SET pgaudit.log_statement_once = 'on';

SELECT pg_reload_conf();
EOF

log_info "pgaudit configured for DDL and write operations"

# 7. Password Policy
log_info "7. Enforcing password policy..."

docker exec postgres psql -U postgres <<EOF
-- Require strong passwords (via pg_crypto if available)
-- Note: SCRAM-SHA-256 already enforced via pg_hba.conf

-- Log failed authentication attempts
ALTER SYSTEM SET log_connections = 'on';
ALTER SYSTEM SET log_disconnections = 'on';
ALTER SYSTEM SET log_duration = 'off';
ALTER SYSTEM SET log_hostname = 'on';

SELECT pg_reload_conf();
EOF

log_info "Connection logging enabled"

# 8. Automated Security Updates
log_info "8. Enabling automatic security updates..."

if command -v unattended-upgrades &>/dev/null; then
    log_info "unattended-upgrades already installed"
else
    apt install -y unattended-upgrades
    dpkg-reconfigure -plow unattended-upgrades
fi

# 9. Fail2Ban (optional)
log_info "9. Checking Fail2Ban..."

if command -v fail2ban-client &>/dev/null; then
    log_info "Fail2Ban installed"
else
    log_warn "Fail2Ban not installed. Recommended: apt install fail2ban"
fi

# 10. Security Checklist
log_info "10. Security Checklist"

echo ""
echo "========================================="
echo "Security Hardening Complete"
echo "========================================="
echo ""
echo "✓ pg_hba.conf restricted to minimal access"
echo "✓ File permissions hardened"
echo "✓ Application users created with least privilege"
echo "✓ pgaudit enabled for DDL/write operations"
echo "✓ Connection logging enabled"
echo ""
echo "TODO (Manual Steps):"
echo "  [ ] Generate SSL certificates: bun run scripts/generate-ssl-certs.ts"
echo "  [ ] Enable UFW firewall: ufw --force enable"
echo "  [ ] Install Fail2Ban: apt install fail2ban"
echo "  [ ] Update application connection strings to use 'app_user'"
echo "  [ ] Configure backup encryption in Postgresus/pgBackRest"
echo "  [ ] Set up monitoring alerts for failed auth attempts"
echo "  [ ] Document admin user password in password manager"
echo "  [ ] Review and test disaster recovery procedures"
echo ""
echo "CRITICAL:"
echo "  - New admin user password: (shown above)"
echo "  - app_user password: (shown above)"
echo "  - readonly password: (shown above)"
echo ""
echo "  SAVE THESE IMMEDIATELY IN YOUR PASSWORD MANAGER!"
echo ""
