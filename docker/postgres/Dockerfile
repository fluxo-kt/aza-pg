# PostgreSQL 18 with comprehensive extension suite

ARG PG_VERSION=18

FROM postgres:${PG_VERSION}-bookworm AS builder

ENV DEBIAN_FRONTEND=noninteractive

COPY docker/postgres/extensions.manifest.json /tmp/extensions.manifest.json
COPY docker/postgres/extensions.build-packages.txt /tmp/extensions.build-packages.txt
COPY docker/postgres/build-extensions.sh /usr/local/bin/build-extensions.sh
RUN chmod +x /usr/local/bin/build-extensions.sh

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -euo pipefail && \
    apt-get update && \
    apt-get install -y \
      build-essential \
      git \
      jq \
      curl \
      ca-certificates \
      postgresql-server-dev-${PG_MAJOR} \
      $(tr '\n' ' ' < /tmp/extensions.build-packages.txt) && \
    rm -rf /var/lib/apt/lists/*

RUN set -euo pipefail && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && \
    . /root/.cargo/env && \
    cargo install --locked cargo-pgrx --version 0.16.1

RUN --mount=type=cache,target=/root/.cache \
    /usr/local/bin/build-extensions.sh /tmp/extensions.manifest.json /tmp/extensions-build


FROM postgres:${PG_VERSION}-bookworm

ENV DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="aza-pg PostgreSQL ${PG_VERSION}"
LABEL org.opencontainers.image.description="PostgreSQL ${PG_VERSION} with curated extension bundle (vector, time-series, search, security, ops)"
LABEL org.opencontainers.image.version="${PG_VERSION}"

COPY docker/postgres/extensions.build-packages.txt /tmp/extensions.build-packages.txt

# Runtime libraries for compiled extensions
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -euo pipefail && \
    apt-get update && \
    apt-get install -y \
      ca-certificates \
      zstd \
      lz4 \
      postgresql-client-${PG_MAJOR} \
      $(tr '\n' ' ' < /tmp/extensions.build-packages.txt) && \
    rm -rf /var/lib/apt/lists/* /tmp/extensions.build-packages.txt

COPY --from=builder /usr/lib/postgresql/${PG_MAJOR}/lib/ /usr/lib/postgresql/${PG_MAJOR}/lib/
COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/extension/ /usr/share/postgresql/${PG_MAJOR}/extension/
COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/contrib/ /usr/share/postgresql/${PG_MAJOR}/contrib/
COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/timescaledb/ /usr/share/postgresql/${PG_MAJOR}/timescaledb/
COPY --from=builder /usr/local/bin/pgbackrest /usr/local/bin/pgbackrest
COPY --from=builder /usr/local/bin/pgbadger /usr/local/bin/pgbadger
COPY --from=builder /usr/local/lib/ /usr/local/lib/

COPY docker/postgres/extensions.manifest.json /etc/postgresql/extensions.manifest.json

RUN mkdir -p /backup && chown postgres:postgres /backup

COPY docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
RUN chmod +x /docker-entrypoint-initdb.d/*.sh

COPY docker-auto-config-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh
COPY configs/postgresql-base.conf /etc/postgresql/

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD pg_isready -U postgres -d postgres || exit 1

EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/docker-auto-config-entrypoint.sh"]
CMD ["postgres"]
