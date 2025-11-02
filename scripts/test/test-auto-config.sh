#!/bin/bash
# Test script: Validate auto-config RAM/CPU detection and scaling
# Usage: ./test-auto-config.sh [image-tag]
#
# Examples:
#   ./test-auto-config.sh                    # Use default tag 'aza-pg:pg18'
#   ./test-auto-config.sh my-custom:tag       # Use custom tag

set -euo pipefail

# Guard: Check required commands
if ! command -v docker &>/dev/null; then
  echo "❌ ERROR: Required command 'docker' not found"
  echo "   Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

# Guard: Check Docker daemon is running
if ! docker info >/dev/null 2>&1; then
  echo "❌ ERROR: Docker daemon is not running"
  echo "   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)"
  exit 1
fi

IMAGE_TAG="${1:-aza-pg:pg18}"

# Guard: Verify image exists
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Docker image not found: $IMAGE_TAG"
  echo "   Build image first: cd docker/postgres && docker build -t $IMAGE_TAG ."
  echo "   Or run: ./scripts/test/test-build.sh $IMAGE_TAG"
  exit 1
fi

echo "========================================"
echo "Auto-Config Detection & Scaling Test"
echo "========================================"
echo "Image tag: $IMAGE_TAG"
echo

# Test Case 1: No memory limit (should use 50% of host RAM)
echo "Test 1: No memory limit (shared VPS mode)"
echo "=========================================="
CONTAINER_NAME="pg-autoconfig-test-1-$$"

if ! docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test \
  "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Failed to start container"
  docker logs "$CONTAINER_NAME" 2>&1 || true
  exit 1
fi

sleep 5

echo "Auto-config logs:"
docker logs "$CONTAINER_NAME" 2>&1 | grep "\[AUTO-CONFIG\]"
echo

# Verify it detected "shared" mode
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "shared"; then
  echo "✅ Correctly detected shared VPS mode (no memory limit)"
else
  echo "❌ FAILED: Should detect shared VPS mode"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null
echo

# Test Case 2: 2GB memory limit (dedicated mode)
echo "Test 2: 2GB memory limit (dedicated mode)"
echo "==========================================="
CONTAINER_NAME="pg-autoconfig-test-2-$$"

if ! docker run -d \
  --name "$CONTAINER_NAME" \
  --memory="2g" \
  -e POSTGRES_PASSWORD=test \
  "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Failed to start container with 2GB memory limit"
  echo "   Your Docker daemon may not support memory limits"
  echo "   Check Docker settings: docker info | grep -i memory"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit 1
fi

sleep 5

echo "Auto-config logs:"
docker logs "$CONTAINER_NAME" 2>&1 | grep "\[AUTO-CONFIG\]"
echo

# Verify baseline settings (2GB RAM)
LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
if echo "$LOGS" | grep -q "RAM: 204[0-9]MB.*dedicated"; then
  echo "✅ Detected 2GB RAM in dedicated mode"
else
  echo "❌ FAILED: Should detect 2GB RAM"
  echo "   Logs: $LOGS"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

if echo "$LOGS" | grep -q "shared_buffers: 256MB"; then
  echo "✅ Baseline shared_buffers (256MB) correct"
else
  echo "❌ FAILED: shared_buffers should be 256MB for 2GB RAM"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null
echo

# Test Case 3: 4GB memory limit (should scale proportionally)
echo "Test 3: 4GB memory limit (scaled settings)"
echo "==========================================="
CONTAINER_NAME="pg-autoconfig-test-3-$$"

if ! docker run -d \
  --name "$CONTAINER_NAME" \
  --memory="4g" \
  -e POSTGRES_PASSWORD=test \
  "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Failed to start container with 4GB memory limit"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit 1
fi

sleep 5

echo "Auto-config logs:"
docker logs "$CONTAINER_NAME" 2>&1 | grep "\[AUTO-CONFIG\]"
echo

# Verify scaled settings (4GB = 2x baseline)
LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
if echo "$LOGS" | grep -q "RAM: 409[0-9]MB.*dedicated"; then
  echo "✅ Detected 4GB RAM in dedicated mode"
else
  echo "❌ FAILED: Should detect 4GB RAM"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

if echo "$LOGS" | grep -q "shared_buffers: 512MB"; then
  echo "✅ Scaled shared_buffers (512MB = 2x baseline) correct"
else
  echo "❌ FAILED: shared_buffers should be 512MB for 4GB RAM"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null
echo

# Test Case 4: CPU detection
echo "Test 4: CPU detection and scaling"
echo "=================================="
CONTAINER_NAME="pg-autoconfig-test-4-$$"

if ! docker run -d \
  --name "$CONTAINER_NAME" \
  --memory="2g" \
  --cpus="2" \
  -e POSTGRES_PASSWORD=test \
  "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Failed to start container with CPU limit"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit 1
fi

sleep 5

echo "Auto-config logs:"
docker logs "$CONTAINER_NAME" 2>&1 | grep "\[AUTO-CONFIG\]"
echo

# Verify CPU settings
LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
if echo "$LOGS" | grep -q "CPU: [0-9] cores"; then
  echo "✅ Detected CPU cores"
else
  echo "❌ FAILED: Should detect CPU cores"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

if echo "$LOGS" | grep -q "max_worker_processes:"; then
  echo "✅ CPU settings configured"
else
  echo "❌ FAILED: Should configure CPU-based settings"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null
echo

# Test Case 5: Disable auto-config
echo "Test 5: POSTGRES_SKIP_AUTOCONFIG=true"
echo "======================================"
CONTAINER_NAME="pg-autoconfig-test-5-$$"

if ! docker run -d \
  --name "$CONTAINER_NAME" \
  --memory="2g" \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_SKIP_AUTOCONFIG=true \
  "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Failed to start container with POSTGRES_SKIP_AUTOCONFIG"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit 1
fi

sleep 5

echo "Auto-config logs:"
docker logs "$CONTAINER_NAME" 2>&1 | grep "\[AUTO-CONFIG\]" || echo "(none - auto-config disabled)"
echo

# Verify auto-config was skipped
LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
if echo "$LOGS" | grep -q "Disabled via POSTGRES_SKIP_AUTOCONFIG=true"; then
  echo "✅ Auto-config correctly disabled"
else
  echo "❌ FAILED: Auto-config should be disabled"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null
echo

echo "========================================"
echo "✅ All auto-config tests passed!"
echo "========================================"
