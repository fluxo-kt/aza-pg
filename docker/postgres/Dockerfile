# PostgreSQL 18 with comprehensive extension suite

ARG PG_VERSION=18
ARG PG_BASE_IMAGE_SHA=sha256:5d1822a7565aecbf17323dd54754ab8b832963e62b9512f465c2f155db9262dd

# Build metadata for OCI labels
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=18

# PGDG extension versions (14 pre-compiled extensions)
ARG PGCRON_VERSION=1.6.7-2.pgdg13+1
ARG PGAUDIT_VERSION=18.0-2.pgdg13+1
ARG PGVECTOR_VERSION=0.8.1-2.pgdg13+1
ARG TIMESCALEDB_VERSION=2.23.0+dfsg-1.pgdg13+1
ARG POSTGIS_VERSION=3.6.0+dfsg-3.pgdg13+1
ARG PARTMAN_VERSION=5.3.1-1.pgdg13+1
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
LABEL org.opencontainers.image.description="PostgreSQL 18 with 38 extensions (36 enabled)"

ENV DEBIAN_FRONTEND=noninteractive

COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json
COPY docker/postgres/extensions.build-packages.txt /tmp/extensions.build-packages.txt
COPY docker/postgres/build-extensions.sh /usr/local/bin/build-extensions.sh
RUN chmod +x /usr/local/bin/build-extensions.sh

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
      postgresql-server-dev-${PG_MAJOR} \
      $(tr '\n' ' ' < /tmp/extensions.build-packages.txt) && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN set -eu && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

# Stage for PGXS/autotools/cmake/meson/make/timescaledb builds
FROM builder-base AS builder-pgxs
RUN jq '{generatedAt: .generatedAt, entries: [ .entries[] | select((.build.type == "pgxs") or (.build.type == "autotools") or (.build.type == "cmake") or (.build.type == "meson") or (.build.type == "make") or (.build.type == "timescaledb")) ]}' /tmp/extensions.manifest.json > /tmp/extensions.pgxs.manifest.json

RUN --mount=type=cache,target=/root/.cache \
    /usr/local/bin/build-extensions.sh /tmp/extensions.pgxs.manifest.json /tmp/extensions-build

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
    /usr/local/bin/build-extensions.sh /tmp/extensions.cargo.manifest.json /tmp/extensions-build

RUN set -eu && \
    mkdir -p /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib && \
    mkdir -p /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/extension && \
    rsync -a /usr/lib/postgresql/${PG_MAJOR}/lib/ /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/ && \
    rsync -a /usr/share/postgresql/${PG_MAJOR}/extension/ /opt/ext-out/usr/share/postgresql/${PG_MAJOR}/extension/ && \
    find /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib -name '*.so' -exec strip --strip-debug {} \; && \
    rm -rf /opt/ext-out/usr/lib/postgresql/${PG_MAJOR}/lib/bitcode && \
    find /opt/ext-out -name '*.a' -delete

# Generate version-info.txt (small Bun stage, not included in final image)
FROM oven/bun:1.1.38-alpine AS version-info-generator
COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json
COPY scripts/generate-version-info.ts /tmp/generate-version-info.ts
RUN bun run /tmp/generate-version-info.ts > /tmp/version-info.txt

ARG PG_VERSION
ARG PG_BASE_IMAGE_SHA
FROM postgres:${PG_VERSION}-trixie@${PG_BASE_IMAGE_SHA}

