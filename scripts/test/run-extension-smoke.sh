#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:-aza-pg:test}
CONTAINER="aza-pg-ext-smoke-$$"
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

EXT_ORDER=$(python3 - <<'PY'
import json
from collections import deque, defaultdict

with open("docker/postgres/extensions.manifest.json", "r", encoding="utf-8") as fh:
    manifest = json.load(fh)

extensions = [entry for entry in manifest["entries"] if entry.get("kind") == "extension"]
ext_names = {entry["name"] for entry in extensions}

deps = {}
for entry in extensions:
    filtered = {dep for dep in (entry.get("dependencies", []) or []) if dep in ext_names}
    deps[entry["name"]] = filtered
dependents = defaultdict(set)
for name, dset in deps.items():
    for dep in dset:
        dependents[dep].add(name)

indegree = {name: len(dset) for name, dset in deps.items()}
queue = deque(sorted([name for name, deg in indegree.items() if deg == 0]))
order = []

while queue:
    current = queue.popleft()
    order.append(current)
    for child in sorted(dependents.get(current, [])):
        indegree[child] -= 1
        if indegree[child] == 0:
            queue.append(child)

if len(order) != len(deps):
    missing = set(deps) - set(order)
    print("ERROR", ",".join(sorted(missing)))
else:
    print("\n".join(order))
PY
)

if [[ $EXT_ORDER == ERROR* ]]; then
  echo "[smoke] Failed to derive extension order due to dependency cycle: ${EXT_ORDER#ERROR }" >&2
  exit 1
fi

IFS=$'\n' read -r -d '' -a EXTENSIONS < <(printf '%s\0' "$EXT_ORDER")

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
  if ! docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_available_extensions WHERE name = '${ext}'" | grep -q 1; then
    echo "  - ${ext} (skipped; control file not present)"
    continue
  fi
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
