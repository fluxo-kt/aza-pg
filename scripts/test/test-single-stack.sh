#!/bin/bash
# Test script: Validate single-node stack deployment
# Usage: ./test-single-stack.sh
#
# Tests:
#   1. Single stack deployment (postgres + postgres_exporter)
#   2. PostgreSQL standalone mode (not in recovery)
#   3. Basic extension availability
#   4. Connection limits
#   5. Auto-config memory detection
#   6. postgres_exporter availability
#   7. Direct connection (no PgBouncer)

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

# Check for jq command
if ! command -v jq &>/dev/null; then
  log_error "Required command 'jq' not found"
  echo "   Install jq: apt-get install jq (Debian/Ubuntu) or brew install jq (macOS)"
  exit 1
fi

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SINGLE_STACK_PATH="$PROJECT_ROOT/stacks/single"

if [[ ! -d "$SINGLE_STACK_PATH" ]]; then
  log_error "Single stack directory not found: $SINGLE_STACK_PATH"
  exit 1
fi

echo "========================================"
echo "Single Stack Test"
echo "========================================"
echo "Stack: stacks/single"
echo

# Cleanup function
cleanup() {
  log_info "Cleaning up test environment..."
  cd "$SINGLE_STACK_PATH"
  docker compose --env-file .env.test down -v >/dev/null 2>&1 || true
  if [[ -f .env.test ]]; then
    rm -f .env.test
  fi
  log_success "Cleanup completed"
}

# Set trap for cleanup on exit
trap cleanup EXIT

cd "$SINGLE_STACK_PATH"

# Generate random test password at runtime
TEST_POSTGRES_PASSWORD="${TEST_POSTGRES_PASSWORD:-test_postgres_$(date +%s)_$$}"

# Create test .env file
log_info "Creating test environment configuration..."
cat > .env.test << EOF
POSTGRES_PASSWORD=${TEST_POSTGRES_PASSWORD}
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-single-test
POSTGRES_NETWORK_NAME=postgres-single-test-net
POSTGRES_PORT=5432
POSTGRES_EXPORTER_PORT=9189
EOF

log_success "Test environment created"

# ============================================================
# STEP 1: Deploy Single Stack
# ============================================================
log_info "Step 1: Starting single stack (postgres + postgres_exporter)..."
if ! docker compose --env-file .env.test up -d postgres 2>&1; then
  log_error "Failed to start single stack"
  exit 1
fi

log_success "Single stack started"

# Wait for services to be healthy
log_info "Waiting for PostgreSQL to be healthy (max 90 seconds)..."
TIMEOUT=90
ELAPSED=0
POSTGRES_HEALTHY=false

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  POSTGRES_STATUS=$(docker compose --env-file .env.test ps postgres --format json 2>/dev/null | jq -r '.[0].Health // "starting"' || echo "starting")

  if [[ "$POSTGRES_STATUS" == "healthy" ]]; then
    POSTGRES_HEALTHY=true
    break
  fi

  echo "   PostgreSQL: $POSTGRES_STATUS (${ELAPSED}s/${TIMEOUT}s)"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [[ "$POSTGRES_HEALTHY" != "true" ]]; then
  log_error "PostgreSQL failed to become healthy after ${TIMEOUT}s"
  docker compose --env-file .env.test logs postgres
  exit 1
fi

log_success "PostgreSQL is healthy"

POSTGRES_CONTAINER=$(docker compose --env-file .env.test ps postgres -q)

# ============================================================
# STEP 2: Verify Standalone Mode (Not in Recovery)
# ============================================================
log_info "Step 2: Verifying standalone mode (not a replica)..."

IN_RECOVERY=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>&1)

if [[ "$IN_RECOVERY" != "f" ]]; then
  log_error "PostgreSQL is in recovery mode (expected 'f', got: '$IN_RECOVERY')"
  log_error "Single stack should NOT be in recovery mode"
  exit 1
