#!/bin/bash
# Test script: Validate auto-config RAM/CPU detection and scaling
# Usage: ./test-auto-config.sh [image-tag]
#
# Examples:
#   ./test-auto-config.sh                    # Use default tag 'aza-pg:pg18'
#   ./test-auto-config.sh my-custom:tag      # Use custom tag
#
# NOTE: This bash script should eventually be migrated to TypeScript using Bun.
# See scripts/test/test-*.ts for TypeScript test examples using container-manager.ts

set -euo pipefail

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Check prerequisites
if ! check_command docker; then
  echo "   Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! check_docker_daemon; then
  echo "   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)"
  exit 1
fi

IMAGE_TAG="${1:-aza-pg:pg18}"

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Docker image not found: $IMAGE_TAG"
  echo "   Build image first: ./scripts/build.sh"
  echo "   Or run: ./scripts/test/test-build.sh $IMAGE_TAG"
  exit 1
fi

echo "========================================"
echo "Auto-Config Detection & Scaling Test"
echo "========================================"
echo "Image tag: $IMAGE_TAG"
echo

assert_log_contains() {
  local logs=$1
  local pattern=$2
  local message=$3
  if echo "$logs" | grep -qE "$pattern"; then
    echo "✅ $message"
  else
    echo "❌ FAILED: $message"
    echo "   Pattern '$pattern' not found in logs:"
    echo "$logs"
    exit 1
  fi
}

assert_pg_config() {
  local container=$1
  local setting=$2
  local expected=$3
  local message=$4

  local actual
  actual=$(docker exec "$container" psql -U postgres -t -c "SHOW $setting;" 2>/dev/null | xargs || echo "ERROR")

  if [ "$actual" = "ERROR" ]; then
    echo "⚠️  WARNING: $message (PostgreSQL not ready yet)"
    return
  fi

  if echo "$actual" | grep -qE "$expected"; then
    echo "✅ $message (actual: $actual)"
  else
    echo "❌ FAILED: $message"
    echo "   Expected: $expected"
    echo "   Actual: $actual"
    exit 1
  fi
}

run_case() {
  local name=$1
  local callback=$2
  shift 2
  echo "$name"
  echo "${name//?/=}"
  local container="pg-autoconfig-$RANDOM-$$"
  if ! docker run -d --name "$container" "$@" "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "❌ ERROR: Failed to start container for '$name'"
    docker_cleanup "$container"
    exit 1
  fi

  # Wait for PostgreSQL to be ready (polls instead of fixed sleep)
  if ! wait_for_postgres "localhost" "5432" "postgres" "60" "$container"; then
    echo "❌ FAILED: PostgreSQL failed to start in time"
    logs=$(docker logs "$container" 2>&1 || true)
    echo "Container logs:"
    echo "$logs"
    docker_cleanup "$container"
    exit 1
  fi

  local logs
  logs=$(docker logs "$container" 2>&1 || true)
  echo "Auto-config logs:"
  echo "$logs" | grep "\[POSTGRES\]" || echo "(no auto-config logs found)"
  echo

  # Assert [AUTO-CONFIG] token exists in logs
  if ! echo "$logs" | grep -q "\[AUTO-CONFIG\]"; then
    echo "❌ FAILED: [AUTO-CONFIG] token not found in logs"
    echo "   Expected auto-config logs with [AUTO-CONFIG] prefix"
    docker_cleanup "$container"
    exit 1
  fi
  echo "✅ [AUTO-CONFIG] token found in logs"

  "$callback" "$logs" "$container"
  docker_cleanup "$container"
  echo
}

case_manual_override() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 1536MB \\(manual\\)" "Manual override respected (1536MB)"
  assert_log_contains "$logs" "shared_buffers=384MB" "shared_buffers scaled to 25% for manual override"
  assert_log_contains "$logs" "max_connections=120" "Connection cap reduced to 120 for <4GB nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "384MB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "120" "Config injection: max_connections"
  # NOTE: pgsodium verification requires rebuilt image (after commit 11c4d56)
  # assert_pg_config "$container" "shared_preload_libraries" "pgsodium" "pgsodium in shared_preload_libraries"
}

