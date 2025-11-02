# PostgreSQL 18 with production extensions
# Multi-stage build for minimal image size

ARG PG_VERSION=18
ARG PGVECTOR_VERSION=0.8.1
ARG PG_CRON_VERSION=1.6.7
ARG PGAUDIT_VERSION=18.0

# Supply chain security: Pin extension commits to immutable SHAs
ARG PGVECTOR_COMMIT_SHA=778dacf20c07caf904557a88705142631818d8cb
ARG PG_CRON_COMMIT_SHA=465b38c737f584d520229f5a1d69d1d44649e4e5
ARG PGAUDIT_COMMIT_SHA=f39f8dbb15dc5bd4cbe5f1e5abe0d930ed7593a8

FROM postgres:${PG_VERSION}-bookworm AS builder

ARG PGVECTOR_VERSION
ARG PG_CRON_VERSION
ARG PGAUDIT_VERSION
ARG PGVECTOR_COMMIT_SHA
ARG PG_CRON_COMMIT_SHA
ARG PGAUDIT_COMMIT_SHA

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -e && \
    apt-get update && apt-get install -y \
    build-essential \
    git \
    postgresql-server-dev-${PG_MAJOR} \
    libssl-dev \
    libkrb5-dev

RUN set -e && \
    git clone https://github.com/pgvector/pgvector.git /tmp/pgvector && \
    cd /tmp/pgvector && \
    git checkout ${PGVECTOR_COMMIT_SHA} && \
    make -j$(nproc) && \
    make install

RUN set -e && \
    git clone https://github.com/citusdata/pg_cron.git /tmp/pg_cron && \
    cd /tmp/pg_cron && \
    git checkout ${PG_CRON_COMMIT_SHA} && \
    make -j$(nproc) && \
    make install

RUN set -e && \
    git clone https://github.com/pgaudit/pgaudit.git /tmp/pgaudit && \
    cd /tmp/pgaudit && \
    git checkout ${PGAUDIT_COMMIT_SHA} && \
    make USE_PGXS=1 -j$(nproc) && \
    make USE_PGXS=1 install

FROM postgres:${PG_VERSION}-bookworm

ARG PG_VERSION
ARG PGVECTOR_VERSION

LABEL org.opencontainers.image.title="PostgreSQL ${PG_VERSION} with Extensions"
LABEL org.opencontainers.image.description="PostgreSQL ${PG_VERSION} with pgvector ${PGVECTOR_VERSION}, pg_cron, pgAudit, pg_stat_statements, auto_explain, pg_trgm"
LABEL org.opencontainers.image.version="${PG_VERSION}"

COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/extension/vector* /usr/share/postgresql/${PG_MAJOR}/extension/
COPY --from=builder /usr/lib/postgresql/${PG_MAJOR}/lib/vector.so /usr/lib/postgresql/${PG_MAJOR}/lib/

COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/extension/pg_cron* /usr/share/postgresql/${PG_MAJOR}/extension/
COPY --from=builder /usr/lib/postgresql/${PG_MAJOR}/lib/pg_cron.so /usr/lib/postgresql/${PG_MAJOR}/lib/

COPY --from=builder /usr/share/postgresql/${PG_MAJOR}/extension/pgaudit* /usr/share/postgresql/${PG_MAJOR}/extension/
COPY --from=builder /usr/lib/postgresql/${PG_MAJOR}/lib/pgaudit.so /usr/lib/postgresql/${PG_MAJOR}/lib/

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -e && \
    apt-get update && apt-get install -y \
    ca-certificates \
    zstd \
    lz4

RUN set -e && mkdir -p /backup && chown postgres:postgres /backup

COPY docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
RUN set -e && chmod +x /docker-entrypoint-initdb.d/*.sh

COPY docker-auto-config-entrypoint.sh /usr/local/bin/
RUN set -e && chmod +x /usr/local/bin/docker-auto-config-entrypoint.sh
COPY configs/postgresql-base.conf /etc/postgresql/

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD pg_isready -U postgres -d postgres || exit 1

EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/docker-auto-config-entrypoint.sh"]
CMD ["postgres"]
