#!/bin/bash
# Test script: Build Docker image and verify extensions
# Usage: ./test-build.sh [image-tag]

set -e

IMAGE_TAG="${1:-aza-pg:pg18}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "========================================"
echo "PostgreSQL Image Build & Extension Test"
echo "========================================"
echo "Image tag: $IMAGE_TAG"
echo "Project root: $PROJECT_ROOT"
echo

# Build image
echo "📦 Building Docker image..."
cd "$PROJECT_ROOT/docker/postgres"
docker build -t "$IMAGE_TAG" .
echo "✅ Build successful"
echo

# Verify Postgres version
echo "🔍 Verifying PostgreSQL version..."
PG_VERSION=$(docker run --rm "$IMAGE_TAG" psql --version)
echo "$PG_VERSION"
echo

# Verify entrypoint exists
echo "🔍 Checking auto-config entrypoint..."
docker run --rm "$IMAGE_TAG" ls -la /usr/local/bin/docker-auto-config-entrypoint.sh
echo

# Start test container
echo "🚀 Starting test container..."
CONTAINER_NAME="pg-test-$$"
docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password_123 \
  -e POSTGRES_SKIP_AUTOCONFIG=false \
  "$IMAGE_TAG"

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
  if [ "$i" -eq 30 ]; then
    echo "❌ ERROR: PostgreSQL did not start within 60 seconds"
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
for ext in "${EXTENSIONS[@]}"; do
  echo -n "  - $ext: "
  if docker exec "$CONTAINER_NAME" psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS $ext;" >/dev/null 2>&1; then
    echo "✅"
  else
    echo "❌ FAILED"
    exit 1
  fi
done
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
