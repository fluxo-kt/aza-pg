#!/bin/bash
# PostgreSQL Auto-Configuration Entrypoint
# Auto-detects RAM, CPU cores, and scales Postgres settings proportionally

set -e

readonly BASELINE_RAM_MB=2048
readonly BASELINE_SHARED_BUFFERS_MB=512
readonly BASELINE_EFFECTIVE_CACHE_MB=768
readonly BASELINE_MAINTENANCE_WORK_MEM_MB=64
readonly BASELINE_WORK_MEM_MB=4

readonly SHARED_BUFFERS_CAP_MB=8192
readonly MAINTENANCE_WORK_MEM_CAP_MB=2048
readonly WORK_MEM_CAP_MB=32

export POSTGRES_INITDB_ARGS="${POSTGRES_INITDB_ARGS} --data-checksums"

if [ "${POSTGRES_SKIP_AUTOCONFIG:-false}" = "true" ]; then
    echo "[AUTO-CONFIG] Disabled via POSTGRES_SKIP_AUTOCONFIG=true"
    exec /usr/local/bin/docker-entrypoint.sh "$@"
fi

detect_ram() {
    local ram_mb=0
    local source="unknown"
    local shared_vps=false

    if [ -f /sys/fs/cgroup/memory.max ]; then
        local limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max")
        if [ "$limit" != "max" ] && [ -n "$limit" ]; then
            ram_mb=$((limit / 1024 / 1024))
            source="cgroup-v2"
        fi
    fi

    if [ "$ram_mb" -eq 0 ] && [ -f /proc/meminfo ]; then
        ram_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo "0")
        source="proc-meminfo"
        shared_vps=true
    fi

    if [ -z "$ram_mb" ] || [ "$ram_mb" -eq 0 ]; then
        echo "[AUTO-CONFIG] ERROR: Failed to detect RAM"
        exec /usr/local/bin/docker-entrypoint.sh "$@"
    fi

    if [ "$shared_vps" = true ]; then
        ram_mb=$((ram_mb / 2))
        echo "$ram_mb:$source:shared"
    else
        echo "$ram_mb:$source:dedicated"
    fi
}

