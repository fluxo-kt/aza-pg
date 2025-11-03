#!/bin/bash
# PostgreSQL Auto-Configuration Entrypoint
# Auto-detects RAM, CPU cores, and scales Postgres settings proportionally

set -e

readonly DEFAULT_RAM_MB=1024
readonly DEFAULT_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,auto_explain,pg_cron,pgaudit"

readonly SHARED_BUFFERS_CAP_MB=8192
readonly MAINTENANCE_WORK_MEM_CAP_MB=2048
readonly WORK_MEM_CAP_MB=32

if [ "$#" -eq 0 ]; then
    set -- postgres
elif [ "${1#-}" != "$1" ]; then
    set -- postgres "$@"
fi

if [ "$1" != "postgres" ]; then
    exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

# PostgreSQL 18 enables data checksums by default
# Override: Set DISABLE_DATA_CHECKSUMS=true to disable (not recommended)
if [ "${DISABLE_DATA_CHECKSUMS:-false}" = "true" ]; then
    export POSTGRES_INITDB_ARGS="${POSTGRES_INITDB_ARGS} --no-data-checksums"
fi

if [ "${POSTGRES_SKIP_AUTOCONFIG:-false}" = "true" ]; then
    echo "[AUTO-CONFIG] Disabled via POSTGRES_SKIP_AUTOCONFIG=true"
    exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

detect_ram() {
    local ram_mb=0
    local source="unknown"

    if [ -f /sys/fs/cgroup/memory.max ]; then
        local limit
        limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max")
        if [ "$limit" != "max" ] && [ -n "$limit" ]; then
            ram_mb=$((limit / 1024 / 1024))
            source="cgroup-v2"
            echo "$ram_mb:$source"
            return
        fi
    fi

    ram_mb=${POSTGRES_MEMORY:-$DEFAULT_RAM_MB}
    source="default"
    echo "$ram_mb:$source"
}

detect_cpu() {
    local cpu_cores=0
    local source="unknown"

    if [ -f /sys/fs/cgroup/cpu.max ]; then
        local cpu_quota
        local cpu_period
        cpu_quota=$(cut -d' ' -f1 /sys/fs/cgroup/cpu.max 2>/dev/null || echo "max")
        cpu_period=$(cut -d' ' -f2 /sys/fs/cgroup/cpu.max 2>/dev/null || echo "100000")

        if [ "$cpu_quota" != "max" ] && [ -n "$cpu_quota" ] && [ "$cpu_quota" != "0" ]; then
            cpu_cores=$(( (cpu_quota + cpu_period - 1) / cpu_period ))
            [ "$cpu_cores" -lt 1 ] && cpu_cores=1
            source="cgroup-v2"
        fi
    fi

    if [ "$cpu_cores" -eq 0 ]; then
        cpu_cores=$(nproc 2>/dev/null || echo "1")
        source="nproc"
    fi

    echo "$cpu_cores:$source"
}

RAM_INFO=$(detect_ram)
TOTAL_RAM_MB=$(echo "$RAM_INFO" | cut -d: -f1)
RAM_SOURCE=$(echo "$RAM_INFO" | cut -d: -f2)

CPU_INFO=$(detect_cpu)
CPU_CORES=$(echo "$CPU_INFO" | cut -d: -f1)
CPU_SOURCE=$(echo "$CPU_INFO" | cut -d: -f2)

if [ "$TOTAL_RAM_MB" -lt 512 ]; then
    echo "[AUTO-CONFIG] FATAL: Detected ${TOTAL_RAM_MB}MB RAM - minimum 512MB REQUIRED"
    echo "[AUTO-CONFIG] Set memory limit: docker run -m 512m OR deploy.resources.limits.memory: 512m"
    exit 1
fi

MAX_CONNECTIONS=200
[ "$TOTAL_RAM_MB" -lt 2048 ] && MAX_CONNECTIONS=100