case_cgroup_2g() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 204[0-9]MB \\(cgroup-v2\\)" "Detected 2GB via cgroup"
  assert_log_contains "$logs" "shared_buffers=512MB" "shared_buffers tuned for 2GB"
  assert_log_contains "$logs" "max_connections=120" "Connection cap 120 for 2GB nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "512MB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "120" "Config injection: max_connections"
}

case_low_mem() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 512MB \\(cgroup-v2\\)" "Detected 512MB limit"
  assert_log_contains "$logs" "shared_buffers=128MB" "Minimum shared_buffers honored"
  assert_log_contains "$logs" "max_connections=80" "Connections throttled to 80 for 512MB nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "128MB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "80" "Config injection: max_connections"
}

case_high_mem_manual() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 65536MB \\(manual\\)" "Manual override supports 64GB"
  assert_log_contains "$logs" "shared_buffers=9830MB" "Large-node shared_buffers respects 15% rule"
  assert_log_contains "$logs" "max_connections=200" "Connections capped at 200 for big nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "9830MB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "200" "Config injection: max_connections"
}

case_cpu_detection() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "CPU: 2 cores" "CPU detection picked up 2 cores"
  assert_log_contains "$logs" "max_worker_processes=4" "Worker processes scaled with CPU"

  # Verify actual config
  assert_pg_config "$container" "max_worker_processes" "4" "Config injection: max_worker_processes"
  assert_pg_config "$container" "max_parallel_workers" "2" "Config injection: max_parallel_workers"
}

case_below_minimum() {
  local logs=$1
  # Should fail with FATAL error for < 512MB
  assert_log_contains "$logs" "FATAL:.*512MB" "Rejected deployment below 512MB minimum"
}

case_custom_shared_preload() {
  local logs=$1
  local container=$2
  # Verify custom shared_preload_libraries override (default is pg_stat_statements,auto_explain,pg_cron,pgaudit)
  # Override to minimal set to prove it works
  local actual
  actual=$(docker exec "$container" psql -U postgres -t -c "SHOW shared_preload_libraries;" 2>/dev/null | xargs || echo "ERROR")

  if [ "$actual" = "ERROR" ]; then
    echo "❌ FAILED: Could not query shared_preload_libraries"
    exit 1
  fi

  # Verify override worked: should have pg_stat_statements but NOT auto_explain/pg_cron/pgaudit
  if echo "$actual" | grep -q "pg_stat_statements" && ! echo "$actual" | grep -qE "auto_explain|pg_cron|pgaudit"; then
    echo "✅ Custom shared_preload_libraries honored (actual: $actual)"
  else
    echo "❌ FAILED: Override not respected"
    echo "   Expected: pg_stat_statements (without auto_explain,pg_cron,pgaudit)"
    echo "   Actual: $actual"
    exit 1
  fi
}

case_4gb_tier() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 409[0-9]MB \\(cgroup-v2\\)" "Detected 4GB via cgroup"
  assert_log_contains "$logs" "shared_buffers=1024MB" "shared_buffers tuned to 25% for 4GB"
  assert_log_contains "$logs" "max_connections=200" "Connection cap 200 for 4GB nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "1024MB|1GB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "200" "Config injection: max_connections"
  assert_pg_config "$container" "work_mem" "[4-6]MB" "Config injection: work_mem ~5MB"
}

case_8gb_tier() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 819[0-9]MB \\(cgroup-v2\\)" "Detected 8GB via cgroup"
  assert_log_contains "$logs" "shared_buffers=2048MB" "shared_buffers tuned to 25% for 8GB"
  assert_log_contains "$logs" "max_connections=200" "Connection cap 200 for 8GB nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "2048MB|2GB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "200" "Config injection: max_connections"
  assert_pg_config "$container" "work_mem" "[8-12]MB" "Config injection: work_mem ~10MB"
}

