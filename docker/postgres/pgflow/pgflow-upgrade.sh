#!/bin/bash
# pgflow-upgrade — bring the pgflow schema in existing databases up to the version this image ships.
#
# Why it exists: the image installs pgflow only when a database is first created (initdb), so a database made by an
# older image keeps its old pgflow after the container is updated, while @pgflow/client of the new version needs the
# new schema. Existing databases are never upgraded automatically: the upgrade locks pgflow's tables and has to be
# timed with stopping workers and deploying the new client, so the operator runs this command.
#
# Usage: docker exec <container> pgflow-upgrade [--from VERSION] [DBNAME...]
#   DBNAME   databases to upgrade (default: every connectable database that has a pgflow schema)
#   --from   pgflow version a database is on now; normally detected (see below), so only needed when detection fails
#
# Before running: stop pgflow workers (the upgrade locks pgflow's tables), and upgrade the database before deploying
# @pgflow/client / @pgflow/dsl of the new version.
#
# The current version is detected per database: the pgflow schema's comment "pgflow X.Y.Z" (written by every install
# since this command exists), else the schema's structure matched against legacy-structure.tsv (releases images
# shipped before the comment). Detection matters because an image never upgrades an existing database: one created
# under an older image keeps that pgflow, whatever image runs it now, and a wrong starting version would skip
# migrations without any error. A --from that contradicts the schema comment or the detected structure is refused.
# A schema without pgflow.worker_functions is refused whatever --from says: every release this command upgrades from
# has that table, and the images that shipped pgflow 0.13.x installed a schema without it.
#
# Per database, in ONE transaction (any error rolls the whole database back): upstream migrations newer than the
# starting release, then aza-overrides.sql (aza-pg's versions of the functions the migrations leave different from a
# fresh install), then security-patches.sql, then the new version comment. pgflow telemetry stays off, because
# aza-pg never sends it unless the operator enables it: the bundled telemetry migration has its scheduling statement
# removed.
#
# A pgflow schema owned by a non-superuser is upgraded with that owner's rights (SET LOCAL ROLE), never superuser.
set -euo pipefail

# The shipped stacks allow local connections only as OS user postgres (pg_hba peer, mapped by pg_ident to any role),
# so `docker exec -u root` must drop to postgres before connecting. gosu is su-exec in this image.
if [ "$(id -u)" = 0 ]; then
  exec gosu postgres "$0" "$@"
fi

readonly DIR=/opt/pgflow/upgrade
readonly PSQL=(psql -X -v ON_ERROR_STOP=1 -U "${PGUSER:-${POSTGRES_USER:-postgres}}")
# Reading the catalogs of a database runs under that database's search_path, which its owner may set
# (ALTER DATABASE ... SET search_path) to put own objects named like catalog ones first; pg_catalog first keeps every
# lookup on the real catalog. Client options outrank database and role settings, and the last -c wins.
readonly PSQL_READ=(env "PGOPTIONS=${PGOPTIONS:-} -c search_path=pg_catalog,pg_temp" "${PSQL[@]}")

die() {
  echo "pgflow-upgrade: $*" >&2
  exit 1
}

# psql -d parses a value containing "=" as a connection string, so a database name passed as is could pick host,
# user or options of this superuser connection (any role that can create databases chooses the names). Quoted as
# libpq requires, the name stays a name.
dbname() {
  local v=${1//\\/\\\\}
  v=${v//\'/\\\'}
  printf "dbname='%s'" "$v"
}

from=""
dbs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --from)
      [ $# -ge 2 ] || die "--from needs a version, e.g. --from 0.14.1"
      from="$2"
      shift 2
      ;;
    -h | --help)
      # The header comment, however long it grows: everything after the shebang up to the first non-comment line.
      awk 'NR > 1 { if (!/^#/) exit; print }' "$0"
      exit 0
      ;;
    -*) die "unknown option $1 (see --help)" ;;
    *)
      dbs+=("$1")
      shift
      ;;
  esac
done

# versions.tsv: "<release>\t<its last upstream migration>", ascending; the last line is this image's version.
target=$(awk -F'\t' '!/^#/ { v = $1 } END { print v }' "$DIR/versions.tsv")
last_migration_of() { awk -F'\t' -v v="$1" '!/^#/ && $1 == v { print $2 }' "$DIR/versions.tsv"; }
known_versions() { awk -F'\t' '!/^#/ { printf "%s ", $1 }' "$DIR/versions.tsv"; }
legacy_version_of() { awk -F'\t' -v h="$1" '!/^#/ && $1 == h { print $2 }' /opt/pgflow/legacy-structure.tsv; }

