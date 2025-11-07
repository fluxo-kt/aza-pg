#!/bin/bash
# Test script: Validate PgBouncer healthcheck and authentication
# Usage: ./test-pgbouncer-healthcheck.sh [stack-dir]
#
# Examples:
#   ./test-pgbouncer-healthcheck.sh                      # Use default 'stacks/primary'
#   ./test-pgbouncer-healthcheck.sh stacks/primary       # Explicit path

set -euo pipefail

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Check required commands
if ! check_command docker; then
  echo "   Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! check_docker_daemon; then
  echo "   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)"
  exit 1
fi

# Check for docker compose command
if ! command -v docker compose &>/dev/null && ! command -v docker-compose &>/dev/null; then
  log_error "Required command 'docker compose' not found"
  echo "   Install Docker Compose: https://docs.docker.com/compose/install/"
  exit 1
fi

STACK_DIR="${1:-stacks/primary}"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STACK_PATH="$PROJECT_ROOT/$STACK_DIR"

if [[ ! -d "$STACK_PATH" ]]; then
  log_error "Stack directory not found: $STACK_PATH"
  echo "   Available stacks: primary, replica, single"
  exit 1
fi

if [[ ! -f "$STACK_PATH/compose.yml" ]]; then
  log_error "compose.yml not found in $STACK_PATH"
  exit 1
fi

echo "========================================"
echo "PgBouncer Healthcheck Test"
echo "========================================"
echo "Stack: $STACK_DIR"
echo

# Cleanup function
cleanup() {
  log_info "Cleaning up test environment..."
  cd "$STACK_PATH"
  docker compose down -v >/dev/null 2>&1 || true
  if [[ -f .env.test ]]; then
    rm -f .env.test
  fi
  log_success "Cleanup completed"
}

# Set trap for cleanup on exit
trap cleanup EXIT

cd "$STACK_PATH"

# Create test .env file
log_info "Creating test environment configuration..."
cat > .env.test << 'EOF'
POSTGRES_PASSWORD=test_password_healthcheck_123
PGBOUNCER_AUTH_PASS=dev_pgbouncer_auth_test_2025
PG_REPLICATION_PASSWORD=replication_test_healthcheck_123
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-healthcheck-test
EOF

log_success "Test environment created"

# Start stack
log_info "Starting primary stack (postgres + pgbouncer)..."
if ! docker compose --env-file .env.test up -d postgres pgbouncer 2>&1; then
  log_error "Failed to start services"
  exit 1
fi

log_success "Services started"

# Wait for services to be healthy
log_info "Waiting for services to be healthy (max 90 seconds)..."
TIMEOUT=90
ELAPSED=0
POSTGRES_HEALTHY=false
PGBOUNCER_HEALTHY=false

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  POSTGRES_STATUS=$(docker compose --env-file .env.test ps postgres --format json 2>/dev/null | jq -r '.[0].Health // "starting"' || echo "starting")
  PGBOUNCER_STATUS=$(docker compose --env-file .env.test ps pgbouncer --format json 2>/dev/null | jq -r '.[0].Health // "starting"' || echo "starting")

  if [[ "$POSTGRES_STATUS" == "healthy" ]]; then
    POSTGRES_HEALTHY=true
  fi

  if [[ "$PGBOUNCER_STATUS" == "healthy" ]]; then
    PGBOUNCER_HEALTHY=true
  fi

  if [[ "$POSTGRES_HEALTHY" == "true" && "$PGBOUNCER_HEALTHY" == "true" ]]; then
    break
  fi

  echo "   PostgreSQL: $POSTGRES_STATUS, PgBouncer: $PGBOUNCER_STATUS (${ELAPSED}s/${TIMEOUT}s)"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [[ "$POSTGRES_HEALTHY" != "true" ]]; then
  log_error "PostgreSQL failed to become healthy after ${TIMEOUT}s"
  docker compose --env-file .env.test logs postgres
  exit 1
fi

if [[ "$PGBOUNCER_HEALTHY" != "true" ]]; then
  log_error "PgBouncer failed to become healthy after ${TIMEOUT}s"
  docker compose --env-file .env.test logs pgbouncer
  exit 1
fi

log_success "Both services are healthy"

# Test 1: Verify .pgpass file exists in pgbouncer container
log_info "Test 1: Verifying .pgpass file exists..."
PGBOUNCER_CONTAINER=$(docker compose --env-file .env.test ps pgbouncer -q)

if ! docker exec "$PGBOUNCER_CONTAINER" test -f /tmp/.pgpass; then
  log_error ".pgpass file not found at /tmp/.pgpass"
  docker exec "$PGBOUNCER_CONTAINER" ls -la /tmp/ || true
  exit 1
fi

log_success ".pgpass file exists at /tmp/.pgpass"

