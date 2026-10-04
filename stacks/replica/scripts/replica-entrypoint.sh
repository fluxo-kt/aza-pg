#!/bin/bash
# Replica stack entrypoint: on a volume without a database, clone the primary with pg_basebackup, then hand over to
# the image's entrypoint, which starts the clone as a hot standby.
#
# Why before the image entrypoint, not in /docker-entrypoint-initdb.d: by the time initdb scripts run, the image
# entrypoint has already chosen the server settings for a fresh, non-standby database. The clone's first start then
# used this container's RAM-sized max_connections and max_worker_processes and died when the primary's were higher.
# Cloning first means the image entrypoint sees standby.signal and raises them to the primary's values. It also skips
# an initdb whose result was deleted straight away.
#
# Never deletes anything: a data directory without PG_VERSION that is not empty makes pg_basebackup stop with
# "exists but is not empty", and the operator decides what that directory is.
set -euo pipefail

# The image runs as postgres (USER postgres); an operator's user: root still gets a postgres-owned clone.
as_postgres() { if [ "$(id -u)" = 0 ]; then gosu postgres "$@"; else "$@"; fi; }

if [ ! -s "${PGDATA:?PGDATA is unset; it comes from the postgres base image}/PG_VERSION" ]; then
    : "${PRIMARY_HOST:?PRIMARY_HOST is required}"
    : "${PG_REPLICATION_USER:?PG_REPLICATION_USER is required}"
    : "${PG_REPLICATION_PASSWORD:?PG_REPLICATION_PASSWORD is required}"
    port="${PRIMARY_PORT:-5432}"
    slot="${REPLICATION_SLOT_NAME:-replica_slot_1}"
    install -d -o postgres -g postgres -m 0700 "$PGDATA"

    # The primary stack may still be starting; a bounded wait gives one clear error instead of a restart loop.
    echo "[REPLICA] Waiting for the primary at ${PRIMARY_HOST}:${port}..."
    for attempt in $(seq 60); do
        pg_isready -q -h "$PRIMARY_HOST" -p "$port" && break
        if [ "$attempt" -eq 60 ]; then
            echo "[REPLICA] ERROR: primary ${PRIMARY_HOST}:${port} not ready after 120 s" >&2
            exit 1
        fi
        sleep 2
    done

    # -R writes standby.signal and primary_conninfo; -S streams through the slot the primary's initdb created
    # (the image's 02-replication.sh), so the primary keeps the WAL this replica has not received yet.
    echo "[REPLICA] Cloning ${PRIMARY_HOST}:${port} through replication slot ${slot}..."
    PGPASSWORD="$PG_REPLICATION_PASSWORD" as_postgres pg_basebackup \
        -h "$PRIMARY_HOST" -p "$port" -U "$PG_REPLICATION_USER" -D "$PGDATA" -X stream -R -S "$slot" -c fast
    echo "[REPLICA] Clone complete"
fi

exec /usr/local/bin/docker-auto-config-entrypoint.sh "$@"
