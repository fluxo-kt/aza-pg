# AUTO-GENERATED FILE - DO NOT EDIT
# Generated at: 2025-11-20T20:58:03.045Z
# Generator: scripts/docker/generate-dockerfile.ts
# Template: docker/postgres/Dockerfile.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

# PostgreSQL 18.1 with comprehensive extension suite

ARG PG_VERSION=18.1
ARG PG_BASE_IMAGE_SHA=sha256:5ec39c188013123927f30a006987c6b0e20f3ef2b54b140dfa96dac6844d883f

# Build metadata for OCI labels
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=18.1

# PGDG extension versions (14 pre-compiled extensions)
ARG PGCRON_VERSION=1.6.7-2.pgdg13+1
ARG PGAUDIT_VERSION=18.0-2.pgdg13+1
ARG PGVECTOR_VERSION=0.8.1-2.pgdg13+1
ARG TIMESCALEDB_VERSION=2.23.1+dfsg-1.pgdg13+1
ARG POSTGIS_VERSION=3.6.0+dfsg-3.pgdg13+1
ARG PARTMAN_VERSION=5.3.1-2.pgdg13+1
ARG REPACK_VERSION=1.5.3-1.pgdg13+1
ARG PLPGSQL_CHECK_VERSION=2.8.3-1.pgdg13+1
ARG HLL_VERSION=2.19-1.pgdg13+1
ARG HTTP_VERSION=1.7.0-3.pgdg13+1
ARG HYPOPG_VERSION=1.4.2-2.pgdg13+1
ARG PGROUTING_VERSION=3.8.0-2.pgdg13+1
ARG RUM_VERSION=1.3.15-1.pgdg13+1
ARG SET_USER_VERSION=4.2.0-1.pgdg13+1

FROM postgres:${PG_VERSION}-trixie@${PG_BASE_IMAGE_SHA} AS builder-base

# Re-declare ARGs after FROM to make them available in this stage
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

# OCI image labels
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.title="aza-pg"
LABEL org.opencontainers.image.description="PostgreSQL 18 with comprehensive extension catalog"
LABEL org.opencontainers.image.vendor="fluxo-kt"

ENV DEBIAN_FRONTEND=noninteractive

COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json
COPY docker/postgres/extensions.build-packages.txt /tmp/extensions.build-packages.txt
COPY docker/postgres/build-extensions.ts /usr/local/bin/build-extensions.ts
RUN chmod +x /usr/local/bin/build-extensions.ts

# Install build dependencies for builder-base stage
# Note: This is the first of 4 apt-get calls in the Dockerfile. Each stage has its own
# dependencies optimized for multi-stage build efficiency. DO NOT consolidate across stages.
RUN set -eu && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update && \
    apt-get install -y \
      build-essential \
      git \
      jq \
      curl \
      ca-certificates \
      rsync \
      unzip \
      postgresql-server-dev-${PG_MAJOR} \
      $(tr '\n' ' ' < /tmp/extensions.build-packages.txt) && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN set -eu && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

# Add Rust/Cargo to PATH
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Bun for running TypeScript build scripts
# Extracts version from project .tool-versions file (single source of truth)
COPY .tool-versions /tmp/.tool-versions
RUN set -eu && \
    BUN_VERSION=$(grep "^bun " /tmp/.tool-versions | awk '{print $2}') && \
    echo "Installing Bun v${BUN_VERSION}" && \
    curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION} && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm /tmp/.tool-versions

# Stage for PGXS/autotools/cmake/meson/make/timescaledb builds
FROM builder-base AS builder-pgxs
RUN jq '{generatedAt: .generatedAt, entries: [ .entries[] | select((.build.type == "pgxs") or (.build.type == "autotools") or (.build.type == "cmake") or (.build.type == "meson") or (.build.type == "make") or (.build.type == "timescaledb")) ]}' /tmp/extensions.manifest.json > /tmp/extensions.pgxs.manifest.json

