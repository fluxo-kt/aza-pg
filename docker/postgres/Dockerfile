# AUTO-GENERATED FILE - DO NOT EDIT
# Generator: scripts/docker/generate-dockerfile.ts
# Template: docker/postgres/Dockerfile.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

# PostgreSQL 18.6 with comprehensive extension suite

FROM postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722 AS builder-base

# Use bash with pipefail for RUN commands (Debian's /bin/sh is dash, which doesn't support it)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive

# Disable apt cache auto-deletion (required for cache mount effectiveness)
RUN set -euo pipefail && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

# Copy build package list first (stable, needed for apt-get)
COPY docker/postgres/extensions.build-packages.txt /tmp/extensions.build-packages.txt

# Install build dependencies
# Note: This is the first of 4 apt-get calls in the Dockerfile. Each stage has its own
# dependencies optimized for multi-stage build efficiency. DO NOT consolidate across stages.
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      git \
      curl \
      ca-certificates \
      rsync \
      postgresql-server-dev-18 \
      $(tr '\n' ' ' < /tmp/extensions.build-packages.txt) && \
    apt-get clean && \
    rm -f /tmp/extensions.build-packages.txt

# Install Rust toolchain (separate layer for better caching, ~60s install time)
# Stable tool, rarely updates - placed BEFORE manifests to maximize cache hits
RUN set -euo pipefail && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# Add Rust/Cargo to PATH
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Bun for running TypeScript build scripts (separate layer)
# Extracts version from project .tool-versions file (single source of truth)
# Placed BEFORE manifests to maximize cache hits (~30s install)
COPY .tool-versions /tmp/.tool-versions
RUN set -euo pipefail && \
    BUN_VERSION=$(grep "^bun " /tmp/.tool-versions | awk '{print $2}') && \
    echo "Installing Bun v${BUN_VERSION}" && \
    curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm /tmp/.tool-versions

# Build su-exec: C-based privilege-drop binary, replaces gosu in final stage.
# gosu carries Go stdlib CVEs (CVE-2025-68121 CRITICAL + multiple HIGH) with no upstream fix.
# su-exec is functionally identical (same CLI: user[:group] command) but pure C — no Go stdlib.
# git/gcc/make/strip are already present from the build-essential install above.
# SHA pin: v0.2 commit = f85e5bde1afef399021fbc2a99c837cf851ceafa
# (478be7e2 is the annotated tag object; HEAD resolves to the peeled commit)
RUN set -euo pipefail && \
    rm -rf /tmp/su-exec-build && \
    for attempt in 1 2 3 4 5; do \
        git -c http.version=HTTP/1.1 clone --depth 1 --branch v0.2 https://github.com/ncopa/su-exec.git /tmp/su-exec-build && break; \
        rm -rf /tmp/su-exec-build; \
        [ "$attempt" != "5" ] || exit 1; \
        sleep 2; \
    done && \
    [ "$(git -C /tmp/su-exec-build rev-parse HEAD)" = "f85e5bde1afef399021fbc2a99c837cf851ceafa" ] && \
    make -C /tmp/su-exec-build && \
    strip /tmp/su-exec-build/su-exec && \
    chmod 755 /tmp/su-exec-build/su-exec

# Copy build script and manifests AFTER expensive tool installations
# Manifests change frequently (~20% of builds), tools rarely change
# This ordering maximizes cache hits for Rust/Bun layers when manifests update
COPY docker/postgres/build-extensions.ts /usr/local/bin/build-extensions.ts
COPY docker/postgres/patches/ /opt/patches/
COPY docker/postgres/extensions.pgxs.manifest.json /tmp/extensions.pgxs.manifest.json
COPY docker/postgres/extensions.cargo.manifest.json /tmp/extensions.cargo.manifest.json

# Make build script executable (after COPY to ensure file exists)
RUN set -euo pipefail && chmod +x /usr/local/bin/build-extensions.ts

# Stage for PGXS/autotools/cmake/meson/make/timescaledb builds
FROM builder-base AS builder-pgxs

# Use bash for RUN commands (inherited stages must re-declare SHELL)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Copy full manifest for cross-stage dependency validation
COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json

