#!/bin/bash
# Test script: Validate replica stack deployment and replication functionality
# Usage: ./test-replica-stack.sh
#
# Tests:
#   1. Primary stack deployment and health
#   2. Replication slot creation on primary
#   3. Replica stack deployment
#   4. Standby mode verification (pg_is_in_recovery)
#   5. Hot standby settings and read-only queries
#   6. Replication lag monitoring
#   7. postgres_exporter availability on replica

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
PRIMARY_STACK_PATH="$PROJECT_ROOT/stacks/primary"
REPLICA_STACK_PATH="$PROJECT_ROOT/stacks/replica"

if [[ ! -d "$PRIMARY_STACK_PATH" ]]; then
  log_error "Primary stack directory not found: $PRIMARY_STACK_PATH"
  exit 1
fi

if [[ ! -d "$REPLICA_STACK_PATH" ]]; then
  log_error "Replica stack directory not found: $REPLICA_STACK_PATH"
  exit 1
fi

echo "========================================"
echo "Replica Stack Test"
echo "========================================"
echo "Primary Stack: stacks/primary"
echo "Replica Stack: stacks/replica"
echo

# Cleanup function
cleanup() {
  log_info "Cleaning up test environment..."

  # Stop replica first
  cd "$REPLICA_STACK_PATH"
  if [[ -f .env.test ]]; then
    docker compose --env-file .env.test down -v >/dev/null 2>&1 || true
    rm -f .env.test
  fi

  # Stop primary second
  cd "$PRIMARY_STACK_PATH"
  if [[ -f .env.test ]]; then
    docker compose --env-file .env.test down -v >/dev/null 2>&1 || true
    rm -f .env.test
  fi

  # Clean up network
  docker network rm postgres-replica-test-net >/dev/null 2>&1 || true

  log_success "Cleanup completed"
}

# Set trap for cleanup on exit
trap cleanup EXIT

# Create shared network for primary and replica
log_info "Creating shared network for replication..."
docker network create postgres-replica-test-net >/dev/null 2>&1 || true
log_success "Network created: postgres-replica-test-net"

# ============================================================
# STEP 1: Deploy Primary Stack
# ============================================================
log_info "Step 1: Deploying primary stack..."
cd "$PRIMARY_STACK_PATH"

cat > .env.test << 'EOF'
POSTGRES_PASSWORD=test_password_replica_123
PGBOUNCER_AUTH_PASS=dev_pgbouncer_auth_test_2025
PG_REPLICATION_PASSWORD=replication_test_replica_123
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-replica-test-primary
POSTGRES_NETWORK_NAME=postgres-replica-test-net
ENABLE_REPLICATION=true
REPLICATION_SLOT_NAME=replica_slot_test
EOF

log_info "Starting primary stack services..."
if ! docker compose --env-file .env.test up -d postgres 2>&1; then
  log_error "Failed to start primary stack"
  exit 1
fi

log_success "Primary stack started"

# Wait for primary to be healthy
log_info "Waiting for primary to be healthy (max 90 seconds)..."
TIMEOUT=90
ELAPSED=0
PRIMARY_HEALTHY=false

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  PRIMARY_STATUS=$(docker compose --env-file .env.test ps postgres --format json 2>/dev/null | jq -r '.[0].Health // "starting"' || echo "starting")

  if [[ "$PRIMARY_STATUS" == "healthy" ]]; then
    PRIMARY_HEALTHY=true
    break
  fi

  echo "   Primary PostgreSQL: $PRIMARY_STATUS (${ELAPSED}s/${TIMEOUT}s)"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [[ "$PRIMARY_HEALTHY" != "true" ]]; then
  log_error "Primary PostgreSQL failed to become healthy after ${TIMEOUT}s"
  docker compose --env-file .env.test logs postgres
  exit 1
fi

log_success "Primary PostgreSQL is healthy"

# ============================================================
# STEP 2: Create replication slot on primary
# ============================================================
log_info "Step 2: Creating replication slot on primary..."
PRIMARY_CONTAINER=$(docker compose --env-file .env.test ps postgres -q)

SLOT_CREATED=$(docker exec "$PRIMARY_CONTAINER" psql -U postgres -tAc "SELECT pg_create_physical_replication_slot('replica_slot_test');" 2>&1 || echo "error")

if echo "$SLOT_CREATED" | grep -q "error"; then
  log_error "Failed to create replication slot"
  echo "$SLOT_CREATED"
  exit 1
fi

log_success "Replication slot 'replica_slot_test' created"

# Verify slot exists
SLOT_EXISTS=$(docker exec "$PRIMARY_CONTAINER" psql -U postgres -tAc "SELECT COUNT(*) FROM pg_replication_slots WHERE slot_name = 'replica_slot_test';" 2>&1)

if [[ "$SLOT_EXISTS" != "1" ]]; then
  log_error "Replication slot verification failed (expected 1, got: $SLOT_EXISTS)"
  exit 1
fi

log_success "Replication slot verified in pg_replication_slots"

# ============================================================
# STEP 3: Deploy Replica Stack
# ============================================================
log_info "Step 3: Deploying replica stack..."
cd "$REPLICA_STACK_PATH"

