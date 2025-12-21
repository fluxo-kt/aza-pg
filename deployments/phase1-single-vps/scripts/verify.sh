#!/usr/bin/env bash
set -euo pipefail

# Comprehensive Verification Script
# Tests all components of the aza-pg deployment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

TESTS_PASSED=0
TESTS_FAILED=0

test_section() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

test_pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((TESTS_PASSED++))
}

test_fail() {
    echo -e "${RED}✗${NC} $1"
    ((TESTS_FAILED++))
}

test_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

cd "$DEPLOY_DIR"
source "$DEPLOY_DIR/.env" 2>/dev/null || true

test_section "1. Docker Environment"

# Test 1.1: Docker running
if docker info &>/dev/null; then
    test_pass "Docker daemon running"
else
    test_fail "Docker daemon not running"
    exit 1
fi

# Test 1.2: Docker Compose version
if docker compose version &>/dev/null; then
    test_pass "Docker Compose available"
else
    test_fail "Docker Compose not available"
fi

# Test 1.3: Network exists
if docker network inspect aza-pg-network &>/dev/null; then
    test_pass "aza-pg-network exists"
else
    test_fail "aza-pg-network does not exist"
fi

test_section "2. Container Status"

CONTAINERS=(postgres pgbouncer postgres-exporter pgbouncer-exporter prometheus grafana)

for container in "${CONTAINERS[@]}"; do
    if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
        test_pass "Container '$container' running"
    else
        test_fail "Container '$container' not running"
    fi
done

test_section "3. PostgreSQL Tests"

# Test 3.1: Connection
if docker exec postgres pg_isready -U postgres &>/dev/null; then
    test_pass "PostgreSQL accepts connections"
else
    test_fail "PostgreSQL not accepting connections"
fi

# Test 3.2: Version
PG_VERSION=$(docker exec postgres psql -U postgres -Atq -c "SELECT version();" 2>/dev/null || echo "")
if [[ "$PG_VERSION" == *"PostgreSQL 18"* ]]; then
    test_pass "PostgreSQL version 18 confirmed"
else
    test_fail "PostgreSQL version unexpected: $PG_VERSION"
fi

# Test 3.3: Auto-config
SHARED_BUFFERS=$(docker exec postgres psql -U postgres -Atq -c "SHOW shared_buffers;" 2>/dev/null)
if [[ "$SHARED_BUFFERS" =~ [0-9]+MB ]]; then
    test_pass "shared_buffers configured: $SHARED_BUFFERS"
else
    test_warn "shared_buffers value unexpected: $SHARED_BUFFERS"
fi

# Test 3.4: Extensions
EXTENSIONS=(pg_stat_statements auto_explain pgvector timescaledb pgaudit pgsodium)
for ext in "${EXTENSIONS[@]}"; do
    if docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} -Atq -c \
        "SELECT 1 FROM pg_available_extensions WHERE name='$ext';" | grep -q "1"; then
        test_pass "Extension '$ext' available"
    else
        test_warn "Extension '$ext' not available"
    fi
done

# Test 3.5: Create test table
if docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} <<EOF &>/dev/null
CREATE TABLE IF NOT EXISTS verify_test (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), data TEXT);
INSERT INTO verify_test (data) VALUES ('test-$(date +%s)');
SELECT count(*) FROM verify_test;
DROP TABLE verify_test;
EOF
then
    test_pass "Table create/insert/drop operations work"
else
    test_fail "Table operations failed"
fi

test_section "4. PgBouncer Tests"

# Test 4.1: Connection
if docker exec pgbouncer psql -h localhost -p 6432 -U postgres -d ${POSTGRES_DB:-main} -c "SELECT 1;" &>/dev/null; then
    test_pass "PgBouncer connection successful"
else
    test_fail "PgBouncer connection failed"
fi

# Test 4.2: Pool configuration
POOL_MODE=$(docker exec pgbouncer psql -h localhost -p 6432 -U postgres -Atq -c "SHOW pool_mode;" 2>/dev/null || echo "")
if [ "$POOL_MODE" = "transaction" ]; then
    test_pass "Pool mode: transaction (correct)"