RUN --mount=type=cache,target=/root/.cache,sharing=locked \
    bun /usr/local/bin/build-extensions.ts /tmp/extensions.pgxs.manifest.json /tmp/extensions-build

RUN set -euo pipefail && \
    mkdir -p /opt/ext-out/usr/lib/postgresql/18/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/extension && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/contrib && \
    mkdir -p /opt/ext-out/usr/local/bin && \
    mkdir -p /opt/ext-out/usr/local/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/timescaledb && \
    rsync -a /usr/lib/postgresql/18/lib/ /opt/ext-out/usr/lib/postgresql/18/lib/ && \
    rsync -a /usr/share/postgresql/18/extension/ /opt/ext-out/usr/share/postgresql/18/extension/ && \
    rsync -a /usr/share/postgresql/18/contrib/ /opt/ext-out/usr/share/postgresql/18/contrib/ && \
    rsync -a --exclude='gosu' /usr/local/bin/ /opt/ext-out/usr/local/bin/ && \
    rsync -a /usr/local/lib/ /opt/ext-out/usr/local/lib/ && \
    if [ -d /usr/share/postgresql/18/timescaledb ]; then \
      rsync -a /usr/share/postgresql/18/timescaledb/ /opt/ext-out/usr/share/postgresql/18/timescaledb/; \
    fi && \
    find /opt/ext-out/usr/lib/postgresql/18/lib -name '*.so' -print0 | xargs -0 -P$(nproc) strip --strip-debug && \
    { find /opt/ext-out/usr/local/lib -name '*.so' -print0 | xargs -0 -P$(nproc) strip --strip-debug 2>/dev/null || true; } && \
    rm -rf /opt/ext-out/usr/lib/postgresql/18/lib/bitcode && \
    find /opt/ext-out \( -name '*.a' -o -name '*.la' \) -delete

# Stage for cargo-pgrx builds
FROM builder-base AS builder-cargo

# Use bash for RUN commands (inherited stages must re-declare SHELL)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Copy full manifest for cross-stage dependency validation
COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json

# Each crate builds with its own [profile.release] (upstream picks opt-level 3 + fat LTO for runtime speed);
# only symbols are stripped. A global opt-level=s/thin-LTO override existed to shrink timescaledb_toolkit,
# which now comes from the Timescale apt repo, so it would only slow the extensions still built here.
RUN --mount=type=cache,target=/root/.cache,sharing=locked \
    --mount=type=cache,target=/root/.cargo/registry,sharing=locked \
    --mount=type=cache,target=/root/.cargo/git,sharing=locked \
    CARGO_PROFILE_RELEASE_STRIP=symbols \
    bun /usr/local/bin/build-extensions.ts /tmp/extensions.cargo.manifest.json /tmp/extensions-build

RUN set -euo pipefail && \
    mkdir -p /opt/ext-out/usr/lib/postgresql/18/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/extension && \
    rsync -a /usr/lib/postgresql/18/lib/ /opt/ext-out/usr/lib/postgresql/18/lib/ && \
    rsync -a /usr/share/postgresql/18/extension/ /opt/ext-out/usr/share/postgresql/18/extension/ && \
    find /opt/ext-out/usr/lib/postgresql/18/lib -name '*.so' -print0 | xargs -0 -P$(nproc) strip --strip-debug && \
    rm -rf /opt/ext-out/usr/lib/postgresql/18/lib/bitcode && \
    find /opt/ext-out \( -name '*.a' -o -name '*.la' \) -delete

# Stage for version info generation using standalone TypeScript script
# This ensures consistency between local testing and Docker builds
FROM builder-base AS builder-version-info

# Use bash for RUN commands (inherited stages must re-declare SHELL)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Copy the standalone version info generation script and manifest (script needs to read manifest)
COPY scripts/generate-version-info.ts /tmp/generate-version-info.ts
COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json

# Generate version-info files with hardcoded PostgreSQL version
RUN set -euo pipefail && \
    echo "Generating version info for PostgreSQL 18.6..." && \
    bun /tmp/generate-version-info.ts txt --pg-version="18.6" > /tmp/version-info.txt && \
    bun /tmp/generate-version-info.ts json --pg-version="18.6" > /tmp/version-info.json && \
    echo "Version info files generated successfully"