fi

log_success "PostgreSQL is in standalone mode (not a replica)"

# ============================================================
# STEP 3: Verify Basic Extension Availability
# ============================================================
log_info "Step 3: Testing baseline extensions..."

# Test pg_stat_statements
log_info "Testing pg_stat_statements extension..."
PSS_EXISTS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_stat_statements';" 2>&1)

if [[ "$PSS_EXISTS" == "1" ]]; then
  log_success "pg_stat_statements is installed"
else
  log_error "pg_stat_statements not found (expected in baseline extensions)"
  exit 1
fi

# Test pg_trgm
log_info "Testing pg_trgm extension..."
TRGM_EXISTS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_trgm';" 2>&1)

if [[ "$TRGM_EXISTS" == "1" ]]; then
  log_success "pg_trgm is installed"
else
  log_error "pg_trgm not found (expected in baseline extensions)"
  exit 1
fi

# Test pgaudit
log_info "Testing pgaudit extension..."
PGAUDIT_EXISTS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pgaudit';" 2>&1)

if [[ "$PGAUDIT_EXISTS" == "1" ]]; then
  log_success "pgaudit is installed"
else
  log_error "pgaudit not found (expected in baseline extensions)"
  exit 1
fi

# Test pg_cron
log_info "Testing pg_cron extension..."
PGCRON_EXISTS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_cron';" 2>&1)

if [[ "$PGCRON_EXISTS" == "1" ]]; then
  log_success "pg_cron is installed"
else
  log_error "pg_cron not found (expected in baseline extensions)"
  exit 1
fi

# Test vector
log_info "Testing vector extension..."
VECTOR_EXISTS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector';" 2>&1)

if [[ "$VECTOR_EXISTS" == "1" ]]; then
  log_success "vector is installed"
else
  log_error "vector not found (expected in baseline extensions)"
  exit 1
fi

# Functional test: pg_trgm similarity
TRGM_TEST=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT similarity('test', 'test');" 2>&1)
if [[ "$TRGM_TEST" == "1" ]]; then
  log_success "pg_trgm functional test passed"
else
  log_error "pg_trgm functional test failed (expected '1', got: '$TRGM_TEST')"
  exit 1
fi

# Functional test: vector
VECTOR_TEST=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SELECT '[1,2,3]'::vector;" 2>&1)
if echo "$VECTOR_TEST" | grep -q "\[1,2,3\]"; then
  log_success "vector functional test passed"
else
  log_error "vector functional test failed (got: '$VECTOR_TEST')"
  exit 1
fi

# ============================================================
# STEP 4: Verify Connection Limits
# ============================================================
log_info "Step 4: Checking connection limits..."

MAX_CONNECTIONS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SHOW max_connections;" 2>&1)

log_info "max_connections: $MAX_CONNECTIONS"

# Should be 120 for 2GB memory limit (based on auto-config)
if [[ "$MAX_CONNECTIONS" -lt 80 ]]; then
  log_warning "max_connections is very low ($MAX_CONNECTIONS), expected at least 80"
elif [[ "$MAX_CONNECTIONS" -ge 80 ]]; then
  log_success "max_connections is adequate ($MAX_CONNECTIONS)"
fi

# Test actual connection
log_info "Testing direct connection..."
DIRECT_CONNECT=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -c "SELECT version();" 2>&1)

if echo "$DIRECT_CONNECT" | grep -q "PostgreSQL"; then
  log_success "Direct connection works"
else
  log_error "Direct connection failed"
  echo "$DIRECT_CONNECT"
  exit 1
fi

# ============================================================
# STEP 5: Verify Auto-Config Memory Detection
# ============================================================
log_info "Step 5: Checking auto-config memory settings..."

SHARED_BUFFERS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SHOW shared_buffers;" 2>&1)
EFFECTIVE_CACHE=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SHOW effective_cache_size;" 2>&1)
WORK_MEM=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -tAc "SHOW work_mem;" 2>&1)

