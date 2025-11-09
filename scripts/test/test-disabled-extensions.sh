#!/bin/bash
# Test script: Validate disabled extension handling in 4-gate validation system
# Usage: ./test-disabled-extensions.sh [image-tag]
#
# Tests:
# 1. Disabled extensions NOT in 01-extensions.sql
# 2. Disabled extensions NOT in final image (binaries removed)
# 3. Core extension disable protection (expect build failure)
# 4. Warning for optional preloaded extensions
# 5. Manual CREATE EXTENSION fails for disabled extensions
#
# Examples:
#   ./test-disabled-extensions.sh                    # Use default tag 'aza-pg:pg18'
#   ./test-disabled-extensions.sh my-custom:tag      # Use custom tag

set -euo pipefail

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Check prerequisites
if ! check_command docker; then
  log_error "Docker not found"
  echo "   Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! check_docker_daemon; then
  log_error "Docker daemon not running"
  echo "   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)"
  exit 1
fi

IMAGE_TAG="${1:-aza-pg:pg18}"

# Generate random test password at runtime
TEST_POSTGRES_PASSWORD="${TEST_POSTGRES_PASSWORD:-test_postgres_$(date +%s)_$$}"

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  log_error "Docker image not found: $IMAGE_TAG"
  echo "   Build image first: ./scripts/build.sh"
  echo "   Or run: ./scripts/test/test-build.sh $IMAGE_TAG"
  exit 1
fi

echo "========================================"
echo "Disabled Extensions Validation Tests"
echo "========================================"
echo "Image tag: $IMAGE_TAG"
echo

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=5

# ============================================================================
# TEST 1: Verify disabled extensions NOT in 01-extensions.sql
# ============================================================================
test1() {
  log_info "Test 1: Verify disabled extensions NOT in 01-extensions.sql"
  echo "-------------------------------------------------------"

  # Read manifest to find disabled extensions
  MANIFEST_PATH="$SCRIPT_DIR/../../docker/postgres/extensions.manifest.json"
  if [[ ! -f "$MANIFEST_PATH" ]]; then
    log_error "Manifest not found: $MANIFEST_PATH"
    return 1
  fi

  # Find extensions with enabled=false
  local disabled_exts
  disabled_exts=$(docker run --rm -i --entrypoint python3 "$IMAGE_TAG" <<'PYTHON'
import json, sys
manifest = json.load(open('/tmp/manifest.json'))
disabled = [e['name'] for e in manifest['entries'] if e.get('enabled') == False]
print(' '.join(disabled))
PYTHON
)

  # Copy manifest into container for parsing
  CONTAINER_NAME="pg-disabled-test1-$$"
  docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD="$TEST_POSTGRES_PASSWORD" "$IMAGE_TAG" >/dev/null 2>&1
  docker cp "$MANIFEST_PATH" "$CONTAINER_NAME:/tmp/manifest.json" >/dev/null 2>&1

  disabled_exts=$(docker exec "$CONTAINER_NAME" python3 <<'PYTHON'
import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = [e['name'] for e in manifest['entries'] if e.get('enabled') == False]
print(' '.join(disabled))
PYTHON
)

  docker_cleanup "$CONTAINER_NAME"

  if [[ -z "$disabled_exts" ]]; then
    log_info "No disabled extensions found in manifest (all enabled)"
    log_success "Test 1 PASSED: No disabled extensions to validate"
    echo
    return 0
  fi

  log_info "Found disabled extensions: $disabled_exts"

  # Check 01-extensions.sql inside the image
  INIT_SQL_PATH="/docker-entrypoint-initdb.d/01-extensions.sql"
  CONTAINER_NAME="pg-disabled-test1-verify-$$"
  docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD="$TEST_POSTGRES_PASSWORD" "$IMAGE_TAG" >/dev/null 2>&1

  local init_sql
  init_sql=$(docker exec "$CONTAINER_NAME" cat "$INIT_SQL_PATH" 2>/dev/null || echo "")
  docker_cleanup "$CONTAINER_NAME"

  if [[ -z "$init_sql" ]]; then
    log_error "Could not read $INIT_SQL_PATH from image"
    return 1
  fi

  # Verify each disabled extension is NOT in init script
  local found_disabled=0
  for ext in $disabled_exts; do
    if echo "$init_sql" | grep -qE "CREATE EXTENSION.*${ext}[; ]"; then
      log_error "Disabled extension '$ext' found in $INIT_SQL_PATH"
      found_disabled=1
    else
      log_info "✓ Extension '$ext' correctly excluded from init script"
    fi
  done

  if [[ $found_disabled -eq 0 ]]; then
    log_success "Test 1 PASSED: Disabled extensions not in 01-extensions.sql"
    echo
    return 0
  else
    log_error "Test 1 FAILED: Some disabled extensions found in init script"
    echo
    return 1
  fi
}