RUN --mount=type=cache,target=/root/.cache \
    /usr/local/bin/build-extensions.ts /tmp/extensions.pgxs.manifest.json /tmp/extensions-build

RUN set -eu && \
    mkdir -p /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/extension && \
    mkdir -p /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/contrib && \
    mkdir -p /opt/ext-out/usr/local/bin && \
    mkdir -p /opt/ext-out/usr/local/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/timescaledb && \
    rsync -a /usr/lib/postgresql/${PG_MAJOR}/lib/ /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/ && \
    rsync -a /usr/share/postgresql/${PG_MAJOR}/extension/ /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/extension/ && \
    rsync -a /usr/share/postgresql/${PG_MAJOR}/contrib/ /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/contrib/ && \
    rsync -a /usr/local/bin/ /opt/ext-out/usr/local/bin/ && \
    rsync -a /usr/local/lib/ /opt/ext-out/usr/local/lib/ && \
    if [ -d /usr/share/postgresql/${PG_MAJOR}/timescaledb ]; then \
      rsync -a /usr/share/postgresql/${PG_MAJOR}/timescaledb/ /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/timescaledb/; \
    fi && \
    find /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib -name '*.so' -exec strip --strip-debug {} \; && \
    find /opt/ext-out/usr/local/lib -name '*.so' -exec strip --strip-debug {} \; 2>/dev/null || true && \
    rm -rf /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/bitcode && \
    find /opt/ext-out -name '*.a' -delete

# Stage for cargo-pgrx builds
FROM builder-base AS builder-cargo

# Rust optimization flags for smaller binaries (Phase 11.1)
# Use CARGO_PROFILE_ variables instead of RUSTFLAGS to avoid breaking dependency builds
# opt-level=s: Optimize for size (less aggressive than 'z', more compatible)
# lto=thin: Enable thin link-time optimization
# strip=symbols: Strip debug symbols from binaries
ENV CARGO_PROFILE_RELEASE_LTO=thin
ENV CARGO_PROFILE_RELEASE_OPT_LEVEL=s
ENV CARGO_PROFILE_RELEASE_STRIP=symbols

RUN jq '{generatedAt: .generatedAt, entries: [ .entries[] | select(.build.type == "cargo-pgrx") ]}' /tmp/extensions.manifest.json > /tmp/extensions.cargo.manifest.json

RUN --mount=type=cache,target=/root/.cache \
    /usr/local/bin/build-extensions.ts /tmp/extensions.cargo.manifest.json /tmp/extensions-build

RUN set -eu && \
    mkdir -p /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/extension && \
    rsync -a /usr/lib/postgresql/${PG_MAJOR}/lib/ /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/ && \
    rsync -a /usr/share/postgresql/${PG_MAJOR}/extension/ /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/extension/ && \
    find /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib -name '*.so' -exec strip --strip-debug {} \; && \
    rm -rf /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/bitcode && \
    find /opt/ext-out -name '*.a' -delete

# Version info will be generated in final stage where PostgreSQL is available

ARG PG_VERSION
ARG PG_BASE_IMAGE_SHA
FROM postgres:${PG_VERSION}-trixie@${PG_BASE_IMAGE_SHA}

ENV DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="aza-pg PostgreSQL ${PG_VERSION}"
LABEL org.opencontainers.image.description="PostgreSQL ${PG_VERSION} with curated extension bundle (vector, time-series, search, security, ops)"
LABEL org.opencontainers.image.version="${PG_VERSION}"
LABEL org.opencontainers.image.vendor="fluxo-kt"

COPY docker/postgres/extensions.runtime-packages.txt /tmp/extensions.runtime-packages.txt