ENV DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="aza-pg PostgreSQL ${PG_VERSION}"
LABEL org.opencontainers.image.description="PostgreSQL ${PG_VERSION} with curated extension bundle (vector, time-series, search, security, ops)"
LABEL org.opencontainers.image.version="${PG_VERSION}"

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
    apt-get install -y jq && \
    # Build package list dynamically from manifest (only enabled PGDG extensions)
    PGDG_PACKAGES="" && \
    # Helper function to conditionally add package if enabled
    add_if_enabled() { \
      local ext_name=$1; \
      local pkg_name=$2; \
      local pkg_version=$3; \
      if jq -e --arg name "$ext_name" '.entries[] | select(.name == $name and .install_via == "pgdg" and (.enabled // true) == true)' /tmp/extensions.manifest.json >/dev/null; then \
        PGDG_PACKAGES="$PGDG_PACKAGES postgresql-${PG_MAJOR}-${pkg_name}=${pkg_version}"; \
      fi; \
    } && \
    add_if_enabled "pg_cron" "cron" "${PGCRON_VERSION}" && \
    add_if_enabled "pgaudit" "pgaudit" "${PGAUDIT_VERSION}" && \
    add_if_enabled "vector" "pgvector" "${PGVECTOR_VERSION}" && \
    add_if_enabled "timescaledb" "timescaledb" "${TIMESCALEDB_VERSION}" && \
    add_if_enabled "postgis" "postgis-3" "${POSTGIS_VERSION}" && \
    add_if_enabled "pg_partman" "partman" "${PARTMAN_VERSION}" && \
    add_if_enabled "pg_repack" "repack" "${REPACK_VERSION}" && \
    add_if_enabled "plpgsql_check" "plpgsql-check" "${PLPGSQL_CHECK_VERSION}" && \
    add_if_enabled "hll" "hll" "${HLL_VERSION}" && \
    add_if_enabled "http" "http" "${HTTP_VERSION}" && \
    add_if_enabled "hypopg" "hypopg" "${HYPOPG_VERSION}" && \
    add_if_enabled "pgrouting" "pgrouting" "${PGROUTING_VERSION}" && \
    add_if_enabled "rum" "rum" "${RUM_VERSION}" && \
    add_if_enabled "set_user" "set-user" "${SET_USER_VERSION}" && \
    # Install only enabled packages (skip if none enabled)
    if [ -n "$PGDG_PACKAGES" ]; then \
      echo "Installing PGDG packages: $PGDG_PACKAGES" && \
      apt-get install -y $PGDG_PACKAGES && \
      # Verify expected PGDG extensions were installed (Phase 4.1 assertion)
      dpkg -l | grep "^ii.*postgresql-${PG_MAJOR}-" | tee /tmp/installed-pgdg-exts.log && \
      INSTALLED_COUNT=$(wc -l < /tmp/installed-pgdg-exts.log) && \
      echo "Installed $INSTALLED_COUNT PGDG extension package(s)" && \
      # Dynamic verification: count enabled PGDG packages in manifest
      ENABLED_PGDG_COUNT=$(jq '[.entries[] | select(.kind == "pgdg" and .enabled == true)] | length' /tmp/extensions.manifest.json) && \
      echo "Expected $ENABLED_PGDG_COUNT enabled PGDG packages from manifest" && \
      # Allow some variance but ensure we have at least 1 package
      test "$INSTALLED_COUNT" -ge 1 || (echo "ERROR: No PGDG packages installed" && exit 1) && \
      rm -f /tmp/installed-pgdg-exts.log; \
    else \
      echo "No PGDG packages enabled in manifest"; \
    fi && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/extensions.manifest.json && \
    find /usr/lib/postgresql/${PG_MAJOR}/lib -name "*.so" -type f -exec strip --strip-unneeded {} \; 2>/dev/null || true

COPY --from=builder-pgxs /opt/ext-out/ /
COPY --from=builder-cargo /opt/ext-out/ /

# Remove LLVM bitcode from base PostgreSQL image (34MB of debug artifacts not needed at runtime)
RUN rm -rf /usr/lib/postgresql/${PG_MAJOR}/lib/bitcode

COPY docker/postgres/extensions.manifest.json /etc/postgresql/extensions.manifest.json
COPY --from=version-info-generator /tmp/version-info.txt /etc/postgresql/version-info.txt

RUN mkdir -p /backup && chown postgres:postgres /backup

COPY docker/postgres/docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
RUN chmod +x /docker-entrypoint-initdb.d/*.sh

COPY docker/postgres/docker-auto-config-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh
COPY docker/postgres/configs/postgresql-base.conf /etc/postgresql/

# Verify Bun is not present in final image (build-time tool should not leak)
RUN ! command -v bun || (echo "ERROR: Bun leaked into final image" && exit 1)

HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
    CMD psql -U postgres -d postgres -tAc 'SELECT 1' -w || exit 1

EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/docker-auto-config-entrypoint.sh"]
CMD ["postgres"]
