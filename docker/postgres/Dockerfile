# AUTO-GENERATED FILE - DO NOT EDIT
# Generator: scripts/docker/generate-dockerfile.ts
# Template: docker/postgres/Dockerfile.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

# PostgreSQL 18.6 with comprehensive extension suite

FROM postgres:18.6-trixie@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf AS builder-base

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

# Rust and Bun come from their official images pinned by digest (MANIFEST_METADATA rustImageSha/bunImageSha), the
# same trust anchor as the postgres base image: the rustup and bun.sh install scripts used before ran build-day
# bytes as root unchecked. The rust image holds the same minimal profile (rustc, cargo, rust-std); copied to rustup's
# default homes so HOME=/root finds it with no extra environment.
COPY --from=rust:1.99.0-slim-trixie@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273 /usr/local/cargo /root/.cargo
COPY --from=rust:1.99.0-slim-trixie@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273 /usr/local/rustup /root/.rustup
ENV PATH="/root/.cargo/bin:${PATH}"

# Bun runs the TypeScript build script; its version is .tool-versions' (the generator reads it)
COPY --from=oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 /usr/local/bin/bun /usr/local/bin/bun

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

RUN --mount=type=cache,target=/root/.cache,sharing=locked \
    bun /usr/local/bin/build-extensions.ts /tmp/extensions.pgxs.manifest.json /tmp/extensions-build

RUN set -euo pipefail && \
    mkdir -p /opt/ext-out/usr/lib/postgresql/18/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/extension && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/contrib && \
    mkdir -p /opt/ext-out/usr/local/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/18/timescaledb && \
    rsync -a /usr/lib/postgresql/18/lib/ /opt/ext-out/usr/lib/postgresql/18/lib/ && \
    rsync -a /usr/share/postgresql/18/extension/ /opt/ext-out/usr/share/postgresql/18/extension/ && \
    rsync -a /usr/share/postgresql/18/contrib/ /opt/ext-out/usr/share/postgresql/18/contrib/ && \
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
FROM postgres:18.6-trixie@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf

# Use bash with pipefail for RUN commands (Debian's /bin/sh is dash, which doesn't support it)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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

# Pre-compiled extensions from PGDG repository: the enabled entries' packages, pinned at generation time
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update && \
    # Install enabled PGDG packages (pre-calculated in TS)
    echo "Installing PGDG packages: postgresql-18-hll=2.21-1.pgdg13+2 postgresql-18-http=1.7.2-2.pgdg13+2 postgresql-18-hypopg=1.4.3-1.pgdg13+2 postgresql-18-cron=1.6.8-1.pgdg13+2 postgresql-18-partman=5.5.0-1.pgdg13+1 postgresql-18-repack=1.5.3-1.pgdg13+2 postgresql-18-pgaudit=18.0-3.pgdg13+1 postgresql-18-plpgsql-check=2.10.12-1.pgdg13+1 postgresql-18-rum=1.3.15-1.pgdg13+1 postgresql-18-set-user=4.2.0-1.pgdg13+2 postgresql-18-pgvector=0.8.7-1.pgdg13+1" && \
    apt-get install -y --no-install-recommends postgresql-18-hll=2.21-1.pgdg13+2 postgresql-18-http=1.7.2-2.pgdg13+2 postgresql-18-hypopg=1.4.3-1.pgdg13+2 postgresql-18-cron=1.6.8-1.pgdg13+2 postgresql-18-partman=5.5.0-1.pgdg13+1 postgresql-18-repack=1.5.3-1.pgdg13+2 postgresql-18-pgaudit=18.0-3.pgdg13+1 postgresql-18-plpgsql-check=2.10.12-1.pgdg13+1 postgresql-18-rum=1.3.15-1.pgdg13+1 postgresql-18-set-user=4.2.0-1.pgdg13+2 postgresql-18-pgvector=0.8.7-1.pgdg13+1 && \
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
    test -f /usr/lib/postgresql/18/lib/vector.so && \
    echo "All 11 PGDG module files verified" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    { find /usr/lib/postgresql/18/lib -name "*.so" -type f -exec strip --strip-unneeded {} \; 2>/dev/null || true; }

# Signing keys of the Percona and Timescale apt repositories (why: generate-dockerfile.ts APT_KEY_DIR)
COPY docker/postgres/apt-keys/ /usr/share/keyrings/aza-pg/

