#!/usr/bin/env bash
#
# ============================================================================
# DEPRECATED: This script has been superseded by scripts/build.ts
# ============================================================================
#
# This bash script is kept temporarily for backwards compatibility but will
# be removed in a future release. Following the Bun-First philosophy, all
# scripts have been migrated to TypeScript.
#
# MIGRATION:
#   Old (deprecated):    ./scripts/build.sh
#   New (recommended):   bun run build
#
# For more information, see: scripts/build.ts or run 'bun run build --help'
#
# ============================================================================
#
# Build PostgreSQL image (canonical build script)
# Uses Docker Buildx with intelligent caching for fast builds
#
# Usage:
#   ./scripts/build.sh                 # Single-platform (current arch)
#   ./scripts/build.sh --multi-arch    # Multi-platform (amd64 + arm64)
#   ./scripts/build.sh --push          # Build and push to registry
#
# Requirements:
#   - Docker Buildx installed (bundled with Docker Desktop / Docker 19.03+)
#   - Network access to ghcr.io for cache pull
#   - ghcr.io write access for --push (requires docker login ghcr.io)
#
# Performance:
#   - First build: ~12min (compiles all extensions)
#   - Cached build: ~2min (reuses CI artifacts)
#   - No network: ~12min (falls back to local cache)
#
set -euo pipefail

# Show deprecation warning
echo "⚠️  WARNING: scripts/build.sh is deprecated."
echo "⚠️  Please use 'bun run build' instead."
echo "⚠️  See scripts/build.ts for the TypeScript implementation."
echo ""

# Configuration
BUILDER_NAME="aza-pg-builder"
IMAGE_NAME="${POSTGRES_IMAGE:-ghcr.io/fluxo-kt/aza-pg}"
IMAGE_TAG="${POSTGRES_TAG:-pg18}"
CACHE_REGISTRY="ghcr.io/fluxo-kt/aza-pg"
CACHE_TAG="buildcache"

# Parse arguments
MULTI_ARCH=false
PUSH=false
LOAD=true

for arg in "$@"; do
  case $arg in
    --multi-arch)
      MULTI_ARCH=true
      LOAD=false  # Multi-arch builds cannot load, must push
      ;;
    --push)
      PUSH=true
      LOAD=false
      ;;
    --help)
      grep "^#" "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Run with --help for usage"
      exit 1
      ;;
  esac
done

# Preflight: Validate manifest
echo "Validating extensions manifest..."
if ! bun run "$(dirname "$0")/extensions/validate-manifest.ts"; then
  echo "ERROR: Manifest validation failed"
  exit 1
fi
echo ""

# Validate push requirements
if [[ "$PUSH" == "true" || "$MULTI_ARCH" == "true" ]]; then
  if ! docker info | grep -q "Username:"; then
    echo "ERROR: Not logged into container registry"
    echo "Run: docker login ghcr.io"
    exit 1
  fi
fi

# Set up buildx builder if not exists
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  echo "Creating buildx builder: $BUILDER_NAME"
  docker buildx create \
    --name "$BUILDER_NAME" \
    --driver docker-container \
    --driver-opt network=host \
    --use
else
  echo "Using existing buildx builder: $BUILDER_NAME"
  docker buildx use "$BUILDER_NAME"
fi

# Determine platforms
if [[ "$MULTI_ARCH" == "true" ]]; then
  PLATFORMS="linux/amd64,linux/arm64"
  echo "Building multi-platform: $PLATFORMS"
else
  # Single platform (current architecture)
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)
      PLATFORMS="linux/amd64"
      ;;
    aarch64|arm64)
      PLATFORMS="linux/arm64"
      ;;
    *)
      echo "ERROR: Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac
  echo "Building single-platform: $PLATFORMS"
fi

# Build arguments
BUILD_ARGS=()
BUILD_ARGS+=(--builder "$BUILDER_NAME")
BUILD_ARGS+=(--platform "$PLATFORMS")
BUILD_ARGS+=(--file docker/postgres/Dockerfile)
BUILD_ARGS+=(--tag "$IMAGE_NAME:$IMAGE_TAG")

# Cache configuration (remote + local fallback)
BUILD_ARGS+=(--cache-from "type=registry,ref=$CACHE_REGISTRY:$CACHE_TAG")
BUILD_ARGS+=(--cache-from "type=local,src=/tmp/.buildx-cache")
BUILD_ARGS+=(--cache-to "type=local,dest=/tmp/.buildx-cache,mode=max")

# Load or push
if [[ "$PUSH" == "true" ]]; then
  BUILD_ARGS+=(--push)
  BUILD_ARGS+=(--cache-to "type=registry,ref=$CACHE_REGISTRY:$CACHE_TAG,mode=max")
  echo "Will push to registry: $IMAGE_NAME:$IMAGE_TAG"
elif [[ "$LOAD" == "true" ]]; then
  BUILD_ARGS+=(--load)
  echo "Will load to local Docker daemon"
else
  # Multi-arch without push (dry-run)
  echo "Multi-arch build (will not load to local daemon)"
fi

# Build metadata
BUILD_ARGS+=(--provenance false)  # Disable for local builds (CI enables)
BUILD_ARGS+=(--sbom false)        # Disable for local builds (CI enables)

# Current context
BUILD_ARGS+=(.)

# Print command for transparency
echo ""
echo "Running buildx command:"
echo "docker buildx build \\"
for arg in "${BUILD_ARGS[@]}"; do
  echo "  $arg \\"
done
echo ""

# Execute build
START_TIME=$(date +%s)
docker buildx build "${BUILD_ARGS[@]}"
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Summary
echo ""
echo "================================================================"
echo "BUILD COMPLETE"
echo "================================================================"
echo "Duration: ${DURATION}s"
echo "Image: $IMAGE_NAME:$IMAGE_TAG"
echo "Platforms: $PLATFORMS"
if [[ "$PUSH" == "true" ]]; then
  echo "Status: Pushed to registry"
elif [[ "$LOAD" == "true" ]]; then
  echo "Status: Loaded to local Docker daemon"
else
  echo "Status: Built (not loaded to daemon)"
fi
echo ""
echo "Test the image:"
echo "  docker run --rm $IMAGE_NAME:$IMAGE_TAG psql --version"
echo ""
echo "Deploy with compose:"
echo "  cd stacks/primary"
echo "  POSTGRES_IMAGE=$IMAGE_NAME:$IMAGE_TAG docker compose up -d"
echo "================================================================"