# Final runtime stage
FROM postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722

# Use bash with pipefail for RUN commands (Debian's /bin/sh is dash, which doesn't support it)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Build metadata ARGs (required, no defaults - must be passed by CI/CD)
# Declared ONLY in final stage to prevent builder stage cache invalidation
ARG BUILD_DATE
ARG VCS_REF

ENV DEBIAN_FRONTEND=noninteractive

# Install runtime libraries for compiled extensions (final stage)
COPY docker/postgres/extensions.runtime-packages.txt /tmp/extensions.runtime-packages.txt

# Install runtime libraries for compiled extensions (final stage)
# Note: This is the fourth apt-get call, optimized for minimal runtime dependencies.
# Separate apt-get calls across stages (builder-base, builder-pgxs, builder-cargo, final)
# are intentional for multi-stage build optimization. DO NOT consolidate.
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    RUNTIME_PKGS="$(tr '\n' ' ' < /tmp/extensions.runtime-packages.txt)" && \
    apt-get install -y --no-install-recommends \
      # postgresql-client provides psql CLI tool (base postgres image only has server)
      # Required for: healthcheck (psql -tAc 'SELECT 1'), pg_dump/pg_restore in scripts
      postgresql-client-18 \
      ${RUNTIME_PKGS} && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /tmp/extensions.runtime-packages.txt

# Pre-compiled extensions from PGDG repository (versions hardcoded at generation time)
# Phase 4.3: Dynamic PGDG package filtering based on manifest enabled flag
# This RUN command reads extensions.manifest.json and only installs enabled PGDG extensions
COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json

RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update && \
    # Install enabled PGDG packages (pre-calculated in TS)
    echo "Installing PGDG packages: postgresql-18-hll=2.21-1.pgdg13+2 postgresql-18-http=1.7.2-2.pgdg13+2 postgresql-18-hypopg=1.4.3-1.pgdg13+2 postgresql-18-cron=1.6.8-1.pgdg13+2 postgresql-18-partman=5.5.0-1.pgdg13+1 postgresql-18-repack=1.5.3-1.pgdg13+2 postgresql-18-pgaudit=18.0-3.pgdg13+1 postgresql-18-plpgsql-check=2.10.11-1.pgdg13+1 postgresql-18-rum=1.3.15-1.pgdg13+1 postgresql-18-set-user=4.2.0-1.pgdg13+2" && \
    apt-get install -y --no-install-recommends postgresql-18-hll=2.21-1.pgdg13+2 postgresql-18-http=1.7.2-2.pgdg13+2 postgresql-18-hypopg=1.4.3-1.pgdg13+2 postgresql-18-cron=1.6.8-1.pgdg13+2 postgresql-18-partman=5.5.0-1.pgdg13+1 postgresql-18-repack=1.5.3-1.pgdg13+2 postgresql-18-pgaudit=18.0-3.pgdg13+1 postgresql-18-plpgsql-check=2.10.11-1.pgdg13+1 postgresql-18-rum=1.3.15-1.pgdg13+1 postgresql-18-set-user=4.2.0-1.pgdg13+2 && \
    # Each entry's module file must exist (prevents silent installation failures)
    test -f /usr/lib/postgresql/18/lib/hll.so && \
    test -f /usr/lib/postgresql/18/lib/http.so && \
    test -f /usr/lib/postgresql/18/lib/hypopg.so && \
    test -f /usr/lib/postgresql/18/lib/pg_cron.so && \
    test -f /usr/lib/postgresql/18/lib/pg_partman_bgw.so && \
    test -f /usr/lib/postgresql/18/lib/pg_repack.so && \
    test -f /usr/lib/postgresql/18/lib/pgaudit.so && \
    test -f /usr/lib/postgresql/18/lib/plpgsql_check.so && \
    test -f /usr/lib/postgresql/18/lib/rum.so && \
    test -f /usr/lib/postgresql/18/lib/set_user.so && \
    echo "All 10 PGDG module files verified" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /tmp/extensions.manifest.json && \
    { find /usr/lib/postgresql/18/lib -name "*.so" -type f -exec strip --strip-unneeded {} \; 2>/dev/null || true; }