# Pre-compiled extensions from Percona repository (versions hardcoded at generation time)
# Provides pg_stat_monitor and wal2json from the already-required Percona repo layer
# Percona repository setup and package installation
# Provides: pg_stat_monitor and wal2json from Percona ppg-18
# Note: Percona packages are pinned via perconaVersion in manifest for reproducible builds
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    set -euo pipefail && \
    echo "deb [signed-by=/usr/share/keyrings/aza-pg/percona.asc] https://repo.percona.com/ppg-18/apt trixie main" > /etc/apt/sources.list.d/percona-ppg-18.list && \
    apt-get update --error-on=any && \
    echo "Installing Percona packages: percona-pg-stat-monitor18=1:2.4.0-1.trixie percona-postgresql-18-wal2json=1:2.6-5.trixie" && \
    apt-get install -y --no-install-recommends percona-pg-stat-monitor18=1:2.4.0-1.trixie percona-postgresql-18-wal2json=1:2.6-5.trixie && \
    echo "Installed 2 Percona package(s)" && \
    # Verify .so files exist
    echo "Verifying Percona .so files exist..." && \
    test -f /usr/lib/postgresql/18/lib/pg_stat_monitor.so && \
    test -f /usr/lib/postgresql/18/lib/wal2json.so && \
    echo "All 2 Percona module files verified" && \
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
    echo "deb [signed-by=/usr/share/keyrings/aza-pg/timescale.asc] https://packagecloud.io/timescale/timescaledb/debian/ trixie main" > /etc/apt/sources.list.d/timescale.list && \
    apt-get update --error-on=any && \
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
    echo "Installing PGDG tools: pgbackrest=2.59.3-1.pgdg13+1 pgbadger=13.2-1.pgdg13+1" && \
    apt-get install -y --no-install-recommends pgbackrest=2.59.3-1.pgdg13+1 pgbadger=13.2-1.pgdg13+1 && \
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
RUN set -euo pipefail && rm -rf /usr/lib/postgresql/18/lib/bitcode && ldconfig && \
    install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest

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
# is far below gosu's multi-MB size.
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
    install -o root -g root -m 0755 /tmp/su-exec-build/su-exec /usr/local/bin/gosu && \
    SZ=$(stat -c%s /usr/local/bin/gosu) && \
    echo "su-exec: ${SZ} bytes at /usr/local/bin/gosu (su-exec ~14KB, gosu ~7MB)" && \
    [ "${SZ}" -lt 500000 ] || { echo "FATAL: su-exec replacement failed — binary is >500KB"; exit 1; } && \
    apt-get purge -y --auto-remove build-essential git && \
    rm -rf /tmp/su-exec-build && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Remove the GnuPG CLI stack the postgres base image ships; nothing at runtime uses it.
# Debian 13 apt verifies repositories through sqv, so apt remains usable without it.
RUN set -euo pipefail && \
    apt-get purge -y --auto-remove \
      dirmngr \
      gnupg \
      gnupg-l10n \
      gpg \
      gpg-agent \
      gpgconf \
      gpgsm && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Every module, source-built library and source tool binary still finds its shared libraries after the
# --auto-remove purges above, which drop any library no remaining package depends on.
RUN set -euo pipefail && \
    unresolved=0 && \
    for f in /usr/lib/postgresql/18/lib/*.so /usr/local/lib/*.so*; do \
      [ ! -f "$f" ] || ! ldd "$f" | sed "s|^|$f: |" | grep "not found" || unresolved=1; \
    done && \
    [ "$unresolved" = 0 ] || { echo "FATAL: unresolved shared libraries listed above; add each owning package to extensions.runtime-packages.txt"; exit 1; }

# pgsodium root key: a random key per data directory, or the operator's PGSODIUM_KEY_FILE (script header). The second,
# never-executed copy lets the entrypoint tell an operator-mounted getkey (it owns the key) from the image's own;
# 0755 because COPY gives the new directory the same mode, and 0644 would make it untraversable.
COPY --chmod=0755 docker/postgres/pgsodium_getkey.sh /usr/share/postgresql/18/extension/pgsodium_getkey
COPY --chmod=0755 docker/postgres/pgsodium_getkey.sh /usr/local/share/aza-pg/pgsodium_getkey

# Create backup directory with proper ownership
RUN set -euo pipefail && mkdir -p /backup && chown postgres:postgres /backup

# Copy configs by stability (base config rarely changes, scripts occasionally change) for layer cache hits
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

# pg_repack with safeupdate off for its own sessions (see the script header)
COPY docker/postgres/pg_repack-wrapper.sh /usr/local/bin/pg_repack

# Consolidate all chmod operations into single RUN (better layer caching)
RUN set -euo pipefail && \
    chmod +x /usr/local/bin/healthcheck.sh && \
    chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh && \
    chmod +x /usr/local/bin/pgflow-upgrade && \
    chmod +x /usr/local/bin/pg_repack && \
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

# Build metadata ARGs (no defaults: CI/CD passes them). Declared after the last RUN because every RUN after an
# ARG gets it in its environment and cache key, so a new BUILD_DATE would re-run each of them on every build.
ARG BUILD_DATE
ARG VCS_REF

# OCI image labels with build metadata
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
