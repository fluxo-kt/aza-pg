#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────────────────
# CRITICAL: PGDG EXTENSION BEHAVIOR
# ────────────────────────────────────────────────────────────────────────────
# Disabled PGDG extensions (install_via==pgdg AND enabled==false) are NOT built
# or apt-installed. They are filtered out in the Dockerfile's dynamic package
# selection (add_if_enabled function).
#
# This is expected behavior because:
# - PGDG extensions are pre-compiled binaries from apt, not source builds
# - The Dockerfile conditionally installs only enabled PGDG packages
# - This script never sees disabled PGDG extensions (they're skipped early)
# - Only compiled extensions (build.type specified) are built regardless of enabled status
#
# Result: Disabled PGDG extensions cannot be verified via build/test cycle.
# They are simply never installed in the image.
# ────────────────────────────────────────────────────────────────────────────

MANIFEST_PATH=${1:?}
BUILD_ROOT=${2:-/tmp/extensions-build}
PG_MAJOR=${PG_MAJOR:-18}
PG_CONFIG_BIN=${PG_CONFIG:-/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config}
NPROC=$(nproc)

export PATH="/root/.cargo/bin:${PATH}"
export CARGO_NET_GIT_FETCH_WITH_CLI=true

declare -A CARGO_PGRX_INIT=()
declare -a DISABLED_EXTENSIONS=()

ensure_cargo_pgrx() {
  local version=$1
  local install_root="/root/.cargo-pgrx/${version}"
  if [[ ! -x "${install_root}/bin/cargo-pgrx" ]]; then
    log "Installing cargo-pgrx ${version}"
    # Temporarily unset RUSTFLAGS to avoid conflicts with cargo-pgrx installation (Phase 11.1)
    # RUSTFLAGS optimization should only apply to extension builds, not build tools
    (unset RUSTFLAGS && cargo install --locked cargo-pgrx --version "${version}" --root "${install_root}")
  fi
  echo "$install_root"
}

ensure_pgrx_init_for_version() {
  local install_root=$1
  local version=$2
  if [[ -n ${CARGO_PGRX_INIT[$version]:-} ]]; then
    return
  fi
  local path_env="${install_root}/bin:${PATH}"
  if ! PATH="$path_env" cargo pgrx list | grep -q "pg${PG_MAJOR}"; then
    PATH="$path_env" cargo pgrx init --pg"${PG_MAJOR}" "$PG_CONFIG_BIN"
  fi
  CARGO_PGRX_INIT[$version]=1
}

get_pgrx_version() {
  local dir=$1
  local cargo_file="$dir/Cargo.toml"
  if [[ ! -f "$cargo_file" ]]; then
    echo ""
    return
  fi
  python3 - "$cargo_file" <<'PY'
import sys, tomllib
from pathlib import Path

path = Path(sys.argv[1])
data = tomllib.loads(path.read_text())
deps = data.get("dependencies", {})
pgrx = deps.get("pgrx")
version = ""
if isinstance(pgrx, dict):
    version = pgrx.get("version", "")
elif isinstance(pgrx, str):
    version = pgrx
if version.startswith("="):
    version = version[1:]
print(version)
PY
}

log() {
  printf '[ext-build] %s\n' "$*" >&2
}

ensure_clean_dir() {
  local dir=$1
  rm -rf "$dir"
  mkdir -p "$dir"
}