# Pre-compiled extensions from Percona repository (versions hardcoded at generation time)
# Provides pg_stat_monitor and wal2json from the already-required Percona repo layer
# Percona repository setup and package installation
# Provides: pg_stat_monitor and wal2json from Percona ppg-18
# Note: Percona packages are pinned via perconaVersion in manifest for reproducible builds
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    echo "Setting up Percona repository for ppg-18..." && \
    apt-get update && \
    apt-get install -y --no-install-recommends curl gnupg2 gpgv lsb-release && \
    curl -fsSL https://repo.percona.com/apt/percona-release_latest.generic_all.deb -o /tmp/percona-release.deb && \
    dpkg -i /tmp/percona-release.deb && \
    percona-release enable ppg-18 release && \
    apt-get update && \
    echo "Installing Percona packages: percona-pg-stat-monitor18=1:2.4.0-1.trixie percona-postgresql-18-wal2json=1:2.6-5.trixie" && \
    apt-get install -y --no-install-recommends percona-pg-stat-monitor18=1:2.4.0-1.trixie percona-postgresql-18-wal2json=1:2.6-5.trixie && \
    echo "Installed 2 Percona package(s)" && \
    # Verify .so files exist
    echo "Verifying Percona .so files exist..." && \
    test -f /usr/lib/postgresql/18/lib/pg_stat_monitor.so && \
    test -f /usr/lib/postgresql/18/lib/wal2json.so && \
    echo "All 2 Percona module files verified" && \
    # Cleanup Percona release package
    rm -f /tmp/percona-release.deb && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    { find /usr/lib/postgresql/18/lib -name "*.so" -type f -exec strip --strip-unneeded {} \; 2>/dev/null || true; }

# Pre-compiled extensions from Timescale repository (versions hardcoded at generation time)
# Provides TimescaleDB with full TSL license (not available in PGDG)
# Timescale repository setup and package installation
# Provides: TimescaleDB with full TSL license (not available in PGDG)
# Note: Timescale packages are pinned via timescaleVersion in manifest for reproducible builds
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    echo "Setting up Timescale repository for PostgreSQL 18..." && \
    apt-get update && \
    apt-get install -y --no-install-recommends curl gnupg2 lsb-release && \
    curl -fsSL https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh | bash && \
    apt-get update && \
    echo "Installing Timescale packages: timescaledb-2-postgresql-18=2.30.2~debian13-1806 timescaledb-2-loader-postgresql-18=2.30.2~debian13-1806 timescaledb-toolkit-postgresql-18=1:1.26.0~debian13" && \
    apt-get install -y --no-install-recommends timescaledb-2-postgresql-18=2.30.2~debian13-1806 timescaledb-2-loader-postgresql-18=2.30.2~debian13-1806 timescaledb-toolkit-postgresql-18=1:1.26.0~debian13 && \
    echo "Installed 3 Timescale package(s)" && \
    # Verify .so files exist
    echo "Verifying Timescale .so files exist..." && \
    test -f /usr/lib/postgresql/18/lib/timescaledb.so && \
    test -f /usr/lib/postgresql/18/lib/timescaledb_toolkit-1.26.0.so && \
    echo "All 2 Timescale module files verified" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    { find /usr/lib/postgresql/18/lib -name "*.so" -type f -exec strip --strip-unneeded {} \; 2>/dev/null || true; }

# Pre-compiled tools from PGDG repository (standalone binaries, not PostgreSQL-version-specific)
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    apt-get update && \
    echo "Installing PGDG tools: pgbackrest=2.59.2-1.pgdg13+1 pgbadger=13.2-1.pgdg13+1" && \
    apt-get install -y --no-install-recommends pgbackrest=2.59.2-1.pgdg13+1 pgbadger=13.2-1.pgdg13+1 && \
    # Verify tool binaries exist and are executable
    test -x /usr/bin/pgbackrest && \
    test -x /usr/bin/pgbadger && \
    echo "All 2 PGDG tool(s) verified" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder-pgxs /opt/ext-out/ /
