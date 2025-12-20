#!/usr/bin/env bash
set -euo pipefail

# aza-pg Phase 1 Setup Script for Coolify
# Validates configs and prints deployment checklist - does NOT run docker compose
# (Coolify manages container lifecycle)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

echo ""
echo "========================================="
echo "aza-pg Coolify Setup Validator"
echo "========================================="
echo ""

# Step 1: Check .env file exists
log_step "Checking .env configuration..."
if [ ! -f "$DEPLOY_DIR/.env" ]; then
    if [ -f "$DEPLOY_DIR/.env.example" ]; then
        log_info "Creating .env from .env.example..."
        cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
        log_warn "IMPORTANT: Edit .env and update all CHANGE_ME values!"
        log_warn "Generate passwords with: openssl rand -base64 32"
        echo ""
        log_error "Please edit .env file, then re-run this script."
        exit 1
    else
        log_error ".env.example not found. Cannot continue."
        exit 1
    fi
fi

# Step 2: Validate .env has required variables
log_info "Validating .env configuration..."
# shellcheck source=/dev/null
source "$DEPLOY_DIR/.env"

required_vars=(
    "POSTGRES_PASSWORD"
    "MONITORING_PASSWORD"
    "GRAFANA_ADMIN_PASSWORD"
    "GITHUB_USERNAME"
)

errors=0
for var in "${required_vars[@]}"; do
    if [ -z "${!var:-}" ]; then
        log_error "$var is not set in .env"
        errors=$((errors + 1))
    elif [[ "${!var}" == *"CHANGE_ME"* ]]; then
        log_error "$var still contains CHANGE_ME. Please update .env with secure values."
        errors=$((errors + 1))
    else
        log_info "$var ✓"
    fi
done

if [ $errors -gt 0 ]; then
    echo ""
    log_error "$errors configuration errors found. Fix .env and re-run."
    exit 1
fi

log_info "All required variables are set ✓"
echo ""

# Step 3: Check PgBouncer userlist.txt (will need to be generated after first deployment)
log_step "Checking PgBouncer configuration..."
if [ ! -f "$DEPLOY_DIR/pgbouncer/userlist.txt" ]; then
    log_warn "pgbouncer/userlist.txt not found - will be generated after PostgreSQL deployment"
    log_warn "After deploying PostgreSQL, run: ./scripts/generate-pgbouncer-userlist.sh"
else
    log_info "pgbouncer/userlist.txt exists ✓"
fi

# Step 4: Check Prometheus config
log_step "Checking Prometheus configuration..."
if [ -f "$DEPLOY_DIR/prometheus/prometheus.yml" ]; then
    log_info "prometheus/prometheus.yml exists ✓"
else
    log_warn "prometheus/prometheus.yml not found"
fi

# Step 5: Check Grafana provisioning
log_step "Checking Grafana configuration..."
if [ -d "$DEPLOY_DIR/grafana/provisioning" ]; then
    log_info "grafana/provisioning/ exists ✓"
else
    log_warn "grafana/provisioning/ not found"
fi

echo ""
echo "========================================="
log_info "Configuration validation complete!"
echo "========================================="
echo ""

# Print Coolify deployment checklist
echo -e "${BLUE}COOLIFY DEPLOYMENT CHECKLIST${NC}"
echo ""
echo "1. CREATE NETWORK in Coolify:"
echo "   • Go to: Networks → Create"
echo "   • Name: aza-pg-network"
echo "   • Subnet: 172.20.0.0/16"
echo ""
echo "2. DEPLOY POSTGRESQL:"
echo "   • Go to: Services → + Create"
echo "   • Select: Docker Compose"
echo "   • Paste docker-compose.yml postgres service section"
echo "   • Environment variables (from .env):"
for var in POSTGRES_PASSWORD POSTGRES_DB POSTGRES_USER POSTGRES_MEMORY POSTGRES_WORKLOAD_TYPE POSTGRES_STORAGE_TYPE GITHUB_USERNAME; do
    if [ -n "${!var:-}" ]; then
        echo "     - $var=${!var}"
    fi
done
echo "   • Connect to network: aza-pg-network"
echo "   • Deploy"
echo ""
echo "3. GENERATE PGBOUNCER USERLIST (after PostgreSQL is running):"
echo "   • Open PostgreSQL terminal in Coolify"
echo "   • Run: psql -U postgres -Atq -c \"SELECT '\\\"' || usename || '\\\" \\\"' || passwd || '\\\"' FROM pg_shadow WHERE usename = 'postgres';\""
echo "   • Copy output to pgbouncer/userlist.txt"
echo ""
echo "4. CREATE MONITORING USER (after PostgreSQL is running):"
echo "   • Open PostgreSQL terminal in Coolify"
echo "   • Run:"
echo "     CREATE USER ${MONITORING_USER:-monitoring} WITH PASSWORD '${MONITORING_PASSWORD}';"
echo "     GRANT pg_monitor TO ${MONITORING_USER:-monitoring};"
echo ""
echo "5. DEPLOY PGBOUNCER:"
echo "   • Upload userlist.txt to Coolify volumes or mount"
echo "   • Deploy PgBouncer service"
echo "   • Connect to network: aza-pg-network"
echo ""
echo "6. DEPLOY MONITORING STACK:"
echo "   • Deploy postgres-exporter, pgbouncer-exporter"
echo "   • Deploy Prometheus with prometheus.yml config"
echo "   • Deploy Grafana with provisioning directory"
echo "   • All on network: aza-pg-network"
echo ""
echo "7. VERIFY DEPLOYMENT:"
echo "   • Check all services are healthy in Coolify UI"
echo "   • Access Grafana via Coolify proxy"
echo "   • Import PostgreSQL dashboard (ID: 14114)"
echo ""
echo "========================================="
echo ""
log_info "Environment values to copy into Coolify:"
echo ""
echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
echo "POSTGRES_DB=${POSTGRES_DB:-main}"
echo "POSTGRES_USER=${POSTGRES_USER:-postgres}"
echo "POSTGRES_MEMORY=${POSTGRES_MEMORY:-5GB}"
echo "POSTGRES_WORKLOAD_TYPE=${POSTGRES_WORKLOAD_TYPE:-web}"
echo "POSTGRES_STORAGE_TYPE=${POSTGRES_STORAGE_TYPE:-ssd}"
echo "MONITORING_USER=${MONITORING_USER:-monitoring}"
echo "MONITORING_PASSWORD=${MONITORING_PASSWORD}"
echo "GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}"
echo "GITHUB_USERNAME=${GITHUB_USERNAME}"
echo ""
echo "========================================="
log_info "For bare VPS deployment (without Coolify), use: ./scripts/setup.sh"
echo ""