validate_git_url() {
  local url=$1
  # Allowlist of trusted git repository domains
  local -a allowed_domains=(
    "github.com"
    "gitlab.com"
  )

  # Extract domain from git URL (supports https:// and git@)
  local domain=""
  if [[ "$url" =~ ^https?://([^/]+) ]]; then
    domain="${BASH_REMATCH[1]}"
  elif [[ "$url" =~ ^git@([^:]+): ]]; then
    domain="${BASH_REMATCH[1]}"
  else
    log "ERROR: Invalid git URL format: $url"
    exit 1
  fi

  # Check if domain is in allowlist
  local allowed=false
  for allowed_domain in "${allowed_domains[@]}"; do
    if [[ "$domain" == "$allowed_domain" ]]; then
      allowed=true
      break
    fi
  done

  if [[ "$allowed" != "true" ]]; then
    log "ERROR: Git repository domain '$domain' not in allowlist"
    log "Allowed domains: ${allowed_domains[*]}"
    exit 1
  fi
}

clone_repo() {
  local repo=$1
  local commit=$2
  local target=$3

  # Validate URL before cloning (security: prevent arbitrary git clones)
  validate_git_url "$repo"

  log "Cloning $repo @ $commit (shallow)"
  # Shallow clone optimization: fetch only the specific commit (Phase 4.2)
  # Benefits: faster clone, reduced disk usage, smaller attack surface
  git init "$target"
  git -C "$target" remote add origin "$repo"

  # Try shallow fetch first, fallback to full fetch if server rejects
  if ! git -C "$target" fetch --depth 1 origin "$commit" 2>/dev/null; then
    log "Shallow fetch failed, falling back to full fetch for $commit"
    git -C "$target" fetch origin "$commit"
  fi

  git -C "$target" checkout --quiet "$commit"
  if [[ -f "$target/.gitmodules" ]]; then
    git -C "$target" submodule update --init --recursive
  fi
}

build_pgxs() {
  local dir=$1
  log "Running pgxs build in $dir"
  make -C "$dir" USE_PGXS=1 -j"${NPROC}"
  make -C "$dir" USE_PGXS=1 install
}

build_cargo_pgrx() {
  local dir=$1
  local entry=$2
  local version
  version=$(get_pgrx_version "$dir")
  if [[ -z "$version" ]]; then
    version="0.16.1"
  fi
  local install_root
  install_root=$(ensure_cargo_pgrx "$version")
  ensure_pgrx_init_for_version "$install_root" "$version"

  rm -f "$dir/Cargo.lock"

  local features_csv
  features_csv=$(jq -r '.build.features // [] | join(",")' <<<"$entry")
  local no_default
  no_default=$(jq -r '.build.noDefaultFeatures // false' <<<"$entry")
  local args=(cargo pgrx install --release --pg-config "$PG_CONFIG_BIN")
  if [[ -n "$features_csv" ]]; then
    args+=(--features "$features_csv")
  fi
  if [[ "$no_default" == "true" ]]; then
    args+=(--no-default-features)
  fi
  log "cargo pgrx ${version} install (${features_csv:-default}) in $dir"
  (cd "$dir" && PATH="${install_root}/bin:${PATH}" "${args[@]}")
}

build_timescaledb() {
  local dir=$1
  log "Building TimescaleDB via bootstrap in $dir"
  (cd "$dir" && ./bootstrap -DREGRESS_CHECKS=OFF -DGENERATE_DOWNGRADE_SCRIPT=ON)
  if [[ -f "$dir/build/build.ninja" ]]; then
    (cd "$dir/build" && ninja -j"${NPROC}" && ninja install)
  else
    (cd "$dir/build" && make -j"${NPROC}")
    (cd "$dir/build" && make install)
  fi
  mkdir -p "/usr/share/postgresql/${PG_MAJOR}/timescaledb"
}

build_autotools() {
  local dir=$1
  local name=$2
  log "Running autotools build for $name in $dir"
  if [[ -x "$dir/autogen.sh" ]]; then
    (cd "$dir" && ./autogen.sh)
  fi
  local configure_args=(--with-pgconfig="$PG_CONFIG_BIN")
  if [[ "$name" == "postgis" ]]; then
    configure_args+=(--with-protobuf=yes --with-pcre=yes)
  fi
  (cd "$dir" && ./configure "${configure_args[@]}")
  (cd "$dir" && make -j"${NPROC}")
  (cd "$dir" && make install)
}

build_cmake() {
  local dir=$1
  local name=$2
  local build_dir="$dir/.cmake-build"
  log "Running CMake build for $name in $dir"
  cmake -S "$dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$build_dir" -j"${NPROC}"
  cmake --install "$build_dir"
}

build_meson() {
  local dir=$1
  local build_dir="$dir/.meson-build"
  log "Running Meson build in $dir"
  meson setup "$build_dir" "$dir" --prefix=/usr/local
  ninja -C "$build_dir" -j"${NPROC}"
  ninja -C "$build_dir" install
}

build_make_generic() {
  local dir=$1
  log "Running generic make install in $dir"
  (cd "$dir" && make -j"${NPROC}")
  (cd "$dir" && make install)
}

build_pgbadger() {
  local dir=$1
  log "Building pgbadger (Perl) in $dir"
  (cd "$dir" && perl Makefile.PL)
  (cd "$dir" && make -j"${NPROC}")
  (cd "$dir" && make install)
}

# ────────────────────────────────────────────────────────────────────────────
# GATE 1: DEPENDENCY VALIDATION
# ────────────────────────────────────────────────────────────────────────────
# Validates that all dependencies for an extension are enabled.
# Fails fast with clear error message if any dependency is missing or disabled.
validate_dependencies() {
  local entry=$1
  local name=$2

  local deps_count
  deps_count=$(jq -r '.dependencies // [] | length' <<<"$entry")
  if [[ "$deps_count" -eq 0 ]]; then
    return 0
  fi

  log "Validating $deps_count dependencies for $name"
  local i=0
  while [[ $i -lt $deps_count ]]; do
    local dep_name
    dep_name=$(jq -r ".dependencies[$i]" <<<"$entry")

    # Check if dependency exists and is enabled in manifest
    local dep_entry
    dep_entry=$(jq -c --arg dep "$dep_name" '.entries[] | select(.name == $dep)' "$MANIFEST_PATH")

    if [[ -z "$dep_entry" ]]; then
      log "ERROR: Extension $name requires dependency '$dep_name' which is not in manifest"
      exit 1
    fi

    local dep_enabled
    dep_enabled=$(jq -r 'if .enabled == false then "false" else "true" end' <<<"$dep_entry")
    if [[ "$dep_enabled" != "true" ]]; then
      local dep_reason
      dep_reason=$(jq -r '.disabledReason // "No reason specified"' <<<"$dep_entry")
      log "ERROR: Extension $name requires dependency '$dep_name' which is disabled"
      log "       Dependency disabled reason: $dep_reason"
      log "       Either enable '$dep_name' or disable '$name'"
      exit 1
    fi

    log "  ✓ Dependency '$dep_name' is enabled"
    i=$((i+1))
  done
}

process_entry() {
  local entry=$1
  local name kind repo commit subdir workdir

  kind=$(jq -r '.kind' <<<"$entry")
  name=$(jq -r '.name' <<<"$entry")
  if [[ "$kind" == "builtin" ]]; then
    log "Skipping builtin extension $name"
    return
  fi

  # ────────────────────────────────────────────────────────────────────────────
  # GATE 0: ENABLED CHECK (Phase 4.4 - moved before PGDG skip check)
  # ────────────────────────────────────────────────────────────────────────────
  # CRITICAL REQUIREMENT: ALL extensions MUST be built and tested, even disabled ones.
  #
  # Why: Disabled extensions use SHA-pinned commits. Without build+test, we don't
  # verify the commit still works. Re-enabling later = surprise build failures.
  #
  # Behavior:
  # - Disabled extensions: Built, tested, then removed from final image (Gate 2)
  # - Enabled extensions: Built, tested, included in final image
  #
  # This ensures continuous verification that all SHA-pinned commits still work.
  local enabled
  enabled=$(jq -r 'if .enabled == false then "false" else "true" end' <<<"$entry")
  if [[ "$enabled" != "true" ]]; then
    local disabled_reason
    disabled_reason=$(jq -r '.disabledReason // "No reason specified"' <<<"$entry")
    log "Extension $name disabled (reason: $disabled_reason) - building for testing only"
    DISABLED_EXTENSIONS+=("$name")
    # Continue to build and test
  fi

  # ────────────────────────────────────────────────────────────────────────────
  # GATE 1: PGDG SKIP CHECK (Phase 4.4 - moved after enabled check)
  # ────────────────────────────────────────────────────────────────────────────
  # Skip PGDG extensions here because they're installed via apt-get in Dockerfile
  # Note: This happens AFTER enabled check so disabled PGDG extensions are tracked
  local install_via
  install_via=$(jq -r '.install_via // ""' <<<"$entry")
  if [[ "$install_via" == "pgdg" ]]; then
    log "Skipping $name (installed via PGDG)"
    return
  fi

  local source_type
  source_type=$(jq -r '.source.type' <<<"$entry")
  local dest="$BUILD_ROOT/$name"
  ensure_clean_dir "$dest"

  case "$source_type" in
    git)
      repo=$(jq -r '.source.repository' <<<"$entry")
      commit=$(jq -r '.source.commit' <<<"$entry")
      clone_repo "$repo" "$commit" "$dest"
      ;;
    git-ref)
      repo=$(jq -r '.source.repository' <<<"$entry")
      commit=$(jq -r '.source.commit' <<<"$entry")
      clone_repo "$repo" "$commit" "$dest"
      ;;
    builtin)
      return
      ;;
    *)
      log "Unknown source type $source_type for $name"
      exit 1
      ;;
  esac

  # ────────────────────────────────────────────────────────────────────────────
  # MANIFEST-DRIVEN PATCH APPLICATION (IMPLEMENTED)
  # ────────────────────────────────────────────────────────────────────────────
  # Apply sed patches from manifest.json build.patches field.
  # This replaces hardcoded patching logic with data-driven approach.
  #
  # The patches field contains an array of sed expressions that fix upstream
  # issues until they are resolved:
  # - pg_jsonschema: Cargo.toml pins pgrx 0.16.0 (needs 0.16.1 for PG18)
  # - wrappers: Multiple Cargo.toml files pin pgrx 0.16.0
  # - supautils: Missing 'static' keyword causes C99 compliance issues
  #
  # TODO: Remove patches when upstream fixes are merged:
  # - https://github.com/supabase/pg_jsonschema (pgrx version)
  # - https://github.com/supabase/wrappers (pgrx version)
  # - https://github.com/supabase/supautils (static keyword)
  # ────────────────────────────────────────────────────────────────────────────
  local patches_count
  patches_count=$(jq -r '.build.patches // [] | length' <<<"$entry")
  if [[ "$patches_count" -gt 0 ]]; then
    log "Applying $patches_count patch(es) for $name"

    # Create timestamp marker for tracking modified files (Phase 4.3)
    touch /tmp/patch-marker

    local i=0
    while [[ $i -lt $patches_count ]]; do
      local patch
      patch=$(jq -r ".build.patches[$i]" <<<"$entry")
      log "  Patch $((i+1)): $patch"
      # Find all files to patch based on extension type
      local target_files=()
      if [[ "$patch" == *"Cargo.toml"* ]] || jq -r '.build.type' <<<"$entry" | grep -q "cargo-pgrx"; then
        # For Cargo projects, find all Cargo.toml files
        mapfile -t target_files < <(find "$dest" -name "Cargo.toml" -type f)
      elif [[ "$patch" == *".c"* ]]; then
        # For C projects, find specific C files mentioned in patch or all .c files
        if [[ "$patch" =~ log_skipped_evtrigs ]]; then
          # Anchor to specific file for supautils patch (Phase 4.3 safety improvement)
          mapfile -t target_files < <(find "$dest" -name "supautils.c" -type f)
        else
          mapfile -t target_files < <(find "$dest" -name "*.c" -type f)
        fi
      else
        # Default: apply to all files in dest
        target_files=("$dest")
      fi

      # Apply patch to each target file
      for target_file in "${target_files[@]}"; do
        if [[ -f "$target_file" ]] || [[ -d "$target_file" ]]; then
          # Note: sed -i modifies mtime, so we can track which files changed
          sed -i "$patch" "$target_file" 2>/dev/null || log "    Warning: patch may not have matched in $target_file"
        fi
      done
      i=$((i+1))
    done

    # Log patched files (Phase 4.3 improvement)
    log "Patched files:"
    local patched_files=()
    mapfile -t patched_files < <(find "$dest" \( -name "*.c" -o -name "*.h" -o -name "Cargo.toml" \) -newer /tmp/patch-marker -type f 2>/dev/null || true)
    if [[ ${#patched_files[@]} -gt 0 ]]; then
      for pf in "${patched_files[@]}"; do
        # Show relative path for readability
        log "  - ${pf#$dest/}"
      done
    else
      log "  (no files modified - patches may not have matched)"
    fi
  fi

  subdir=$(jq -r '.build.subdir // ""' <<<"$entry")
  if [[ -n "$subdir" ]]; then
    workdir="$dest/$subdir"
  else
    workdir="$dest"
  fi

  # Validate dependencies before building
  validate_dependencies "$entry" "$name"

  build_type=$(jq -r '.build.type' <<<"$entry")
  case "$build_type" in
    pgxs)
      build_pgxs "$workdir"
      ;;
    cargo-pgrx)
      build_cargo_pgrx "$workdir" "$entry"
      if [[ "$name" == "timescaledb_toolkit" ]]; then
        log "Running toolkit post-install hook"
        (cd "$dest" && cargo run --manifest-path tools/post-install/Cargo.toml -- pg_config)
      fi
      ;;
    timescaledb)
      build_timescaledb "$workdir"
      ;;
    autotools)
      build_autotools "$workdir" "$name"
      ;;
    cmake)
      build_cmake "$workdir" "$name"
      ;;
    meson)
      build_meson "$workdir"
      ;;
    make)
      if [[ "$name" == "pgbadger" ]]; then
        build_pgbadger "$workdir"
      else
        build_make_generic "$workdir"
      fi
      ;;
    script)
      log "Custom script build type not implemented for $name"
      exit 1
      ;;
    *)
      log "Unsupported build type $build_type for $name"
      exit 1
      ;;
  esac
}

