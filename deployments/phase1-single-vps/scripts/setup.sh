#!/usr/bin/env bash
set -euo pipefail

# aza-pg Phase 1 Setup Script
# Automates initial deployment on fresh VPS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is not installed"
        return 1
    fi
}

# Step 1: Check prerequisites
log_info "Checking prerequisites..."
check_command docker || { log_error "Docker not installed. Run: curl -fsSL https://get.docker.com | bash"; exit 1; }
check_command docker-compose || check_command "docker compose" || { log_error "Docker Compose not available"; exit 1; }

log_info "Docker version: $(docker --version)"
log_info "Docker Compose version: $(docker compose version 2>/dev/null || docker-compose --version)"

# Step 2: Check .env file exists
if [ ! -f "$DEPLOY_DIR/.env" ]; then
    log_warn ".env file not found. Creating from .env.example..."
    if [ -f "$DEPLOY_DIR/.env.example" ]; then
        cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
        log_warn "IMPORTANT: Edit .env and update all CHANGE_ME values!"
        log_warn "Generate passwords with: openssl rand -base64 32"
        read -r -p "Press Enter after updating .env file..."
    else
        log_error ".env.example not found. Cannot continue."
        exit 1
    fi
fi

# Step 3: Validate .env has required variables
log_info "Validating .env configuration..."
source "$DEPLOY_DIR/.env"

required_vars=(
    "POSTGRES_PASSWORD"
    "MONITORING_PASSWORD"
    "GRAFANA_ADMIN_PASSWORD"
    "GITHUB_USERNAME"
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var:-}" ]; then
        log_error "$var is not set in .env"
        exit 1
    fi

    if [[ "${!var}" == *"CHANGE_ME"* ]]; then
        log_error "$var still contains CHANGE_ME. Please update .env with secure values."
        exit 1
    fi
done

log_info "All required variables are set"

# Step 4: Create Docker network
log_info "Creating Docker network 'aza-pg-network'..."
if docker network inspect aza-pg-network &>/dev/null; then
    log_info "Network already exists"
else
    docker network create --driver bridge --subnet 172.20.0.0/16 aza-pg-network
    log_info "Network created successfully"
fi

# Step 5: Generate PgBouncer userlist.txt
log_info "PgBouncer userlist.txt will be generated after PostgreSQL starts"
log_warn "You'll need to run: ./scripts/generate-pgbouncer-userlist.sh after first boot"

# Step 6: Pull images
log_info "Pulling Docker images..."
cd "$DEPLOY_DIR"
docker compose pull

# Step 7: Start services
log_info "Starting services..."
docker compose up -d

# Step 8: Wait for PostgreSQL to be ready
log_info "Waiting for PostgreSQL to start (max 60 seconds)..."
for i in {1..60}; do
    if docker exec postgres pg_isready -U postgres &>/dev/null; then
        log_info "PostgreSQL is ready!"
        break
    fi
    if [ $i -eq 60 ]; then
        log_error "PostgreSQL failed to start within 60 seconds"
        docker logs postgres --tail 50
        exit 1
    fi
    echo -n "."
    sleep 1
done
echo ""

# Step 9: Create monitoring user
log_info "Creating monitoring database user..."
docker exec postgres psql -U postgres <<EOF || log_warn "Monitoring user might already exist"
CREATE USER ${MONITORING_USER:-monitoring} WITH PASSWORD '${MONITORING_PASSWORD}';
GRANT pg_monitor TO ${MONITORING_USER:-monitoring};
EOF

# Step 10: Verify auto-config
log_info "Verifying PostgreSQL auto-configuration..."
SHARED_BUFFERS=$(docker exec postgres psql -U postgres -Atq -c "SHOW shared_buffers;")
MAX_CONNECTIONS=$(docker exec postgres psql -U postgres -Atq -c "SHOW max_connections;")
RANDOM_PAGE_COST=$(docker exec postgres psql -U postgres -Atq -c "SHOW random_page_cost;")

log_info "shared_buffers: $SHARED_BUFFERS (expected: ~1280MB)"
log_info "max_connections: $MAX_CONNECTIONS (expected: 200 for web workload)"
log_info "random_page_cost: $RANDOM_PAGE_COST (expected: 1.1 for SSD)"

# Step 11: Generate PgBouncer userlist
log_info "Generating PgBouncer userlist.txt..."
docker exec postgres psql -U postgres -Atq -c \
    "SELECT '\"' || usename || '\" \"' || passwd || '\"' FROM pg_shadow WHERE usename IN ('postgres', '${MONITORING_USER:-monitoring}');" \
    > "$DEPLOY_DIR/pgbouncer/userlist.txt"

chmod 600 "$DEPLOY_DIR/pgbouncer/userlist.txt"
log_info "PgBouncer userlist.txt generated"

# Step 12: Restart PgBouncer to load userlist
log_info "Restarting PgBouncer to load user list..."
docker restart pgbouncer
sleep 5

# Step 13: Test PgBouncer connection
log_info "Testing PgBouncer connection..."
if docker exec pgbouncer psql -h localhost -p 6432 -U postgres -d ${POSTGRES_DB:-main} -c "SELECT 1;" &>/dev/null; then
    log_info "PgBouncer connection test: SUCCESS"
else
    log_error "PgBouncer connection test: FAILED"
    docker logs pgbouncer --tail 20
fi

# Step 14: Display service status
log_info "Service status:"
docker compose ps

# Step 15: Display access information
echo ""
echo "========================================="
log_info "Setup complete! Access services:"
echo "========================================="
echo ""
echo "Grafana:           http://$(hostname -I | awk '{print $1}'):3000"
echo "  Username:        admin"
echo "  Password:        (value from GRAFANA_ADMIN_PASSWORD in .env)"
echo ""
echo "Prometheus:        http://$(hostname -I | awk '{print $1}'):9090"
echo ""
echo "PostgreSQL (internal only):"
echo "  Host:            postgres (or VPS IP for external)"
echo "  Port:            5432"
echo "  Database:        ${POSTGRES_DB:-main}"
echo "  User:            postgres"
echo "  Password:        (value from POSTGRES_PASSWORD in .env)"
echo ""
echo "PgBouncer (recommended for all connections):"
echo "  Host:            pgbouncer"
echo "  Port:            6432"
echo "  Connection:      postgresql://postgres:PASSWORD@pgbouncer:6432/${POSTGRES_DB:-main}?pgbouncer=true"
echo ""
echo "========================================="
echo ""

log_info "Next steps:"
echo "  1. Access Grafana and import dashboard ID 14114 (PostgreSQL Overview)"
echo "  2. Deploy Postgresus for backups (see DEPLOYMENT.md Step 7)"
echo "  3. Configure your microservices to connect via PgBouncer"
echo "  4. Run ./scripts/health-check.sh daily to monitor system"
echo ""

log_info "Run './scripts/verify.sh' to perform comprehensive health checks"
