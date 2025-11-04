#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:-aza-pg:test}
CONTAINER="aza-pg-ext-smoke-$$"
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

jq_cmd=".entries[] | select(.kind==\"extension\")"
# Build dependency edges for tsort
EXT_EDGES=$(jq -r "${jq_cmd} | if (.dependencies // [] | length) == 0 then \"\(.name)\" else ((.dependencies // [])[] | \"\(. ) \(.name)\") end" docker/postgres/extensions.manifest.json | awk 'NF')
EXT_ALL=$(jq -r "${jq_cmd} | .name" docker/postgres/extensions.manifest.json)

tmpfile=$(mktemp)
{
  printf '%s\n' "$EXT_EDGES"
  printf '%s\n' "$EXT_ALL"
} | awk 'NF' | tsort > "$tmpfile"

if [[ ! -s "$tmpfile" ]]; then
  echo "[smoke] Failed to derive extension order" >&2
  rm -f "$tmpfile"
  exit 1
fi
mapfile -t EXTENSIONS < "$tmpfile"
rm -f "$tmpfile"

# Launch container
DOCKER_RUN=(
  docker run -d --rm --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    "$IMAGE"
)
"${DOCKER_RUN[@]}" >/dev/null

echo "[smoke] Waiting for PostgreSQL to accept connections..."
for attempt in {1..60}; do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [[ $attempt -eq 60 ]]; then
    echo "[smoke] postgres did not become ready in time" >&2
    exit 1
  fi
done

echo "[smoke] Creating extensions (${#EXTENSIONS[@]} total)"
for ext in "${EXTENSIONS[@]}"; do
  docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS \"${ext}\" CASCADE;" >/dev/null
  echo "  - ${ext} created"
done

docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT '[-1,1]'::vector(2) AS vector_smoke;
SELECT PostGIS_Version() AS postgis_version;
SELECT partman_version() AS partman_version;
SELECT current_setting('timescaledb.telemetry_level') AS timescaledb_telemetry;
SELECT extname FROM pg_extension WHERE extname IN ('timescaledb', 'vectorscale');
SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries';
SQL

echo "[smoke] Extension smoke test completed successfully."