# Install runtime libraries for compiled extensions (final stage)
# Note: This is the fourth apt-get call, optimized for minimal runtime dependencies.
# Separate apt-get calls across stages (builder-base, builder-pgxs, builder-cargo, final)
# are intentional for multi-stage build optimization. DO NOT consolidate.
RUN set -eu && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update && \
    RUNTIME_PKGS="$(tr '\n' ' ' < /tmp/extensions.runtime-packages.txt)" && \
    apt-get install -y \
      # postgresql-client provides psql CLI tool (base postgres image only has server)
      # Required for: healthcheck (psql -tAc 'SELECT 1'), pg_dump/pg_restore in scripts
      postgresql-client-${PG_MAJOR} \
      ${RUNTIME_PKGS} && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/extensions.runtime-packages.txt

# Pre-compiled extensions from PGDG repository
ARG PGCRON_VERSION
ARG PGAUDIT_VERSION
ARG PGVECTOR_VERSION
ARG TIMESCALEDB_VERSION
ARG POSTGIS_VERSION
ARG PARTMAN_VERSION
ARG REPACK_VERSION
ARG PLPGSQL_CHECK_VERSION
ARG HLL_VERSION
ARG HTTP_VERSION
ARG HYPOPG_VERSION
ARG PGROUTING_VERSION
ARG RUM_VERSION
ARG SET_USER_VERSION

# Phase 4.3: Dynamic PGDG package filtering based on manifest enabled flag
# This RUN command reads extensions.manifest.json and only installs enabled PGDG extensions
COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json

RUN set -eu && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get update && \
    # Install enabled PGDG packages (pre-calculated in TS)
    echo "Installing PGDG packages: postgresql-${PG_MAJOR}-cron=${PGCRON_VERSION} postgresql-${PG_MAJOR}-pgaudit=${PGAUDIT_VERSION} postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION} postgresql-${PG_MAJOR}-timescaledb=${TIMESCALEDB_VERSION} postgresql-${PG_MAJOR}-partman=${PARTMAN_VERSION} postgresql-${PG_MAJOR}-repack=${REPACK_VERSION} postgresql-${PG_MAJOR}-plpgsql-check=${PLPGSQL_CHECK_VERSION} postgresql-${PG_MAJOR}-hll=${HLL_VERSION} postgresql-${PG_MAJOR}-http=${HTTP_VERSION} postgresql-${PG_MAJOR}-hypopg=${HYPOPG_VERSION} postgresql-${PG_MAJOR}-rum=${RUM_VERSION} postgresql-${PG_MAJOR}-set-user=${SET_USER_VERSION}" && \
    apt-get install -y postgresql-${PG_MAJOR}-cron=${PGCRON_VERSION} postgresql-${PG_MAJOR}-pgaudit=${PGAUDIT_VERSION} postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION} postgresql-${PG_MAJOR}-timescaledb=${TIMESCALEDB_VERSION} postgresql-${PG_MAJOR}-partman=${PARTMAN_VERSION} postgresql-${PG_MAJOR}-repack=${REPACK_VERSION} postgresql-${PG_MAJOR}-plpgsql-check=${PLPGSQL_CHECK_VERSION} postgresql-${PG_MAJOR}-hll=${HLL_VERSION} postgresql-${PG_MAJOR}-http=${HTTP_VERSION} postgresql-${PG_MAJOR}-hypopg=${HYPOPG_VERSION} postgresql-${PG_MAJOR}-rum=${RUM_VERSION} postgresql-${PG_MAJOR}-set-user=${SET_USER_VERSION} && \
    # Verify expected PGDG extensions were installed (Phase 4.1 assertion)
    dpkg -l | grep "^ii.*postgresql-${PG_MAJOR}-" | tee /tmp/installed-pgdg-exts.log && \
    INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log) && \
    echo "Installed $INSTALLED_COUNT PGDG extension package(s)" && \
    echo "Expected 12 enabled PGDG packages from manifest" && \
    # Allow some variance but ensure we have at least 1 package
    test "$INSTALLED_COUNT" -ge 12 || (echo "ERROR: Installed count mismatch (expected >= 12, got $INSTALLED_COUNT)" && exit 1) && \
    rm -f /tmp/installed-pgdg-exts.log && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/extensions.manifest.json && \
    find /usr/lib/postgresql/${PG_MAJOR}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \; 2>/dev/null || true

