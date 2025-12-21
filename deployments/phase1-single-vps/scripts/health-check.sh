#!/usr/bin/env bash
set -euo pipefail

# Daily Health Check Script
# Run this daily (via cron or manually) to verify system health

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo "========================================"
echo "aza-pg Health Check - $(date)"
echo "========================================"
echo ""

# Load environment
if [ -f "$DEPLOY_DIR/.env" ]; then
    source "$DEPLOY_DIR/.env"
fi

cd "$DEPLOY_DIR"

# Check 1: All containers running
echo "1. Container Status"
EXPECTED_CONTAINERS=6
RUNNING_CONTAINERS=$(docker compose ps --status running | grep -c "running" || true)

if [ "$RUNNING_CONTAINERS" -eq "$EXPECTED_CONTAINERS" ]; then
    check_pass "All $EXPECTED_CONTAINERS containers running"
else
    check_fail "Only $RUNNING_CONTAINERS/$EXPECTED_CONTAINERS containers running"
    docker compose ps
fi
echo ""

# Check 2: PostgreSQL health
echo "2. PostgreSQL Status"
if docker exec postgres pg_isready -U postgres &>/dev/null; then
    check_pass "PostgreSQL accepting connections"

    # Check version
    PG_VERSION=$(docker exec postgres psql -U postgres -Atq -c "SELECT version();" | head -n1)
    echo "   Version: $PG_VERSION"
else
    check_fail "PostgreSQL not responding"
fi
echo ""

