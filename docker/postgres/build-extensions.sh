#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH=${1:?}
BUILD_ROOT=${2:-/tmp/extensions-build}
PG_MAJOR=${PG_MAJOR:-18}
PG_CONFIG_BIN=${PG_CONFIG:-/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config}
NPROC=$(nproc)

export PATH="/root/.cargo/bin:${PATH}"
export CARGO_NET_GIT_FETCH_WITH_CLI=true

log() {
  printf '[ext-build] %s\n' "$*" >&2
}

ensure_clean_dir() {
  local dir=$1
  rm -rf "$dir"
  mkdir -p "$dir"
}

clone_repo() {
  local repo=$1
  local commit=$2
  local target=$3
  log "Cloning $repo @ $commit"
  git clone --filter=blob:none "$repo" "$target"
  git -C "$target" checkout --quiet "$commit"
}

ensure_pgrx_init() {
  if [[ -z ${PGRX_INITIALIZED:-} ]]; then
    if ! cargo pgrx list | grep -q "pg${PG_MAJOR}"; then
      cargo pgrx init --pg"${PG_MAJOR}" "$PG_CONFIG_BIN"
    fi
    PGRX_INITIALIZED=1
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
  ensure_pgrx_init
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
  log "cargo pgrx install (${features_csv:-default}) in $dir"
  (cd "$dir" && "${args[@]}")
}

build_timescaledb() {
  local dir=$1
  log "Building TimescaleDB via bootstrap in $dir"
  (cd "$dir" && ./bootstrap -DREGRESS_CHECKS=OFF -DGENERATE_DOWNGRADE_SCRIPT=ON)
  (cd "$dir/build" && ninja -j"${NPROC}" && ninja install)
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