COPY --from=builder-cargo /opt/ext-out/ /

# Remove LLVM bitcode from base PostgreSQL image (34MB of debug artifacts not needed at runtime)
# Moved here (right after builder COPYs) to clean up before remaining operations.
# ldconfig registers libraries built from source into /usr/local/lib (SOURCE_LIBRARIES in
# manifest-data.ts): the dynamic loader finds that directory only through its cache.
RUN set -euo pipefail && rm -rf /usr/lib/postgresql/18/lib/bitcode && ldconfig

# Replace gosu (Go binary CVE surface) with su-exec (pure C, no Go stdlib).
# APPROACH: Self-contained final-stage compilation so the replacement layer cannot be bypassed
# by stale cross-stage COPY cache entries.
# Prior approaches failed (listed oldest→latest):
#   1. COPY --from=builder-base: stale GHA cached layer
#   2. RUN --mount=type=bind,from=builder-base: source unverifiable vs GHA-cached stage
#   3. apt-get install su-exec: package absent from postgres image's stripped apt repos
#   4. COPY via builder-pgxs output dir: COPY cache key in GHA matched stale entry predating replacement
#   5. apt-get purge gosu: no-op for the pinned postgres base image because gosu is a direct
#      binary download in the base image, not a dpkg-owned file.
# Fix: compile and install su-exec directly in the final stage, then verify the binary size
# is far below gosu's multi-MB size. Also exclude gosu from builder-pgxs rsync to avoid
# creating an unnecessary intermediate layer with the Go binary.
# SHA pin: su-exec v0.2 commit = f85e5bde1afef399021fbc2a99c837cf851ceafa
# hadolint ignore=DL3008
RUN set -euo pipefail && \
    apt-get update && \
    apt-get install -y --no-install-recommends build-essential git ca-certificates && \
    rm -rf /tmp/su-exec-build && \
    for attempt in 1 2 3 4 5; do \
        git -c http.version=HTTP/1.1 clone --depth 1 --branch v0.2 https://github.com/ncopa/su-exec.git /tmp/su-exec-build && break; \
        rm -rf /tmp/su-exec-build; \
        [ "$attempt" != "5" ] || exit 1; \
        sleep 2; \
    done && \
    [ "$(git -C /tmp/su-exec-build rev-parse HEAD)" = "f85e5bde1afef399021fbc2a99c837cf851ceafa" ] && \
    make -C /tmp/su-exec-build && \
    strip /tmp/su-exec-build/su-exec && \
    apt-get purge -y gosu && \
    install -o root -g root -m 0755 /tmp/su-exec-build/su-exec /usr/local/bin/gosu && \
    SZ=$(stat -c%s /usr/local/bin/gosu) && \
    echo "su-exec: ${SZ} bytes at /usr/local/bin/gosu (su-exec ~14KB, gosu ~7MB)" && \
    [ "${SZ}" -lt 500000 ] || { echo "FATAL: su-exec replacement failed — binary is >500KB"; exit 1; } && \
    apt-get purge -y --auto-remove build-essential git && \
    rm -rf /tmp/su-exec-build && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Remove package-manager helpers needed only while installing repositories and release assets.
# Debian 13 apt verifies repositories through sqv, so apt remains usable without the GnuPG CLI stack.
RUN set -euo pipefail && \
    apt-get purge -y --auto-remove \
      curl \
      dirmngr \
      gnupg \
      gnupg-l10n \
      gnupg2 \
      gpg \
      gpg-agent \
      gpgconf \
      gpgsm \
      gpgv \
      lsb-release \
      percona-release && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create stub pgsodium_getkey script (required when pgsodium is preloaded)
