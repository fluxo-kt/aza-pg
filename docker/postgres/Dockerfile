# PostgreSQL 18 with comprehensive extension suite

ARG PG_VERSION=18
ARG PG_BASE_IMAGE_SHA=sha256:41fc5342eefba6cc2ccda736aaf034bbbb7c3df0fdb81516eba1ba33f360162c

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

ENV DEBIAN_FRONTEND=noninteractive

COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json
COPY docker/postgres/extensions.build-packages.txt /tmp/extensions.build-packages.txt
COPY docker/postgres/build-extensions.sh /usr/local/bin/build-extensions.sh
RUN chmod +x /usr/local/bin/build-extensions.sh

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eu && \
    apt-get update -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false && \
    apt-get install -y \
      build-essential \
      git \
      jq \
      curl \
      ca-certificates \
      rsync \
      postgresql-server-dev-${PG_MAJOR} \
      $(tr '\n' ' ' < /tmp/extensions.build-packages.txt) && \
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

ARG PG_VERSION
ARG PG_BASE_IMAGE_SHA
FROM postgres:${PG_VERSION}-trixie@${PG_BASE_IMAGE_SHA}

ENV DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="aza-pg PostgreSQL ${PG_VERSION}"
LABEL org.opencontainers.image.description="PostgreSQL ${PG_VERSION} with curated extension bundle (vector, time-series, search, security, ops)"
LABEL org.opencontainers.image.version="${PG_VERSION}"

COPY docker/postgres/extensions.runtime-packages.txt /tmp/extensions.runtime-packages.txt

# Runtime libraries for compiled extensions
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eu && \
    apt-get update -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false && \
    RUNTIME_PKGS="$(tr '\n' ' ' < /tmp/extensions.runtime-packages.txt)" && \
    apt-get install -y \
      postgresql-client-${PG_MAJOR} \
      ${RUNTIME_PKGS} && \
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

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eu && \
    apt-get update -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false && \
    apt-get install -y \
      postgresql-${PG_MAJOR}-cron=${PGCRON_VERSION} \
      postgresql-${PG_MAJOR}-pgaudit=${PGAUDIT_VERSION} \
      postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION} \
      postgresql-${PG_MAJOR}-timescaledb=${TIMESCALEDB_VERSION} \
      postgresql-${PG_MAJOR}-postgis-3=${POSTGIS_VERSION} \
      postgresql-${PG_MAJOR}-partman=${PARTMAN_VERSION} \
      postgresql-${PG_MAJOR}-repack=${REPACK_VERSION} \
      postgresql-${PG_MAJOR}-plpgsql-check=${PLPGSQL_CHECK_VERSION} \
      postgresql-${PG_MAJOR}-hll=${HLL_VERSION} \
      postgresql-${PG_MAJOR}-http=${HTTP_VERSION} \
      postgresql-${PG_MAJOR}-hypopg=${HYPOPG_VERSION} \
      postgresql-${PG_MAJOR}-pgrouting=${PGROUTING_VERSION} \
      postgresql-${PG_MAJOR}-rum=${RUM_VERSION} \
      postgresql-${PG_MAJOR}-set-user=${SET_USER_VERSION} && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder-pgxs /opt/ext-out/ /
COPY --from=builder-cargo /opt/ext-out/ /

# Remove LLVM bitcode from base PostgreSQL image (34MB of debug artifacts not needed at runtime)
RUN rm -rf /usr/lib/postgresql/${PG_MAJOR}/lib/bitcode

COPY docker/postgres/extensions.manifest.json /etc/postgresql/extensions.manifest.json

RUN mkdir -p /backup && chown postgres:postgres /backup

COPY docker/postgres/docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
RUN chmod +x /docker-entrypoint-initdb.d/*.sh

COPY docker/postgres/docker-auto-config-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh
COPY docker/postgres/configs/postgresql-base.conf /etc/postgresql/

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD pg_isready -U postgres -d postgres || exit 1

EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/docker-auto-config-entrypoint.sh"]
CMD ["postgres"]