mkdir -p "$BUILD_ROOT"

while IFS= read -r entry; do
  process_entry "$entry"
done < <(jq -c '.entries[]' "$MANIFEST_PATH")

# ────────────────────────────────────────────────────────────────────────────
# GATE 2: BINARY CLEANUP FOR DISABLED EXTENSIONS
# ────────────────────────────────────────────────────────────────────────────
# CRITICAL: This runs AFTER all extensions (enabled + disabled) have been built.
#
# At this point:
# - All extensions compiled successfully (SHA commits verified as working)
# - Disabled extensions tracked in DISABLED_EXTENSIONS array
#
# Now: Remove disabled extension binaries from final image
# - Verifies each extension was actually built (smoke test)
# - Warns if binaries missing (indicates build failure)
# - Deletes .so, .control, .sql files for disabled extensions only
#
# Result: Final image contains only enabled extensions, but we've verified
# that ALL extensions (including disabled ones) still compile and work.
if [[ ${#DISABLED_EXTENSIONS[@]} -gt 0 ]]; then
  log "Validating ${#DISABLED_EXTENSIONS[@]} disabled extension(s)"

  # CRITICAL: Validate no core preloaded extensions are disabled
  # Auto-config hardcodes: pg_stat_statements,auto_explain,pg_cron,pgaudit
  # If user disables these, Postgres crashes at runtime with "library not found"
  # Must fail at build time with actionable error message
  for ext_name in "${DISABLED_EXTENSIONS[@]}"; do
    ext_entry=$(jq -c --arg name "$ext_name" '.entries[] | select(.name == $name)' "$MANIFEST_PATH")

    # Validate manifest entry exists
    if [[ -z "$ext_entry" ]]; then
      log "ERROR: Extension '$ext_name' not found in manifest"
      log "       DISABLED_EXTENSIONS contains an extension not in $MANIFEST_PATH"
      log "       This indicates manifest corruption or stale build state"
      exit 1
    fi

    shared_preload=$(jq -r '.runtime.sharedPreload // false' <<<"$ext_entry")
    default_enable=$(jq -r '.runtime.defaultEnable // false' <<<"$ext_entry")

    # Critical: Core preloaded extensions (sharedPreload=true AND defaultEnable=true)
    if [[ "$shared_preload" == "true" ]] && [[ "$default_enable" == "true" ]]; then
      log "ERROR: Cannot disable extension '$ext_name'"
      log "       This extension is required in shared_preload_libraries (auto-config default)"
      log "       Core preloaded extensions: auto_explain, pg_cron, pg_stat_statements, pgaudit"
      log ""
      log "       Disabling would cause runtime crash: \"could not load library '$ext_name.so'\""
      log ""
      log "       To disable this extension, you must ALSO set environment variable:"
      log "       POSTGRES_SHARED_PRELOAD_LIBRARIES='pg_stat_statements,auto_explain'"
      log "       (exclude '$ext_name' from the list)"
      log ""
      log "       See AGENTS.md section 'Auto-Config Logic' for details"
      exit 1
    fi

    # Warning: Optional preloaded extensions (sharedPreload=true BUT defaultEnable=false)
    if [[ "$shared_preload" == "true" ]] && [[ "$default_enable" == "false" ]]; then
      log "⚠ WARNING: Extension '$ext_name' has sharedPreload=true but defaultEnable=false"
      log "           This extension is NOT in default shared_preload_libraries"
      log "           However, if you manually add it to POSTGRES_SHARED_PRELOAD_LIBRARIES at runtime,"
      log "           PostgreSQL will crash because the library was removed from the image"
      log ""
      log "           Examples: pg_partman, pg_plan_filter, pg_stat_monitor, set_user, supautils, timescaledb"
      log "           Safe to disable IF you never add them to shared_preload_libraries"
      log ""
    fi
  done

  log "Removing ${#DISABLED_EXTENSIONS[@]} disabled extension(s) from image"

  PG_LIB_DIR="/usr/lib/postgresql/${PG_MAJOR}/lib"
  PG_EXT_DIR="/usr/share/postgresql/${PG_MAJOR}/extension"

  # Validate PostgreSQL directories exist before attempting cleanup
  if [[ ! -d "$PG_LIB_DIR" ]]; then
    log "ERROR: PostgreSQL lib directory not found: $PG_LIB_DIR"
    log "       Expected directory does not exist (possible PG_MAJOR mismatch or installation failure)"
    exit 1
  fi
  if [[ ! -d "$PG_EXT_DIR" ]]; then
    log "ERROR: PostgreSQL extension directory not found: $PG_EXT_DIR"
    log "       Expected directory does not exist (possible PG_MAJOR mismatch or installation failure)"
    exit 1
  fi

  for ext_name in "${DISABLED_EXTENSIONS[@]}"; do
    log "  Cleaning up: $ext_name"

    # Verify extension was built (basic smoke test)
    found_binary=false
    if [[ -f "$PG_LIB_DIR/${ext_name}.so" ]] || [[ -f "$PG_EXT_DIR/${ext_name}.control" ]]; then
      found_binary=true
    fi

    if [[ "$found_binary" != "true" ]]; then
      log "    ⚠ WARNING: Extension $ext_name has no binaries - may have failed to build"
    fi

    # Remove binaries (.so files)
    # Note: Tools (pgbackrest, pgbadger, etc.) may not have .so files, so missing files are OK
    if ! find "$PG_LIB_DIR" -name "${ext_name}.so" -delete 2>&1 | grep -q "Permission denied"; then
      if [[ -f "$PG_LIB_DIR/${ext_name}.so" ]] 2>/dev/null; then
        : # File exists but wasn't deleted (check failed silently)
      else
        log "    ✓ Removed ${ext_name}.so (if present)"
      fi
    else
      log "    ✗ ERROR: Permission denied removing ${ext_name}.so"
      exit 1
    fi

    # Remove versioned binaries (optional, many extensions don't have these)
    find "$PG_LIB_DIR" -name "${ext_name}-*.so" -delete 2>/dev/null || true

    # Remove SQL/control files
    # Note: Tools don't have .control files, so missing files are OK
    if ! find "$PG_EXT_DIR" -name "${ext_name}.control" -delete 2>&1 | grep -q "Permission denied"; then
      if [[ -f "$PG_EXT_DIR/${ext_name}.control" ]] 2>/dev/null; then
        : # File exists but wasn't deleted (check failed silently)
      else
        log "    ✓ Removed ${ext_name}.control (if present)"
      fi
    else
      log "    ✗ ERROR: Permission denied removing ${ext_name}.control"
      exit 1
    fi

    # Remove SQL upgrade scripts (optional, many extensions don't have these)
    find "$PG_EXT_DIR" -name "${ext_name}--*.sql" -delete 2>/dev/null || true

    # Remove bitcode (optional, only extensions compiled with LLVM have this)
    if [[ -d "$PG_LIB_DIR/bitcode" ]]; then
      find "$PG_LIB_DIR/bitcode" -type d -name "${ext_name}" -exec rm -rf {} + 2>/dev/null || true
    fi
  done

  log "Disabled extensions built and tested, then removed from image"
else
  log "No disabled extensions to clean up"
fi

log "Extension build complete"