elif [ "$POOL_MODE" = "session" ]; then
    test_warn "Pool mode: session (consider using transaction mode)"
else
    test_fail "Pool mode: $POOL_MODE (unexpected)"
fi

# Test 4.3: Pool stats
POOL_STATS=$(docker exec pgbouncer psql -h localhost -p 6432 -U postgres -Atq -c "SHOW STATS;" 2>/dev/null | head -n1 || echo "")
if [ -n "$POOL_STATS" ]; then
    test_pass "Pool statistics available"
else
    test_fail "Cannot query pool statistics"
fi

test_section "5. Monitoring Tests"

# Test 5.1: postgres_exporter
if curl -s http://localhost:9187/metrics | grep -q "pg_up 1"; then
    test_pass "postgres_exporter reporting pg_up=1"
else
    test_fail "postgres_exporter not reporting correctly"
fi

# Test 5.2: pgbouncer_exporter
if curl -s http://localhost:9127/metrics | grep -q "pgbouncer"; then
    test_pass "pgbouncer_exporter responding"
else
    test_fail "pgbouncer_exporter not responding"
fi

# Test 5.3: Prometheus
if curl -s http://localhost:9090/-/healthy | grep -q "Prometheus"; then
    test_pass "Prometheus healthy"
else
    test_fail "Prometheus not healthy"
fi

# Test 5.4: Prometheus targets
if curl -s http://localhost:9090/api/v1/targets | grep -q "postgres-exporter"; then
    test_pass "Prometheus scraping postgres-exporter"
else
    test_fail "Prometheus not scraping targets correctly"
fi

# Test 5.5: Grafana
if curl -s http://localhost:3000/api/health | grep -q "ok"; then
    test_pass "Grafana API responding"
else
    test_fail "Grafana not responding"
fi

test_section "6. Performance Tests"

# Test 6.1: Simple pgbench
test_warn "Running pgbench (10 second test)..."
if docker exec postgres pgbench -U postgres -i -s 1 ${POSTGRES_DB:-main} &>/dev/null; then
    PGBENCH_RESULT=$(docker exec postgres pgbench -U postgres -c 4 -j 2 -T 10 ${POSTGRES_DB:-main} 2>&1 | grep "tps")
    if [ -n "$PGBENCH_RESULT" ]; then
        test_pass "pgbench completed: $PGBENCH_RESULT"
    else
        test_fail "pgbench failed to complete"
    fi
else
    test_fail "pgbench initialization failed"
fi

# Test 6.2: Connection pool stress test
test_warn "Testing connection pooling (50 concurrent connections)..."
for _ in {1..50}; do
    docker exec pgbouncer psql -h localhost -p 6432 -U postgres -d ${POSTGRES_DB:-main} -c "SELECT pg_sleep(0.1);" &>/dev/null &
done
wait

POOL_INFO=$(docker exec pgbouncer psql -h localhost -p 6432 -U postgres -Atq -c "SHOW POOLS;" | head -n1)
SV_ACTIVE=$(echo "$POOL_INFO" | cut -d'|' -f5)
if [ "$SV_ACTIVE" -le 25 ]; then
    test_pass "Connection pooling working (50 clients → $SV_ACTIVE server connections)"
else
    test_warn "Server connections: $SV_ACTIVE (expected ≤25)"
fi

test_section "7. Backup Configuration"

# Test 7.1: pgBackRest config exists
if [ -f "$DEPLOY_DIR/pgbackrest/pgbackrest.conf" ]; then
    test_pass "pgBackRest configuration exists"

    if grep -q "CHANGE_ME\|YOUR_" "$DEPLOY_DIR/pgbackrest/pgbackrest.conf"; then
        test_warn "pgBackRest config has placeholder values (update before use)"
    fi
else
    test_warn "pgBackRest configuration not found (optional)"
fi