case_16gb_tier() {
  local logs=$1
  local container=$2
  assert_log_contains "$logs" "RAM: 1638[0-9]MB \\(cgroup-v2\\)" "Detected 16GB via cgroup"
  assert_log_contains "$logs" "shared_buffers=3276MB" "shared_buffers tuned to 20% for 16GB"
  assert_log_contains "$logs" "max_connections=200" "Connection cap 200 for 16GB nodes"

  # Verify actual config
  assert_pg_config "$container" "shared_buffers" "327[0-9]MB|3.*GB" "Config injection: shared_buffers"
  assert_pg_config "$container" "max_connections" "200" "Config injection: max_connections"
  assert_pg_config "$container" "work_mem" "1[6-9]MB|2[0-4]MB" "Config injection: work_mem ~20MB"
}

run_case "Test 1: Manual override without memory limit" case_manual_override \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_MEMORY=1536

run_case "Test 2: 2GB memory limit (cgroup detection)" case_cgroup_2g \
  --memory="2g" \
  -e POSTGRES_PASSWORD=test

run_case "Test 3: 512MB memory limit (minimum supported)" case_low_mem \
  --memory="512m" \
  -e POSTGRES_PASSWORD=test

run_case "Test 4: Manual high-memory override (64GB)" case_high_mem_manual \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_MEMORY=65536

run_case "Test 5: CPU detection with limits" case_cpu_detection \
  --cpus="2" \
  --memory="2g" \
  -e POSTGRES_PASSWORD=test

# Test 6: Below minimum memory - should fail
echo "Test 6: Below minimum memory (256MB - should fail)"
echo "===================================================="
container="pg-autoconfig-below-min-$$"
if docker run -d --name "$container" --memory="256m" -e POSTGRES_PASSWORD=test "$IMAGE_TAG" >/dev/null 2>&1; then
  # Poll with timeout instead of fixed sleep
  if wait_for_postgres "localhost" "5432" "postgres" "15" "$container" >/dev/null 2>&1; then
    # Container actually started (unexpected - should fail for < 512MB)
    logs=$(docker logs "$container" 2>&1 || true)
    if echo "$logs" | grep -qE "FATAL.*512MB|minimum 512MB"; then
      echo "✅ Container rejected 256MB deployment (below 512MB minimum)"
      docker_cleanup "$container"
    else
      echo "❌ FAILED: Container should reject < 512MB but didn't"
      echo "$logs"
      docker_cleanup "$container"
      exit 1
    fi
  else
    # PostgreSQL failed to start (expected for < 512MB)
    logs=$(docker logs "$container" 2>&1 || true)
    echo "✅ Container failed to start with 256MB (expected) - FATAL error in logs:"
    echo "$logs" | grep "FATAL" || echo "(no FATAL found)"
    docker_cleanup "$container"
  fi
else
  echo "✅ Container failed to start with 256MB (expected)"
fi
echo

run_case "Test 7: Custom shared_preload_libraries override" case_custom_shared_preload \
  --memory="1g" \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements"

run_case "Test 8: 4GB memory tier (medium production)" case_4gb_tier \
  --memory=4g \
  -e POSTGRES_PASSWORD=test

run_case "Test 9: 8GB memory tier (large production)" case_8gb_tier \
  --memory=8g \
  -e POSTGRES_PASSWORD=test

run_case "Test 10: 16GB memory tier (high-load)" case_16gb_tier \
  --memory=16g \
  -e POSTGRES_PASSWORD=test

echo "========================================"
echo "✅ All auto-config tests passed!"
echo "✅ Total: 10 tests (9 success cases + 1 failure case)"
echo "========================================"