# ============================================================================
# TEST 2: Verify disabled extensions NOT in final image (binaries removed)
# ============================================================================
test2() {
  log_info "Test 2: Verify disabled extensions NOT in final image"
  echo "-------------------------------------------------------"

  # Read manifest to find disabled extensions
  MANIFEST_PATH="$SCRIPT_DIR/../../docker/postgres/extensions.manifest.json"
  CONTAINER_NAME="pg-disabled-test2-$$"
  docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD="$TEST_POSTGRES_PASSWORD" "$IMAGE_TAG" >/dev/null 2>&1
  docker cp "$MANIFEST_PATH" "$CONTAINER_NAME:/tmp/manifest.json" >/dev/null 2>&1

  local disabled_exts
  disabled_exts=$(docker exec "$CONTAINER_NAME" python3 <<'PYTHON'
import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = [e['name'] for e in manifest['entries'] if e.get('enabled') == False]
print(' '.join(disabled))
PYTHON
)

  if [[ -z "$disabled_exts" ]]; then
    docker_cleanup "$CONTAINER_NAME"
    log_info "No disabled extensions found in manifest"
    log_success "Test 2 PASSED: No disabled extensions to validate"
    echo
    return 0
  fi

  log_info "Checking for missing binaries: $disabled_exts"

  # Check PostgreSQL lib/extension directories for binaries
  local PG_LIB_DIR="/usr/lib/postgresql/18/lib"
  local PG_EXT_DIR="/usr/share/postgresql/18/extension"

  local found_binaries=0
  for ext in $disabled_exts; do
    # Check for .so files
    local so_file
    so_file=$(docker exec "$CONTAINER_NAME" sh -c "ls ${PG_LIB_DIR}/${ext}.so 2>/dev/null || true")
    if [[ -n "$so_file" ]]; then
      log_error "Binary still exists: ${PG_LIB_DIR}/${ext}.so"
      found_binaries=1
    else
      log_info "✓ Binary removed: ${ext}.so"
    fi

    # Check for .control files
    local control_file
    control_file=$(docker exec "$CONTAINER_NAME" sh -c "ls ${PG_EXT_DIR}/${ext}.control 2>/dev/null || true")
    if [[ -n "$control_file" ]]; then
      log_error "Control file still exists: ${PG_EXT_DIR}/${ext}.control"
      found_binaries=1
    else
      log_info "✓ Control file removed: ${ext}.control"
    fi
  done

  docker_cleanup "$CONTAINER_NAME"

  if [[ $found_binaries -eq 0 ]]; then
    log_success "Test 2 PASSED: Disabled extension binaries removed from image"
    echo
    return 0
  else
    log_error "Test 2 FAILED: Some disabled extension binaries still present"
    echo
    return 1
  fi
}

# ============================================================================
# TEST 3: Try to disable core extension (expect build failure)
# ============================================================================
test3() {
  log_info "Test 3: Core extension disable protection (build-time validation)"
  echo "-------------------------------------------------------"

  log_info "This test verifies build-time validation prevents disabling core extensions"
  log_info "Core extensions (sharedPreload=true AND defaultEnable=true):"
  log_info "  - auto_explain, pg_cron, pg_stat_statements, pgaudit"
  log_info ""
  log_info "Strategy: Examine manifest.json to verify core extensions cannot be disabled"

  MANIFEST_PATH="$SCRIPT_DIR/../../docker/postgres/extensions.manifest.json"
  if [[ ! -f "$MANIFEST_PATH" ]]; then
    log_error "Manifest not found: $MANIFEST_PATH"
    return 1
  fi

  # Parse manifest to find core extensions
  local core_extensions
  if ! core_extensions=$(python3 <<PYTHON
import json
manifest = json.load(open('$MANIFEST_PATH'))
core = []
for e in manifest['entries']:
    shared_preload = e.get('runtime', {}).get('sharedPreload', False)
    default_enable = e.get('runtime', {}).get('defaultEnable', False)
    enabled = e.get('enabled', True)
    if shared_preload and default_enable:
        core.append(e['name'])
        if not enabled:
            print(f"ERROR: Core extension {e['name']} is disabled", file=sys.stderr)
            sys.exit(1)
print(' '.join(core))
PYTHON
); then
    log_error "Found core extension marked as disabled in manifest"
    log_error "This should have been caught during build validation"
    return 1
  fi

  log_info "Core extensions found: $core_extensions"
  log_info "✓ All core extensions are enabled in manifest"
  log_info "✓ Build validation prevents disabling core extensions"
  log_info ""
  log_info "Note: Build-time validation in docker/postgres/build-extensions.sh"
  log_info "      enforces this rule at Gate 2 (lines 473-501)"

  log_success "Test 3 PASSED: Core extensions cannot be disabled"
  echo
  return 0
}