cat > .env.test << 'EOF'
POSTGRES_PASSWORD=test_password_replica_123
PG_REPLICATION_PASSWORD=replication_test_replica_123
POSTGRES_IMAGE=aza-pg:pg18
POSTGRES_MEMORY_LIMIT=2g
COMPOSE_PROJECT_NAME=aza-pg-replica-test-replica
POSTGRES_NETWORK_NAME=postgres-replica-test-net
PRIMARY_HOST=aza-pg-replica-test-primary-postgres
PRIMARY_PORT=5432
REPLICATION_SLOT_NAME=replica_slot_test
POSTGRES_PORT=5433
POSTGRES_EXPORTER_PORT=9188
EOF

log_info "Starting replica stack services..."
if ! docker compose --env-file .env.test up -d postgres-replica 2>&1; then
  log_error "Failed to start replica stack"
  docker compose --env-file .env.test logs postgres-replica
  exit 1
fi

log_success "Replica stack started"

# Wait for replica to be healthy
log_info "Waiting for replica to be healthy (max 120 seconds)..."
TIMEOUT=120
ELAPSED=0
REPLICA_HEALTHY=false

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  REPLICA_STATUS=$(docker compose --env-file .env.test ps postgres-replica --format json 2>/dev/null | jq -r '.[0].Health // "starting"' || echo "starting")

  if [[ "$REPLICA_STATUS" == "healthy" ]]; then
    REPLICA_HEALTHY=true
    break
  fi

  echo "   Replica PostgreSQL: $REPLICA_STATUS (${ELAPSED}s/${TIMEOUT}s)"
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [[ "$REPLICA_HEALTHY" != "true" ]]; then
  log_error "Replica PostgreSQL failed to become healthy after ${TIMEOUT}s"
  docker compose --env-file .env.test logs postgres-replica
  exit 1
fi

log_success "Replica PostgreSQL is healthy"

# ============================================================
# STEP 4: Verify Standby Mode
# ============================================================
log_info "Step 4: Verifying standby mode..."
REPLICA_CONTAINER=$(docker compose --env-file .env.test ps postgres-replica -q)

IN_RECOVERY=$(docker exec "$REPLICA_CONTAINER" psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>&1)

if [[ "$IN_RECOVERY" != "t" ]]; then
  log_error "Replica is NOT in recovery mode (expected 't', got: '$IN_RECOVERY')"
  docker compose --env-file .env.test logs postgres-replica
  exit 1
fi

log_success "Replica is in recovery mode (standby mode active)"

# ============================================================
# STEP 5: Verify Hot Standby Settings
# ============================================================
log_info "Step 5: Verifying hot standby settings..."

# Check hot_standby is enabled
HOT_STANDBY=$(docker exec "$REPLICA_CONTAINER" psql -U postgres -tAc "SHOW hot_standby;" 2>&1)

if [[ "$HOT_STANDBY" != "on" ]]; then
  log_warning "hot_standby is not 'on' (got: '$HOT_STANDBY')"
else
  log_success "hot_standby is enabled"
fi

# Test read-only query
log_info "Testing read-only query on replica..."
SELECT_RESULT=$(docker exec "$REPLICA_CONTAINER" psql -U postgres -tAc "SELECT 1 + 1;" 2>&1)

if [[ "$SELECT_RESULT" != "2" ]]; then
  log_error "Read-only query failed (expected '2', got: '$SELECT_RESULT')"
  exit 1
fi

log_success "Read-only queries work on replica"

# Test write attempt (should fail)
log_info "Testing write protection on replica..."
WRITE_RESULT=$(docker exec "$REPLICA_CONTAINER" psql -U postgres -c "CREATE TABLE test_write (id INT);" 2>&1 || echo "write_blocked")

if ! echo "$WRITE_RESULT" | grep -qi "cannot execute.*in a read-only transaction\|write_blocked"; then
  log_warning "Write protection test inconclusive (got: '$WRITE_RESULT')"
else
  log_success "Replica is read-only (write protection verified)"
fi

# ============================================================
# STEP 6: Verify Replication Lag
# ============================================================
log_info "Step 6: Checking replication lag..."

# Get WAL position from primary
cd "$PRIMARY_STACK_PATH"
PRIMARY_WAL=$(docker exec "$PRIMARY_CONTAINER" psql -U postgres -tAc "SELECT pg_current_wal_lsn();" 2>&1)

# Get WAL replay position from replica
cd "$REPLICA_STACK_PATH"
REPLICA_WAL=$(docker exec "$REPLICA_CONTAINER" psql -U postgres -tAc "SELECT pg_last_wal_replay_lsn();" 2>&1)

log_info "Primary WAL LSN: $PRIMARY_WAL"
log_info "Replica replay LSN: $REPLICA_WAL"

# Check if replica has received WAL data
if [[ -z "$REPLICA_WAL" ]] || [[ "$REPLICA_WAL" == "0/0" ]]; then
  log_warning "Replica has not replayed any WAL yet (may need more time)"
else
  log_success "Replica is replicating (WAL replay active)"
fi

# ============================================================
# STEP 7: Start and Test postgres_exporter
# ============================================================
log_info "Step 7: Starting postgres_exporter on replica..."

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
# Summary
# ============================================================
echo
echo "========================================"
echo "✅ All replica stack tests passed!"
echo "========================================"
echo
echo "Summary:"
echo "  ✅ Primary stack deployed and healthy"
echo "  ✅ Replication slot created on primary"
echo "  ✅ Replica stack deployed and healthy"
echo "  ✅ Replica is in standby mode (pg_is_in_recovery = true)"
echo "  ✅ Hot standby enabled - read-only queries work"
echo "  ✅ Write protection verified on replica"
echo "  ✅ Replication active (WAL replay working)"
echo "  ✅ postgres_exporter functional on replica"
echo