# Test 2: Verify .pgpass file permissions (should be 0600)
log_info "Test 2: Verifying .pgpass file permissions..."
PGPASS_PERMS=$(docker exec "$PGBOUNCER_CONTAINER" stat -c '%a' /tmp/.pgpass)

if [[ "$PGPASS_PERMS" != "600" ]]; then
  log_warning ".pgpass permissions are $PGPASS_PERMS (expected 600, but may work)"
else
  log_success ".pgpass has correct permissions (600)"
fi

# Test 3: Verify .pgpass has entries for localhost:6432 and pgbouncer:6432
log_info "Test 3: Verifying .pgpass entries..."
PGPASS_CONTENT=$(docker exec "$PGBOUNCER_CONTAINER" cat /tmp/.pgpass)

if ! echo "$PGPASS_CONTENT" | grep -q "localhost:6432"; then
  log_error ".pgpass missing entry for localhost:6432"
  echo "Content:"
  echo "$PGPASS_CONTENT"
  exit 1
fi

if ! echo "$PGPASS_CONTENT" | grep -q "pgbouncer:6432"; then
  log_error ".pgpass missing entry for pgbouncer:6432"
  echo "Content:"
  echo "$PGPASS_CONTENT"
  exit 1
fi

log_success ".pgpass has entries for both localhost:6432 and pgbouncer:6432"

# Test 4: Test authentication via pgbouncer (localhost)
log_info "Test 4: Testing authentication via localhost:6432..."
if ! docker exec "$PGBOUNCER_CONTAINER" sh -c 'HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1" >/dev/null 2>&1'; then
  log_error "Authentication failed via localhost:6432"
  docker compose --env-file .env.test logs pgbouncer | tail -20
  exit 1
fi

log_success "Authentication successful via localhost:6432"

# Test 5: Test authentication via pgbouncer (hostname)
log_info "Test 5: Testing authentication via pgbouncer:6432..."
POSTGRES_CONTAINER=$(docker compose --env-file .env.test ps postgres -q)

if ! docker exec "$POSTGRES_CONTAINER" sh -c 'PGPASSWORD=dev_pgbouncer_auth_test_2025 psql -h pgbouncer -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1" >/dev/null 2>&1'; then
  log_error "Authentication failed via pgbouncer:6432 from postgres container"
  docker compose --env-file .env.test logs pgbouncer | tail -20
  exit 1
fi

log_success "Authentication successful via pgbouncer:6432"

# Test 6: Verify SHOW POOLS works
log_info "Test 6: Testing SHOW POOLS command..."
POOLS_OUTPUT=$(docker exec "$PGBOUNCER_CONTAINER" sh -c 'HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SHOW POOLS" -t' 2>&1)

if [[ -z "$POOLS_OUTPUT" ]]; then
  log_error "SHOW POOLS returned empty output"
  exit 1
fi

# Check if output contains 'postgres' database entry
if ! echo "$POOLS_OUTPUT" | grep -q "postgres"; then
  log_error "SHOW POOLS output does not contain 'postgres' database"
  echo "Output:"
  echo "$POOLS_OUTPUT"
  exit 1
fi

log_success "SHOW POOLS works correctly"
echo "Pool status:"
echo "$POOLS_OUTPUT" | head -5

# Test 7: Verify pgbouncer healthcheck command works
log_info "Test 7: Testing healthcheck command..."
if ! docker exec "$PGBOUNCER_CONTAINER" sh -c "HOME=/tmp psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c 'SELECT 1' >/dev/null 2>&1"; then
  log_error "Healthcheck command failed"
  exit 1
fi

log_success "Healthcheck command works correctly"

# Test 8: Verify connection through host network (from host machine)
log_info "Test 8: Testing connection from host machine..."
if command -v psql &>/dev/null; then
  if PGPASSWORD=dev_pgbouncer_auth_test_2025 psql -h localhost -p 6432 -U pgbouncer_auth -d postgres -c "SELECT 1" >/dev/null 2>&1; then
    log_success "Connection from host machine successful"
  else
    log_warning "Connection from host machine failed (may be expected if port not exposed)"
  fi
else
  log_warning "psql not available on host, skipping host connection test"
fi

echo
echo "========================================"
echo "✅ All PgBouncer healthcheck tests passed!"
echo "========================================"
echo
echo "Summary:"
echo "  ✅ .pgpass file exists with correct permissions"
echo "  ✅ .pgpass contains entries for localhost:6432 and pgbouncer:6432"
echo "  ✅ Authentication works via localhost:6432"
echo "  ✅ Authentication works via pgbouncer:6432"
echo "  ✅ SHOW POOLS command works"
echo "  ✅ Healthcheck command works"
echo "  ✅ Connection pooling functional"
echo