# Test 7.2: PgBouncer userlist
if [ -f "$DEPLOY_DIR/pgbouncer/userlist.txt" ]; then
    test_pass "PgBouncer userlist.txt exists"

    if grep -q "SCRAM-SHA-256" "$DEPLOY_DIR/pgbouncer/userlist.txt"; then
        test_pass "PgBouncer using SCRAM-SHA-256 authentication"
    else
        test_warn "PgBouncer userlist format unexpected"
    fi
else
    test_fail "PgBouncer userlist.txt not found"
fi

test_section "8. Security Tests"

# Test 8.1: PostgreSQL not exposed publicly
if netstat -tuln 2>/dev/null | grep -q ":5432.*0.0.0.0"; then
    test_fail "PostgreSQL exposed on 0.0.0.0 (security risk!)"
else
    test_pass "PostgreSQL not exposed publicly"
fi

# Test 8.2: Password strength
if [ -f "$DEPLOY_DIR/.env" ]; then
    if grep -q "CHANGE_ME" "$DEPLOY_DIR/.env"; then
        test_fail ".env contains CHANGE_ME placeholders"
    else
        test_pass ".env passwords updated"
    fi

    PG_PASS_LEN=$(grep "POSTGRES_PASSWORD=" "$DEPLOY_DIR/.env" | cut -d'=' -f2 | tr -d '"' | wc -c)
    if [ "$PG_PASS_LEN" -ge 20 ]; then
        test_pass "POSTGRES_PASSWORD length sufficient (${PG_PASS_LEN} chars)"
    else
        test_warn "POSTGRES_PASSWORD short (${PG_PASS_LEN} chars, recommend ≥32)"
    fi
fi

# Test 8.3: File permissions
USERLIST_PERMS=$(stat -c "%a" "$DEPLOY_DIR/pgbouncer/userlist.txt" 2>/dev/null || echo "000")
if [ "$USERLIST_PERMS" = "600" ]; then
    test_pass "userlist.txt permissions correct (600)"
else
    test_warn "userlist.txt permissions: $USERLIST_PERMS (should be 600)"
fi

test_section "9. Resource Usage"

# Test 9.1: CPU usage
CPU_USAGE=$(docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}" postgres | awk '{print $2}' | sed 's/%//')
if [ "${CPU_USAGE%.*}" -lt 80 ]; then
    test_pass "PostgreSQL CPU usage: ${CPU_USAGE}%"
else
    test_warn "PostgreSQL CPU usage high: ${CPU_USAGE}%"
fi

# Test 9.2: Memory usage
MEM_USAGE=$(docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" postgres | awk '{print $2}')
test_pass "PostgreSQL memory usage: $MEM_USAGE"

test_section "10. Disk I/O"

# Test 10.1: WAL directory size
WAL_SIZE=$(docker exec postgres psql -U postgres -Atq -c "SELECT pg_size_pretty(pg_wal_dir_size());" 2>/dev/null || echo "unknown")
test_pass "WAL directory size: $WAL_SIZE"

# Test 10.2: Database bloat check (simple)
BLOAT=$(docker exec postgres psql -U postgres -d ${POSTGRES_DB:-main} -Atq -c \
    "SELECT count(*) FROM pg_stat_user_tables WHERE n_dead_tup > n_live_tup;" 2>/dev/null || echo "0")

if [ "$BLOAT" -eq 0 ]; then
    test_pass "No tables with excessive dead tuples"
else
    test_warn "$BLOAT tables have more dead tuples than live (run VACUUM)"
fi

test_section "Summary"

TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))
PASS_RATE=$((TESTS_PASSED * 100 / TOTAL_TESTS))

echo ""
echo "========================================="
echo "Verification Complete"
echo "========================================="
echo ""
echo "Total Tests: $TOTAL_TESTS"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo "Pass Rate: ${PASS_RATE}%"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed! System is healthy.${NC}"
    exit 0
elif [ "$PASS_RATE" -ge 90 ]; then
    echo -e "${YELLOW}⚠ Most tests passed. Review failures above.${NC}"
    exit 1
else
    echo -e "${RED}✗ Multiple failures detected. System needs attention.${NC}"
    exit 1
fi