COPY --from=builder-pgxs /opt/ext-out/ /
COPY --from=builder-cargo /opt/ext-out/ /

# Remove LLVM bitcode from base PostgreSQL image (34MB of debug artifacts not needed at runtime)
RUN rm -rf /usr/lib/postgresql/${PG_MAJOR}/lib/bitcode

COPY docker/postgres/extensions.manifest.json /etc/postgresql/extensions.manifest.json

# Generate version-info files in final stage with actual PostgreSQL version
RUN set -ex; \
    \
    # Extract actual PostgreSQL version
    PG_VERSION=$(psql --version | grep -oP '\d+\.\d+' | head -1); \
    BUILD_DATE=$(date -u '+%Y-%m-%d'); \
    BUILD_TS=$(date -u '+%Y%m%d%H%M'); \
    \
    # Generate version-info.txt (super lean and focused)
    { \
      echo "aza-pg ${PG_VERSION} | ${BUILD_TS}"; \
      echo "=================================================="; \
      echo "PostgreSQL: ${PG_VERSION}"; \
      echo "Build: ${BUILD_TS} (${BUILD_DATE})"; \
      echo ""; \
      echo "Extensions & Tools:"; \
      printf "%b\n" "auto_explain builtin\nbtree_gin builtin\nbtree_gist builtin\nhll v2.19\nhttp v1.7.0\nhypopg 1.4.2\nindex_advisor v0.2.0\npg_cron v1.6.7\npg_hashids v1.2.1\npg_jsonschema 5492c7d1a28c5a2c85b48f89c47f258acc93d241\npg_partman v5.3.1\npg_repack ver_1.5.3\npg_safeupdate 1.5\npg_stat_monitor b00caafb684b3bd64f020ccd057303cd8a7af0d8\npg_stat_statements builtin\npg_trgm builtin\npgaudit 18.0\npgbackrest release/2.57.0\npgbadger v13.1\npgflow pgflow@0.7.2\npgmq v1.7.0\npgroonga 4.0.4\npgsodium v3.1.9\nplpgsql builtin\nplpgsql_check v2.8.3\nrum 1.3.15\nset_user REL4_2_0\nsupabase_vault v0.3.1\ntimescaledb 2.23.1\ntimescaledb_toolkit 1.22.0\nvector v0.8.1\nvectorscale 0.9.0\nwal2json wal2json_2_6\nwrappers 303da1dd0e7a94365ecf5d48866739fe9fda4d07"; \
    } > /etc/postgresql/version-info.txt && \
    \
    # Generate version-info.json (machine-readable)
    # Using heredoc with variable substitution for runtime values
    cat <<EOF > /etc/postgresql/version-info.json
{
  "postgres_version": "${PG_VERSION}",
  "build_timestamp": "${BUILD_TS}",
  "build_date": "${BUILD_DATE}",
  "build_type": "single-node",
  "extensions": {
    "total": 39,
    "enabled": 34,
    "disabled": 5,
    "preloaded": 9
  }
}
EOF


RUN mkdir -p /backup && chown postgres:postgres /backup

COPY docker/postgres/docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
RUN chmod +x /docker-entrypoint-initdb.d/*.sh

COPY docker/postgres/docker-auto-config-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh
COPY docker/postgres/configs/postgresql-base.conf /etc/postgresql/

# Verify Bun is not present in final image (build-time tool should not leak)
RUN ! command -v bun || (echo "ERROR: Bun leaked into final image" && exit 1)

# Switch to postgres user for security (fixes CIS-DI-0001)
# All setup is complete, now run as non-root user
USER postgres

HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
    CMD pg_isready -U postgres || exit 1

EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/docker-auto-config-entrypoint.sh"]
CMD ["postgres"]