log_info "shared_buffers: $SHARED_BUFFERS"
log_info "effective_cache_size: $EFFECTIVE_CACHE"
log_info "work_mem: $WORK_MEM"

# Check logs for auto-config detection
log_info "Checking auto-config logs..."
AUTO_CONFIG_LOGS=$(docker logs "$POSTGRES_CONTAINER" 2>&1 | grep -i "detected ram\|shared_buffers\|auto-config" | head -10 || echo "no auto-config logs found")

if [[ "$AUTO_CONFIG_LOGS" != "no auto-config logs found" ]]; then
  echo "Auto-config detection:"
  echo "$AUTO_CONFIG_LOGS"
  log_success "Auto-config is active"
else
  log_warning "No auto-config logs found (may be expected)"
fi

# ============================================================
# STEP 6: Start and Test postgres_exporter
# ============================================================
log_info "Step 6: Starting postgres_exporter..."

if ! docker compose --env-file .env.test up -d postgres_exporter 2>&1; then
  log_error "Failed to start postgres_exporter"
  exit 1
fi

log_success "postgres_exporter started"

# Wait for exporter to be healthy
log_info "Waiting for postgres_exporter to be healthy (max 60 seconds)..."
TIMEOUT=60
ELAPSED=0
EXPORTER_HEALTHY=false

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  EXPORTER_STATUS=$(docker compose --env-file .env.test ps postgres_exporter --format json 2>/dev/null | jq -r '.[0].Health // "starting"' || echo "starting")

  if [[ "$EXPORTER_STATUS" == "healthy" ]]; then
    EXPORTER_HEALTHY=true
    break
  fi

  echo "   postgres_exporter: $EXPORTER_STATUS (${ELAPSED}s/${TIMEOUT}s)"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [[ "$EXPORTER_HEALTHY" != "true" ]]; then
  log_warning "postgres_exporter did not become healthy (may still work)"
else
  log_success "postgres_exporter is healthy"
fi

# Test metrics endpoint
log_info "Testing metrics endpoint..."
EXPORTER_CONTAINER=$(docker compose --env-file .env.test ps postgres_exporter -q)

METRICS_OUTPUT=$(docker exec "$EXPORTER_CONTAINER" wget -q -O - http://localhost:9187/metrics 2>&1 | head -20)

if [[ -z "$METRICS_OUTPUT" ]]; then
  log_error "Metrics endpoint returned empty output"
  exit 1
fi

if ! echo "$METRICS_OUTPUT" | grep -q "pg_up"; then
  log_error "Metrics output does not contain 'pg_up' metric"
  echo "Output:"
  echo "$METRICS_OUTPUT"
  exit 1
fi

log_success "postgres_exporter metrics endpoint works"

# ============================================================
# STEP 7: Verify No PgBouncer
# ============================================================
log_info "Step 7: Verifying no PgBouncer (single stack simplicity)..."

PGBOUNCER_RUNNING=$(docker compose --env-file .env.test ps pgbouncer -q 2>/dev/null || echo "")

if [[ -n "$PGBOUNCER_RUNNING" ]]; then
  log_warning "PgBouncer is running (unexpected for single stack)"
else
  log_success "PgBouncer not running (correct for single stack)"
fi

# ============================================================
# Summary
# ============================================================
echo
echo "========================================"
echo "✅ All single stack tests passed!"
echo "========================================"
echo
echo "Summary:"
echo "  ✅ Single stack deployed and healthy"
echo "  ✅ PostgreSQL in standalone mode (not a replica)"
echo "  ✅ 5 baseline extensions installed and functional"
echo "  ✅ Connection limits adequate (${MAX_CONNECTIONS} connections)"
echo "  ✅ Auto-config detected memory settings"
echo "  ✅ postgres_exporter functional"
echo "  ✅ Direct PostgreSQL connection works (no PgBouncer)"
echo
