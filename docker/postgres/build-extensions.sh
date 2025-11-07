#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH=${1:?}
BUILD_ROOT=${2:-/tmp/extensions-build}
PG_MAJOR=${PG_MAJOR:-18}
PG_CONFIG_BIN=${PG_CONFIG:-/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config}
NPROC=$(nproc)

export PATH="/root/.cargo/bin:${PATH}"
export CARGO_NET_GIT_FETCH_WITH_CLI=true

declare -A CARGO_PGRX_INIT=()

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

  log "Cloning $repo @ $commit"
  git clone --filter=blob:none "$repo" "$target"
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

process_entry() {
  local entry=$1
  local name kind repo commit subdir workdir

  kind=$(jq -r '.kind' <<<"$entry")
  name=$(jq -r '.name' <<<"$entry")
  if [[ "$kind" == "builtin" ]]; then
    log "Skipping builtin extension $name"
    return
  fi

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
          sed -i "$patch" "$target_file" 2>/dev/null || log "    Warning: patch may not have matched in $target_file"
        fi
      done
      i=$((i+1))
    done
  fi

  subdir=$(jq -r '.build.subdir // ""' <<<"$entry")
  if [[ -n "$subdir" ]]; then
    workdir="$dest/$subdir"
  else
    workdir="$dest"
  fi

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