# Check 3: Connection count
echo "3. Database Connections"
CONN_COUNT=$(docker exec postgres psql -U postgres -Atq -c "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null || echo "0")
MAX_CONN=$(docker exec postgres psql -U postgres -Atq -c "SHOW max_connections;" 2>/dev/null || echo "200")

CONN_PCT=$((CONN_COUNT * 100 / MAX_CONN))
if [ "$CONN_PCT" -lt 80 ]; then
    check_pass "Connections: $CONN_COUNT/$MAX_CONN (${CONN_PCT}%)"
elif [ "$CONN_PCT" -lt 90 ]; then
    check_warn "Connections: $CONN_COUNT/$MAX_CONN (${CONN_PCT}%) - Getting high"
else
    check_fail "Connections: $CONN_COUNT/$MAX_CONN (${CONN_PCT}%) - CRITICAL"
fi
echo ""

# Check 4: Database size
echo "4. Database Size"
DB_SIZE=$(docker exec postgres psql -U postgres -Atq -c "SELECT pg_size_pretty(pg_database_size('${POSTGRES_DB:-main}'));" 2>/dev/null || echo "unknown")
check_pass "Database '${POSTGRES_DB:-main}': $DB_SIZE"
echo ""

# Check 5: PgBouncer pools
echo "5. PgBouncer Connection Pools"
POOL_INFO=$(docker exec pgbouncer psql -h localhost -p 6432 -U postgres -Atq -c "SHOW POOLS;" 2>/dev/null | head -n1 || echo "")
if [ -n "$POOL_INFO" ]; then
    CL_ACTIVE=$(echo "$POOL_INFO" | cut -d'|' -f3)
    SV_ACTIVE=$(echo "$POOL_INFO" | cut -d'|' -f5)
    MAXWAIT=$(echo "$POOL_INFO" | cut -d'|' -f10)

    check_pass "Active clients: $CL_ACTIVE, Active servers: $SV_ACTIVE"

    if [ "$MAXWAIT" -gt 0 ]; then
        check_warn "Clients waiting: $MAXWAIT (pool may be saturated)"
    fi
else
    check_fail "Cannot query PgBouncer pools"
fi
echo ""

# Check 6: Replication status (Phase 2 only)
echo "6. Replication Status"
IS_RECOVERY=$(docker exec postgres psql -U postgres -Atq -c "SELECT pg_is_in_recovery();" 2>/dev/null || echo "")
if [ "$IS_RECOVERY" = "t" ]; then
    check_warn "This is a REPLICA (in recovery mode)"

    LAG=$(docker exec postgres psql -U postgres -Atq -c \
        "SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn());" 2>/dev/null || echo "unknown")

    if [ "$LAG" != "unknown" ]; then
        LAG_MB=$((LAG / 1024 / 1024))
        if [ "$LAG_MB" -lt 10 ]; then
            check_pass "Replication lag: ${LAG_MB}MB"
        else
            check_warn "Replication lag: ${LAG_MB}MB (high)"
        fi
    fi
elif [ "$IS_RECOVERY" = "f" ]; then
    check_pass "This is PRIMARY (not in recovery)"

    # Check if replicas connected
    REPLICA_COUNT=$(docker exec postgres psql -U postgres -Atq -c \
        "SELECT count(*) FROM pg_stat_replication;" 2>/dev/null || echo "0")

    if [ "$REPLICA_COUNT" -gt 0 ]; then
        check_pass "$REPLICA_COUNT replica(s) connected"
    else
        echo "   No replicas connected (Phase 1 setup)"
    fi
fi
echo ""

# Check 7: Cache hit ratio
echo "7. Cache Hit Ratio"
CACHE_HIT=$(docker exec postgres psql -U postgres -Atq -c \
    "SELECT round(sum(blks_hit)::numeric / nullif((sum(blks_hit) + sum(blks_read)), 0) * 100, 2) FROM pg_stat_database;" 2>/dev/null || echo "0")

if [ "${CACHE_HIT%.*}" -ge 99 ]; then
    check_pass "Cache hit ratio: ${CACHE_HIT}%"
elif [ "${CACHE_HIT%.*}" -ge 95 ]; then
    check_warn "Cache hit ratio: ${CACHE_HIT}% (should be >99%)"
else
    check_fail "Cache hit ratio: ${CACHE_HIT}% (LOW - investigate)"
fi
echo ""

# Check 8: Disk usage
echo "8. Disk Usage"
DISK_USAGE=$(df -h /var/lib/postgresql/data 2>/dev/null | awk 'NR==2 {print $5}' | sed 's/%//' || echo "100")
DISK_AVAIL=$(df -h /var/lib/postgresql/data 2>/dev/null | awk 'NR==2 {print $4}' || echo "unknown")

if [ "$DISK_USAGE" -lt 80 ]; then
    check_pass "Disk usage: ${DISK_USAGE}% (${DISK_AVAIL} available)"
elif [ "$DISK_USAGE" -lt 90 ]; then
    check_warn "Disk usage: ${DISK_USAGE}% (${DISK_AVAIL} available) - Monitor closely"
else
    check_fail "Disk usage: ${DISK_USAGE}% (${DISK_AVAIL} available) - CRITICAL"
fi
echo ""

# Check 9: Recent errors in logs
echo "9. Recent Log Errors"
ERROR_COUNT=$(docker logs postgres --since 24h 2>&1 | grep -v "pg_isready" | grep -ic "ERROR\|FATAL\|PANIC" || echo "0")

if [ "$ERROR_COUNT" -eq 0 ]; then
    check_pass "No errors in last 24 hours"
elif [ "$ERROR_COUNT" -lt 10 ]; then
    check_warn "$ERROR_COUNT errors in last 24 hours"
    docker logs postgres --since 24h 2>&1 | grep -v "pg_isready" | grep -i "ERROR\|FATAL\|PANIC" | tail -n5
else
    check_fail "$ERROR_COUNT errors in last 24 hours (investigate!)"
    docker logs postgres --since 24h 2>&1 | grep -v "pg_isready" | grep -i "ERROR\|FATAL\|PANIC" | tail -n10
fi
echo ""

# Check 10: Backup status (via Postgresus - manual check required)
echo "10. Backup Status"
check_warn "Check Postgresus UI manually: http://VPS_IP:3002"
echo "   Last backup should be within 24 hours"
echo ""

# Check 11: Long-running queries
echo "11. Long-Running Queries"
LONG_QUERIES=$(docker exec postgres psql -U postgres -Atq -c \
    "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 minutes';" 2>/dev/null || echo "0")

if [ "$LONG_QUERIES" -eq 0 ]; then
    check_pass "No queries running longer than 5 minutes"
else
    check_warn "$LONG_QUERIES queries running longer than 5 minutes"
    docker exec postgres psql -U postgres -c \
        "SELECT pid, now() - query_start AS duration, left(query, 60) FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 minutes';"
fi
echo ""

# Check 12: Monitoring endpoints
echo "12. Monitoring Endpoints"
if curl -s http://localhost:9187/metrics | grep -q "pg_up"; then
    check_pass "postgres_exporter responding"
else
    check_fail "postgres_exporter not responding"
fi

if curl -s http://localhost:9090/-/healthy | grep -q "Prometheus"; then
    check_pass "Prometheus responding"
else
    check_fail "Prometheus not responding"
fi

if curl -s http://localhost:3000/api/health | grep -q "ok"; then
    check_pass "Grafana responding"
else
    check_fail "Grafana not responding"
fi
echo ""

echo "========================================"
echo "Health Check Complete - $(date)"
echo "========================================"
echo ""
echo "Next actions:"
echo "  - Review any warnings or failures above"
echo "  - Check Grafana dashboard: http://VPS_IP:3000"
echo "  - Check Postgresus backups: http://VPS_IP:3002"
echo "  - Run './scripts/verify.sh' for comprehensive tests"