# pgsodium requires this script to exist when loaded via shared_preload_libraries.
# This stub script returns a test key in hex format (64 hex characters = 32 bytes).
# Production deployments using Transparent Column Encryption (TCE) should replace this
# with a proper key management script that fetches the server secret securely from vault/KMS.
# See: https://github.com/michelp/pgsodium/tree/main/getkey_scripts for examples
RUN set -euo pipefail && \
    echo '#!/bin/sh' > /usr/share/postgresql/18/extension/pgsodium_getkey && \
    echo '# Stub pgsodium_getkey script - returns test key in hex format (DO NOT use in production!)' >> /usr/share/postgresql/18/extension/pgsodium_getkey && \
    echo '# Key format: 64 hex characters (32 bytes). Generate: select encode(randombytes_buf(32), '\'hex\'')' >> /usr/share/postgresql/18/extension/pgsodium_getkey && \
    echo '# For production TCE, replace with secure key fetch from vault/KMS (output must be hex)' >> /usr/share/postgresql/18/extension/pgsodium_getkey && \
    echo 'echo "4670bdf714d653c15779e67e0bb6012f1e229c86edbdf75285f3c592670cece2"' >> /usr/share/postgresql/18/extension/pgsodium_getkey && \
    chmod +x /usr/share/postgresql/18/extension/pgsodium_getkey

# Create backup directory with proper ownership
RUN set -euo pipefail && mkdir -p /backup && chown postgres:postgres /backup

# OPT#6: Copy configs by stability (base config rarely changes, scripts occasionally change)
# Base PostgreSQL config (most stable - rarely modified)
COPY docker/postgres/configs/postgresql-base.conf /etc/postgresql/

# Healthcheck script (stable - rarely modified)
COPY docker/postgres/healthcheck.sh /usr/local/bin/healthcheck.sh

# Image contents documentation (generated from manifest)
COPY docker/postgres/IMAGE-CONTENTS.txt /IMAGE-CONTENTS.txt

# Auto-config entrypoint (moderate - occasionally updated for new features)
COPY docker/postgres/docker-auto-config-entrypoint.sh /usr/local/bin/docker-auto-config-entrypoint.sh

# Runtime init scripts
COPY docker/postgres/docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/

# pgflow SQL-only schema (installed via 05-pgflow-init.sh during initdb)
RUN set -euo pipefail && mkdir -p /opt/pgflow
COPY tests/fixtures/pgflow/schema.sql /opt/pgflow/schema.sql
COPY docker/postgres/pgflow/security-patches.sql /opt/pgflow/security-patches.sql
# Upgrade path for databases created by older images (run by the operator: pgflow-upgrade --help)
COPY tests/fixtures/pgflow/upgrade/ /opt/pgflow/upgrade/
COPY docker/postgres/pgflow/structure-hash.sql docker/postgres/pgflow/legacy-structure.tsv /opt/pgflow/
COPY docker/postgres/pgflow/pgflow-upgrade.sh /usr/local/bin/pgflow-upgrade

# Consolidate all chmod operations into single RUN (better layer caching)
RUN set -euo pipefail && \
    chmod +x /usr/local/bin/healthcheck.sh && \
    chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh && \
    chmod +x /usr/local/bin/pgflow-upgrade && \
    chmod +x /docker-entrypoint-initdb.d/*.sh

# Copy runtime metadata files LATE (frequently change with any manifest update)
# Version info files (stable - only change with manifest updates)
COPY --from=builder-version-info /tmp/version-info.txt /etc/postgresql/version-info.txt
COPY --from=builder-version-info /tmp/version-info.json /etc/postgresql/version-info.json

# Extension manifest (volatile - changes frequently)
COPY docker/postgres/extensions.manifest.json /etc/postgresql/extensions.manifest.json

# Switch to postgres user for security (fixes CIS-DI-0001)
# All setup is complete, now run as non-root user
USER postgres

# OCI image labels with build metadata
# Placed AFTER USER to prevent cache invalidation when BUILD_DATE/VCS_REF change
# Labels ordered by stability: stable (vendor) → occasional (version) → frequent (BUILD_DATE/VCS_REF)
LABEL org.opencontainers.image.vendor="fluxo-kt"
LABEL org.opencontainers.image.title="aza-pg PostgreSQL 18.6"
LABEL org.opencontainers.image.description="PostgreSQL 18.6 with curated extension bundle (vector, time-series, search, security, ops)"
LABEL org.opencontainers.image.version="18.6"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"

# Health check and port exposure moved to end (metadata operations)
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
    CMD /usr/local/bin/healthcheck.sh

EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/docker-auto-config-entrypoint.sh"]
CMD ["postgres"]
