#!/bin/bash
# Test script: Build Docker image and verify extensions
# Usage: ./test-build.sh [image-tag]
#
# Examples:
#   ./test-build.sh                    # Use default tag 'aza-pg:pg18'
#   ./test-build.sh my-custom:tag       # Use custom tag

set -euo pipefail

# Guard: Check required commands
for cmd in docker; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ ERROR: Required command '$cmd' not found"
    echo "   Install Docker: https://docs.docker.com/get-docker/"
    exit 1
  fi
done

# Guard: Check Docker daemon is running
if ! docker info >/dev/null 2>&1; then
  echo "❌ ERROR: Docker daemon is not running"
  echo "   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)"
  exit 1
fi

IMAGE_TAG="${1:-aza-pg:pg18}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Guard: Verify Dockerfile exists
DOCKERFILE_PATH="$PROJECT_ROOT/docker/postgres/Dockerfile"
if [[ ! -f "$DOCKERFILE_PATH" ]]; then
  echo "❌ ERROR: Dockerfile not found at: $DOCKERFILE_PATH"
  echo "   Check project structure: ls -la $PROJECT_ROOT/docker/postgres/"
  exit 1
fi

echo "========================================"
echo "PostgreSQL Image Build & Extension Test"
echo "========================================"
echo "Image tag: $IMAGE_TAG"
echo "Project root: $PROJECT_ROOT"
echo

# Build image
echo "📦 Building Docker image..."
cd "$PROJECT_ROOT/docker/postgres"
if ! docker build -t "$IMAGE_TAG" . 2>&1; then
  echo
  echo "❌ ERROR: Docker build failed"
  echo "   Check Dockerfile syntax and build context"
  echo "   Retry with verbose output: docker build --progress=plain -t $IMAGE_TAG ."
  exit 1
fi
echo "✅ Build successful"
echo

# Verify Postgres version
echo "🔍 Verifying PostgreSQL version..."
if ! PG_VERSION=$(docker run --rm "$IMAGE_TAG" psql --version 2>&1); then
  echo "❌ ERROR: Failed to verify PostgreSQL version"
  echo "   Image may be corrupted: docker images $IMAGE_TAG"
  exit 1
fi
echo "$PG_VERSION"
echo

# Verify entrypoint exists
echo "🔍 Checking auto-config entrypoint..."
if ! docker run --rm "$IMAGE_TAG" ls -la /usr/local/bin/docker-auto-config-entrypoint.sh 2>&1; then
  echo "❌ ERROR: Auto-config entrypoint not found in image"
  echo "   Check Dockerfile COPY instructions"
  exit 1
fi
echo

# Start test container
echo "🚀 Starting test container..."
CONTAINER_NAME="pg-test-$$"
if ! docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password_123 \
  -e POSTGRES_SKIP_AUTOCONFIG=false \
  "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "❌ ERROR: Failed to start test container"
  echo "   Check Docker logs: docker logs $CONTAINER_NAME"
  exit 1
fi

# Cleanup function
cleanup() {
  echo
  echo "🧹 Cleaning up..."
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to start..."
for i in {1..30}; do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    echo "✅ PostgreSQL is ready"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "❌ ERROR: PostgreSQL did not start within 60 seconds"
    echo
    echo "Container logs:"
    docker logs "$CONTAINER_NAME"
    exit 1
  fi
  sleep 2
done
echo

# Check auto-config logs
echo "📋 Auto-config detection logs:"
docker logs "$CONTAINER_NAME" 2>&1 | grep "\[AUTO-CONFIG\]" || echo "No auto-config logs found"
echo

# Test extension loading
echo "🧪 Testing extensions..."
EXTENSIONS=("vector" "pg_trgm" "pg_cron" "pgaudit" "pg_stat_statements" "uuid-ossp" "btree_gin" "btree_gist")

echo "Creating extensions..."
FAILED_EXTENSIONS=()
for ext in "${EXTENSIONS[@]}"; do
  echo -n "  - $ext: "
  if docker exec "$CONTAINER_NAME" psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS $ext;" >/dev/null 2>&1; then
    echo "✅"
  else
    echo "❌ FAILED"
    FAILED_EXTENSIONS+=("$ext")
  fi
done

if [[ ${#FAILED_EXTENSIONS[@]} -gt 0 ]]; then
  echo
  echo "❌ ERROR: Failed to create extensions: ${FAILED_EXTENSIONS[*]}"
  echo "   Check container logs for compilation errors:"
  echo "   docker logs $CONTAINER_NAME | grep -i error"
  exit 1
fi
echo

# Verify extensions functional
echo "🔬 Verifying extension functionality..."

# pgvector
echo -n "  - pgvector (vector type): "
if docker exec "$CONTAINER_NAME" psql -U postgres -c "SELECT '[1,2,3]'::vector;" >/dev/null 2>&1; then
  echo "✅"
else
  echo "❌ FAILED"
  exit 1
fi

# pg_trgm
echo -n "  - pg_trgm (similarity): "
if docker exec "$CONTAINER_NAME" psql -U postgres -c "SELECT similarity('test', 'test');" >/dev/null 2>&1; then
  echo "✅"
else
  echo "❌ FAILED"
  exit 1
fi

# pg_stat_statements
echo -n "  - pg_stat_statements (view): "
if docker exec "$CONTAINER_NAME" psql -U postgres -c "SELECT COUNT(*) FROM pg_stat_statements;" >/dev/null 2>&1; then
  echo "✅"
else
  echo "❌ FAILED"
  exit 1
fi

# pg_cron
echo -n "  - pg_cron (cron.job table): "
if docker exec "$CONTAINER_NAME" psql -U postgres -c "SELECT COUNT(*) FROM cron.job;" >/dev/null 2>&1; then
  echo "✅"
else
  echo "❌ FAILED"
  exit 1
fi

echo

# List all installed extensions
echo "📦 Installed extensions:"
docker exec "$CONTAINER_NAME" psql -U postgres -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;" | grep -v "row"
echo

echo "========================================"
echo "✅ All tests passed!"
echo "Image: $IMAGE_TAG"
echo "========================================"