detect_cpu() {
    local cpu_cores=0
    local source="unknown"

    if [ -f /sys/fs/cgroup/cpu.max ]; then
        local cpu_quota=$(cut -d' ' -f1 /sys/fs/cgroup/cpu.max 2>/dev/null || echo "max")
        local cpu_period=$(cut -d' ' -f2 /sys/fs/cgroup/cpu.max 2>/dev/null || echo "100000")

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
RAM_MODE=$(echo "$RAM_INFO" | cut -d: -f3)

CPU_INFO=$(detect_cpu)
CPU_CORES=$(echo "$CPU_INFO" | cut -d: -f1)
CPU_SOURCE=$(echo "$CPU_INFO" | cut -d: -f2)

echo "[AUTO-CONFIG] RAM: ${TOTAL_RAM_MB}MB (${RAM_SOURCE}, ${RAM_MODE}), CPU: ${CPU_CORES} cores (${CPU_SOURCE})"

if [ "$TOTAL_RAM_MB" -lt 1024 ]; then
    echo "[AUTO-CONFIG] FATAL: Detected ${TOTAL_RAM_MB}MB RAM - minimum 1GB REQUIRED"
    echo "[AUTO-CONFIG] Set memory limit: docker run -m 1g OR deploy.resources.limits.memory: 1g"
    exit 1
fi

if [ "$TOTAL_RAM_MB" -gt "$BASELINE_RAM_MB" ]; then
    SHARED_BUFFERS_MB=$((TOTAL_RAM_MB * BASELINE_SHARED_BUFFERS_MB / BASELINE_RAM_MB))
    EFFECTIVE_CACHE_MB=$((TOTAL_RAM_MB * BASELINE_EFFECTIVE_CACHE_MB / BASELINE_RAM_MB))
    MAINTENANCE_WORK_MEM_MB=$((TOTAL_RAM_MB * BASELINE_MAINTENANCE_WORK_MEM_MB / BASELINE_RAM_MB))
    WORK_MEM_MB=$((TOTAL_RAM_MB * BASELINE_WORK_MEM_MB / BASELINE_RAM_MB))

    [ "$SHARED_BUFFERS_MB" -gt "$SHARED_BUFFERS_CAP_MB" ] && SHARED_BUFFERS_MB=$SHARED_BUFFERS_CAP_MB
    [ "$MAINTENANCE_WORK_MEM_MB" -gt "$MAINTENANCE_WORK_MEM_CAP_MB" ] && MAINTENANCE_WORK_MEM_MB=$MAINTENANCE_WORK_MEM_CAP_MB
    [ "$WORK_MEM_MB" -gt "$WORK_MEM_CAP_MB" ] && WORK_MEM_MB=$WORK_MEM_CAP_MB

    echo "[AUTO-CONFIG] Scaled settings:"
    echo "[AUTO-CONFIG]   shared_buffers: ${SHARED_BUFFERS_MB}MB"
    echo "[AUTO-CONFIG]   effective_cache_size: ${EFFECTIVE_CACHE_MB}MB"
    echo "[AUTO-CONFIG]   maintenance_work_mem: ${MAINTENANCE_WORK_MEM_MB}MB"
    echo "[AUTO-CONFIG]   work_mem: ${WORK_MEM_MB}MB"
else
    SHARED_BUFFERS_MB=$BASELINE_SHARED_BUFFERS_MB
    EFFECTIVE_CACHE_MB=$BASELINE_EFFECTIVE_CACHE_MB
    MAINTENANCE_WORK_MEM_MB=$BASELINE_MAINTENANCE_WORK_MEM_MB
    WORK_MEM_MB=$BASELINE_WORK_MEM_MB
    echo "[AUTO-CONFIG] Using baseline (≤${BASELINE_RAM_MB}MB)"
fi

[ "$WORK_MEM_MB" -lt 1 ] && WORK_MEM_MB=1
TOTAL_POTENTIAL_MEM=$((SHARED_BUFFERS_MB + (200 * WORK_MEM_MB)))
SAFE_LIMIT=$((TOTAL_RAM_MB * 90 / 100))
if [ "$TOTAL_POTENTIAL_MEM" -gt "$SAFE_LIMIT" ]; then
    echo "[AUTO-CONFIG] FATAL: Config exceeds 90% RAM (${TOTAL_POTENTIAL_MEM}MB > ${SAFE_LIMIT}MB)"
    echo "[AUTO-CONFIG] Increase memory limit or set POSTGRES_SKIP_AUTOCONFIG=true"
    exit 1
fi

MAX_WORKER_PROCESSES=$((CPU_CORES * 2))
MAX_PARALLEL_WORKERS=$CPU_CORES
MAX_PARALLEL_WORKERS_PER_GATHER=$((CPU_CORES / 2))
[ "$MAX_PARALLEL_WORKERS_PER_GATHER" -lt 1 ] && MAX_PARALLEL_WORKERS_PER_GATHER=1

AVAILABLE_FOR_CONNS=$((TOTAL_RAM_MB - SHARED_BUFFERS_MB))
MAX_CONNECTIONS=$((AVAILABLE_FOR_CONNS / WORK_MEM_MB))
[ "$MAX_CONNECTIONS" -lt 20 ] && MAX_CONNECTIONS=20
[ "$MAX_CONNECTIONS" -gt 200 ] && MAX_CONNECTIONS=200

echo "[AUTO-CONFIG] CPU settings:"
echo "[AUTO-CONFIG]   max_worker_processes: ${MAX_WORKER_PROCESSES}"
echo "[AUTO-CONFIG]   max_parallel_workers: ${MAX_PARALLEL_WORKERS}"
echo "[AUTO-CONFIG]   max_parallel_workers_per_gather: ${MAX_PARALLEL_WORKERS_PER_GATHER}"
echo "[AUTO-CONFIG]   max_connections: ${MAX_CONNECTIONS}"

set -- "$@" \
    -c "shared_buffers=${SHARED_BUFFERS_MB}MB" \
    -c "effective_cache_size=${EFFECTIVE_CACHE_MB}MB" \
    -c "maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB" \
    -c "work_mem=${WORK_MEM_MB}MB" \
    -c "max_worker_processes=${MAX_WORKER_PROCESSES}" \
    -c "max_parallel_workers=${MAX_PARALLEL_WORKERS}" \
    -c "max_parallel_workers_per_gather=${MAX_PARALLEL_WORKERS_PER_GATHER}" \
    -c "max_connections=${MAX_CONNECTIONS}"

exec /usr/local/bin/docker-entrypoint.sh "$@"