calculate_shared_buffers() {
    local ratio

    if [ "$TOTAL_RAM_MB" -le 1024 ]; then
        ratio=25
    elif [ "$TOTAL_RAM_MB" -le 8192 ]; then
        ratio=25
    elif [ "$TOTAL_RAM_MB" -le 32768 ]; then
        ratio=20
    else
        ratio=15
    fi

    local value=$((TOTAL_RAM_MB * ratio / 100))

    [ "$value" -lt 64 ] && value=64
    [ "$value" -gt "$SHARED_BUFFERS_CAP_MB" ] && value=$SHARED_BUFFERS_CAP_MB

    echo "$value"
}

calculate_effective_cache() {
    local value=$((TOTAL_RAM_MB - SHARED_BUFFERS_MB))
    local min_value=$((SHARED_BUFFERS_MB * 2))

    [ "$value" -lt "$min_value" ] && value=$min_value
    [ "$value" -lt 0 ] && value=0

    echo "$value"
}

calculate_maintenance_work_mem() {
    local value=$((TOTAL_RAM_MB / 32))

    [ "$value" -lt 32 ] && value=32
    [ "$value" -gt "$MAINTENANCE_WORK_MEM_CAP_MB" ] && value=$MAINTENANCE_WORK_MEM_CAP_MB

    echo "$value"
}

calculate_work_mem() {
    local divisor=$((MAX_CONNECTIONS * 4))
    [ "$divisor" -lt 1 ] && divisor=1

    local value=$((TOTAL_RAM_MB / divisor))

    [ "$value" -lt 1 ] && value=1
    [ "$value" -gt "$WORK_MEM_CAP_MB" ] && value=$WORK_MEM_CAP_MB

    echo "$value"
}

SHARED_BUFFERS_MB=$(calculate_shared_buffers)
EFFECTIVE_CACHE_MB=$(calculate_effective_cache)
MAINTENANCE_WORK_MEM_MB=$(calculate_maintenance_work_mem)
WORK_MEM_MB=$(calculate_work_mem)

MAX_WORKER_PROCESSES=$((CPU_CORES * 2))
MAX_PARALLEL_WORKERS=$CPU_CORES
MAX_PARALLEL_WORKERS_PER_GATHER=$((CPU_CORES / 2))
[ "$MAX_PARALLEL_WORKERS_PER_GATHER" -lt 1 ] && MAX_PARALLEL_WORKERS_PER_GATHER=1

SHARED_PRELOAD_LIBRARIES=${POSTGRES_SHARED_PRELOAD_LIBRARIES:-$DEFAULT_SHARED_PRELOAD_LIBRARIES}

echo "[AUTO-CONFIG] RAM: ${TOTAL_RAM_MB}MB ($RAM_SOURCE), CPU: ${CPU_CORES} cores ($CPU_SOURCE) → shared_buffers=${SHARED_BUFFERS_MB}MB, effective_cache_size=${EFFECTIVE_CACHE_MB}MB, maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB, work_mem=${WORK_MEM_MB}MB, max_connections=${MAX_CONNECTIONS}, workers=${MAX_WORKER_PROCESSES}"

set -- "$@" \
    -c "shared_buffers=${SHARED_BUFFERS_MB}MB" \
    -c "effective_cache_size=${EFFECTIVE_CACHE_MB}MB" \
    -c "maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB" \
    -c "work_mem=${WORK_MEM_MB}MB" \
    -c "max_worker_processes=${MAX_WORKER_PROCESSES}" \
    -c "max_parallel_workers=${MAX_PARALLEL_WORKERS}" \
    -c "max_parallel_workers_per_gather=${MAX_PARALLEL_WORKERS_PER_GATHER}" \
    -c "max_connections=${MAX_CONNECTIONS}" \
    -c "shared_preload_libraries=${SHARED_PRELOAD_LIBRARIES}"

exec /usr/local/bin/docker-entrypoint.sh "$@"