failed=0
if [ ${#dbs[@]} -eq 0 ]; then
  # Captured, not read through a process substitution: its exit status is lost, so a failed listing would read as
  # "no database has a pgflow schema".
  listed=$("${PSQL_READ[@]}" -d postgres -Atc \
    "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname") ||
    die "cannot list the databases (connecting to database postgres failed; the error is above)"
  mapfile -t candidates <<<"$listed"
  for db in "${candidates[@]}"; do
    [ -n "$db" ] || continue
    # One database refusing the connection must not hide the pgflow schemas of the others.
    has=$("${PSQL_READ[@]}" -d "$(dbname "$db")" -Atc "SELECT 1 FROM pg_namespace WHERE nspname = 'pgflow'") || {
      echo "pgflow-upgrade: $db: cannot connect (the error is above); skipped" >&2
      failed=1
      continue
    }
    [ "$has" = 1 ] && dbs+=("$db")
  done
  [ ${#dbs[@]} -gt 0 ] || die "no reachable database has a pgflow schema; nothing to upgrade"
fi

for db in "${dbs[@]}"; do
  state=$("${PSQL_READ[@]}" -d "$(dbname "$db")" -Atc \
    "SELECT count(*) || ':' || count(to_regclass('pgflow.worker_functions')) || ':' || coalesce(max(CASE WHEN NOT r.rolsuper THEN quote_ident(r.rolname) END), '') || ':' || coalesce(max(obj_description(n.oid, 'pg_namespace')), '') FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE nspname = 'pgflow'") || {
    echo "pgflow-upgrade: $db: cannot connect (the error is above); skipped" >&2
    failed=1
    continue
  }
  if [ "${state%%:*}" = 0 ]; then
    echo "pgflow-upgrade: $db: no pgflow schema; nothing to upgrade" >&2
    failed=1
    continue
  fi
  state=${state#*:}
  # Checked on the defect itself, before --from is honoured: a 0.13.x schema whose structure was altered later (an
  # added index) matches no legacy hash, and following the "rerun with --from" hint would replay migrations over it.
  if [ "${state%%:*}" = 0 ]; then
    echo "pgflow-upgrade: $db: this pgflow schema has no pgflow.worker_functions table, which every release this command upgrades from has; aza-pg images that shipped pgflow 0.13.x installed such an incomplete schema, and no migration replay turns it into a correct one; nothing changed" >&2
    failed=1
    continue
  fi
  state=${state#*:}
  owner=${state%%:*} # empty when a superuser owns the schema, as in every database the image created
  recorded=$(sed -n 's/^pgflow \([0-9][0-9.]*\)$/\1/p' <<<"${state#*:}")
  detected=""
  if [ -z "$recorded" ]; then
    detected=$(legacy_version_of "$("${PSQL_READ[@]}" -q -d "$(dbname "$db")" -At -f /opt/pgflow/structure-hash.sql)")
  fi
  known="${recorded:-$detected}"
  if [ -n "$from" ] && [ -n "$known" ] && [ "$from" != "$known" ]; then
    echo "pgflow-upgrade: $db: --from $from, but it is pgflow $known; nothing changed (drop --from to use the detected version)" >&2
    failed=1
    continue
  fi
  start="${from:-$known}"
  if [ -z "$start" ]; then
    echo "pgflow-upgrade: $db: cannot tell its current pgflow version (no 'pgflow X.Y.Z' schema comment and an unknown structure); rerun with --from VERSION, one of: $(known_versions)" >&2
    failed=1
    continue
  fi
  if [ "$start" = "$target" ]; then
    echo "$db: pgflow $target, up to date"
    continue
  fi
  last=$(last_migration_of "$start")
  if [ -z "$last" ]; then
    echo "pgflow-upgrade: $db: cannot upgrade from pgflow $start; this image knows: $(known_versions)" >&2
    failed=1
    continue
  fi

  mapfile -t pending < <(find "$DIR/migrations" -name '*.sql' -printf '%f\n' | sort | awk -v last="$last" '$0 > last')
  {
    # Migrations create functions that read supabase_vault or pg_cron objects absent from many aza-pg databases;
    # aza-overrides.sql replaces exactly those functions in the same transaction, so body checks are deferred.
    echo "SET LOCAL check_function_bodies = off;"
    # A schema a non-superuser owns is upgraded with that owner's rights: as superuser, the functions and triggers
    # that owner controls would run with superuser rights during the migrations. Rights the owner lacks fail this
    # database's transaction, which rolls back and is reported; nothing escalates.
    [ -z "$owner" ] || echo "SET LOCAL ROLE $owner;"
    # awk 1 ends every line, the last included, with a newline: the files end without one, and a file ending in a
    # -- comment would otherwise swallow the next file's first statement. With no file operands it would read
    # stdin, so an empty pending list must not reach it.
    [ "${#pending[@]}" -eq 0 ] || (cd "$DIR/migrations" && awk 1 "${pending[@]}")
    awk 1 "$DIR/aza-overrides.sql" /opt/pgflow/security-patches.sql
    echo "COMMENT ON SCHEMA pgflow IS 'pgflow $target';"
  } | "${PSQL[@]}" -1 -q -d "$(dbname "$db")" >/dev/null || {
    echo "pgflow-upgrade: $db: upgrade from pgflow $start failed and was rolled back; the error is above${owner:+ (it ran as $owner, the non-superuser owning schema pgflow: give $owner the right the error names, or make a superuser the owner, then rerun)}" >&2
    failed=1
    continue
  }
  echo "$db: pgflow $start -> $target (${#pending[@]} migrations)"
done
exit "$failed"