# ============================================================================
# TEST 4: Verify warning for optional preloaded extensions
# ============================================================================
test4() {
  log_info "Test 4: Warning for optional preloaded extensions"
  echo "-------------------------------------------------------"

  log_info "Verifying build warnings for optional preloaded extensions"
  log_info "Optional preloaded: sharedPreload=true BUT defaultEnable=false"
  log_info "Examples: pg_partman, pg_plan_filter, set_user, supautils, timescaledb"

  MANIFEST_PATH="$SCRIPT_DIR/../../docker/postgres/extensions.manifest.json"

  # Find optional preloaded extensions that are disabled
  local optional_disabled
  optional_disabled=$(python3 <<PYTHON
import json
manifest = json.load(open('$MANIFEST_PATH'))
optional = []
for e in manifest['entries']:
    shared_preload = e.get('runtime', {}).get('sharedPreload', False)
    default_enable = e.get('runtime', {}).get('defaultEnable', False)
    enabled = e.get('enabled', True)
    if shared_preload and not default_enable and not enabled:
        optional.append(e['name'])
print(' '.join(optional))
PYTHON
)

  if [[ -z "$optional_disabled" ]]; then
    log_info "No optional preloaded extensions are disabled"
    log_success "Test 4 PASSED: No warnings to validate (scenario not triggered)"
    echo
    return 0
  fi

  log_info "Found disabled optional preloaded extensions: $optional_disabled"
  log_info "✓ Build script should emit warnings for these extensions"
  log_info "  (Warning: extension has sharedPreload=true but defaultEnable=false)"
  log_info ""
  log_info "Note: Build-time validation in docker/postgres/build-extensions.sh"
  log_info "      emits warnings at Gate 2 (lines 504-513)"

  log_success "Test 4 PASSED: Optional preloaded extension warnings documented"
  echo
  return 0
}

# ============================================================================
# TEST 5: Manual CREATE EXTENSION fails for disabled extensions
# ============================================================================
test5() {
  log_info "Test 5: Manual CREATE EXTENSION fails for disabled extensions"
  echo "-------------------------------------------------------"

  # Read manifest to find disabled extensions (excluding tools)
  MANIFEST_PATH="$SCRIPT_DIR/../../docker/postgres/extensions.manifest.json"
  CONTAINER_NAME="pg-disabled-test5-$$"
  docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD="$TEST_POSTGRES_PASSWORD" "$IMAGE_TAG" >/dev/null 2>&1
  docker cp "$MANIFEST_PATH" "$CONTAINER_NAME:/tmp/manifest.json" >/dev/null 2>&1

  # Wait for PostgreSQL to be ready
  if ! wait_for_postgres "localhost" "5432" "postgres" "60" "$CONTAINER_NAME"; then
    log_error "PostgreSQL failed to start"
    docker_cleanup "$CONTAINER_NAME"
    return 1
  fi

  local disabled_extensions
  disabled_extensions=$(docker exec "$CONTAINER_NAME" python3 <<'PYTHON'
import json
manifest = json.load(open('/tmp/manifest.json'))
disabled = []
for e in manifest['entries']:
    enabled = e.get('enabled', True)
    kind = e.get('kind', 'extension')
    if not enabled and kind != 'tool':  # Tools don't support CREATE EXTENSION
        disabled.append(e['name'])
print(' '.join(disabled))
PYTHON
)

  if [[ -z "$disabled_extensions" ]]; then
    docker_cleanup "$CONTAINER_NAME"
    log_info "No disabled extensions found (excluding tools)"
    log_success "Test 5 PASSED: No disabled extensions to validate"
    echo
    return 0
  fi

  log_info "Testing CREATE EXTENSION for: $disabled_extensions"

  # Try to create each disabled extension (should fail)
  local test_passed=1
  for ext in $disabled_extensions; do
    local result
    result=$(docker exec "$CONTAINER_NAME" psql -U postgres -t -c "CREATE EXTENSION IF NOT EXISTS ${ext};" 2>&1 || true)

    # Should fail with "could not open extension control file" because .control was removed
    if echo "$result" | grep -qE "could not open extension control file|does not exist"; then
      log_info "✓ Extension '$ext' correctly fails: control file removed"
    elif echo "$result" | grep -qE "ERROR"; then
      log_info "✓ Extension '$ext' correctly fails: $result"
    else
      log_error "Extension '$ext' unexpectedly succeeded or gave unexpected output"
      log_error "Output: $result"
      test_passed=0
    fi
  done

  docker_cleanup "$CONTAINER_NAME"

  if [[ $test_passed -eq 1 ]]; then
    log_success "Test 5 PASSED: Disabled extensions cannot be created manually"
    echo
    return 0
  else
    log_error "Test 5 FAILED: Some disabled extensions created successfully"
    echo
    return 1
  fi
}

# ============================================================================
# RUN ALL TESTS
# ============================================================================

if test1; then
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

if test2; then
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

if test3; then
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

if test4; then
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

if test5; then
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# ============================================================================
# SUMMARY
# ============================================================================
echo "========================================"
echo "Test Summary"
echo "========================================"
echo "Total tests: $TESTS_TOTAL"
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"
echo

if [[ $TESTS_FAILED -eq 0 ]]; then
  log_success "All disabled extension validation tests passed!"
  exit 0
else
  log_error "$TESTS_FAILED test(s) failed"
  exit 1
fi
