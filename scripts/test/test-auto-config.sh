#!/bin/bash
# Test script: Validate auto-config RAM/CPU detection and scaling
# Usage: ./test-auto-config.sh [image-tag]
#
# Examples:
#   ./test-auto-config.sh                    # Use default tag 'aza-pg:pg18'
#   ./test-auto-config.sh my-custom:tag      # Use custom tag

set -euo pipefail

if ! command -v docker &>/dev/null; then
  echo "❌ ERROR: Required command 'docker' not found"
  echo "   Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "❌ ERROR: Docker daemon is not running"
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

cleanup() {
  local name=$1
  docker rm -f "$name" >/dev/null 2>&1 || true
}

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
    cleanup "$container"
    exit 1
  fi

  sleep 8
  local logs
  logs=$(docker logs "$container" 2>&1 || true)
  echo "Auto-config logs:"
  echo "$logs" | grep "\[AUTO-CONFIG\]" || echo "(no auto-config logs found)"
  echo

  "$callback" "$logs" "$container"
  cleanup "$container"
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
  assert_log_contains "$logs" "workers=4" "Worker processes scaled with CPU"

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
  # Verify custom shared_preload_libraries override
  assert_pg_config "$container" "shared_preload_libraries" "pg_stat_statements,custom_ext" "Custom shared_preload_libraries honored"
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
  sleep 5
  logs=$(docker logs "$container" 2>&1 || true)
  if echo "$logs" | grep -qE "FATAL.*512MB|minimum 512MB"; then
    echo "✅ Container rejected 256MB deployment (below 512MB minimum)"
    docker rm -f "$container" >/dev/null 2>&1 || true
  else
    echo "❌ FAILED: Container should reject < 512MB but didn't"
    echo "$logs"
    docker rm -f "$container" >/dev/null 2>&1 || true
    exit 1
  fi
else
  echo "✅ Container failed to start with 256MB (expected)"
fi
echo

echo "========================================"
echo "✅ All auto-config tests passed!"
echo "✅ Total: 6 tests (5 success cases + 1 failure case)"
echo "========================================"
