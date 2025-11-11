#!/bin/bash
# PostgreSQL Auto-Configuration Entrypoint
# Auto-detects RAM, CPU cores, and scales Postgres settings proportionally

set -euo pipefail

readonly DEFAULT_RAM_MB=1024

# Minimal default preload set for safety and performance.
# Optional libraries requiring preload (enable via POSTGRES_SHARED_PRELOAD_LIBRARIES):
#   - pgsodium: Requires pgsodium_getkey script for TCE (Transparent Column Encryption)
#   - supautils: Superuser guards for managed Postgres
# Note: pg_stat_monitor and pg_stat_statements can coexist in PG18 via pgsm aggregation
# Note: timescaledb and pg_safeupdate require preload per manifest configuration
readonly DEFAULT_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,pg_stat_monitor,auto_explain,pg_cron,pgaudit,timescaledb,safeupdate"

readonly SHARED_BUFFERS_CAP_MB=32768
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

# Data checksums are enabled by default via official Debian PostgreSQL package initdb wrapper.
# Override: Set DISABLE_DATA_CHECKSUMS=true to disable (not recommended - reduces corruption detection).
if [ "${DISABLE_DATA_CHECKSUMS:-false}" = "true" ]; then
    export POSTGRES_INITDB_ARGS="${POSTGRES_INITDB_ARGS} --no-data-checksums"
fi

detect_ram() {
    local ram_mb=0
    local source="unknown"

    if [ -n "${POSTGRES_MEMORY:-}" ]; then
        if ! [[ "${POSTGRES_MEMORY}" =~ ^[0-9]+$ ]]; then
            echo "[POSTGRES] ERROR: POSTGRES_MEMORY must be an integer value in MB" >&2
            exit 1
        fi
        if [ "${POSTGRES_MEMORY}" -lt 1 ]; then
            echo "[POSTGRES] ERROR: POSTGRES_MEMORY must be a positive integer (MB)" >&2
            exit 1
        fi
        if [ "${POSTGRES_MEMORY}" -gt 1048576 ]; then
            echo "[POSTGRES] ERROR: POSTGRES_MEMORY exceeds maximum (1TB = 1048576 MB)" >&2
            exit 1
        fi
        ram_mb=${POSTGRES_MEMORY}
        source="manual"
        echo "$ram_mb:$source"
        return
    fi

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

    if [ -r /proc/meminfo ]; then
        local mem_total_kb
        mem_total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo "0")
        if [ "$mem_total_kb" -gt 0 ]; then
            ram_mb=$((mem_total_kb / 1024))
            source="meminfo"
            echo "$ram_mb:$source"
            return
        fi
    fi

    ram_mb=$DEFAULT_RAM_MB
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

# Warn if using fallback RAM detection (may reflect host instead of container)
if [ "$RAM_SOURCE" = "meminfo" ]; then
    echo "[POSTGRES] WARNING: Using /proc/meminfo fallback for RAM detection (no cgroup limit or POSTGRES_MEMORY set)" >&2
    echo "[POSTGRES] WARNING: This may reflect host RAM instead of container allocation - set POSTGRES_MEMORY to override" >&2
fi

CPU_INFO=$(detect_cpu)
CPU_CORES=$(echo "$CPU_INFO" | cut -d: -f1)
CPU_SOURCE=$(echo "$CPU_INFO" | cut -d: -f2)

# Warn if using fallback CPU detection
if [ "$CPU_SOURCE" = "nproc" ]; then
    echo "[POSTGRES] WARNING: Using nproc fallback for CPU detection (no cgroup quota set)" >&2
fi

# Sanity check: Clamp CPU cores between 1-128 to prevent misconfiguration
if [ "$CPU_CORES" -lt 1 ]; then
    echo "[POSTGRES] WARNING: Detected CPU cores ($CPU_CORES) below minimum - clamping to 1" >&2
    CPU_CORES=1
elif [ "$CPU_CORES" -gt 128 ]; then
    echo "[POSTGRES] WARNING: Detected CPU cores ($CPU_CORES) exceeds maximum (128) - clamping to 128" >&2
    CPU_CORES=128
fi

if [ "$TOTAL_RAM_MB" -lt 512 ]; then
    echo "[POSTGRES] FATAL: Detected ${TOTAL_RAM_MB}MB RAM - minimum 512MB REQUIRED"
    echo "[POSTGRES] Set memory limit: docker run -m 512m OR compose mem_limit: 512m"
    exit 1
fi

if [ "$TOTAL_RAM_MB" -lt 1024 ]; then
    MAX_CONNECTIONS=80
elif [ "$TOTAL_RAM_MB" -lt 4096 ]; then
    MAX_CONNECTIONS=120
else
    MAX_CONNECTIONS=200
fi

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

    local max_value=$((TOTAL_RAM_MB * 3 / 4))
    [ "$value" -gt "$max_value" ] && value=$max_value

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

# Cap max_worker_processes at 64 to prevent exceeding PostgreSQL limits on high-core machines
MAX_WORKER_PROCESSES=$((CPU_CORES * 2))
[ "$MAX_WORKER_PROCESSES" -gt 64 ] && MAX_WORKER_PROCESSES=64

MAX_PARALLEL_WORKERS=$CPU_CORES
MAX_PARALLEL_WORKERS_PER_GATHER=$((CPU_CORES / 2))
[ "$MAX_PARALLEL_WORKERS_PER_GATHER" -lt 1 ] && MAX_PARALLEL_WORKERS_PER_GATHER=1

SHARED_PRELOAD_LIBRARIES=${POSTGRES_SHARED_PRELOAD_LIBRARIES:-$DEFAULT_SHARED_PRELOAD_LIBRARIES}

# Override listen_addresses based on POSTGRES_BIND_IP
# Default: 127.0.0.1 (localhost only, secure)
# Network replication: Set POSTGRES_BIND_IP to specific IP or 0.0.0.0 for all interfaces
LISTEN_ADDR="${POSTGRES_BIND_IP:-127.0.0.1}"
LISTEN_ADDRESSES_OVERRIDE=""
if [ "$LISTEN_ADDR" != "127.0.0.1" ]; then
    # Honor the specific IP address provided instead of forcing 0.0.0.0
    LISTEN_ADDRESSES_OVERRIDE="$LISTEN_ADDR"
    echo "[POSTGRES] [AUTO-CONFIG] Network mode enabled → listen_addresses=${LISTEN_ADDRESSES_OVERRIDE}"
fi

echo "[POSTGRES] [AUTO-CONFIG] RAM: ${TOTAL_RAM_MB}MB ($RAM_SOURCE), CPU: ${CPU_CORES} cores ($CPU_SOURCE) → shared_buffers=${SHARED_BUFFERS_MB}MB, effective_cache_size=${EFFECTIVE_CACHE_MB}MB, maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB, work_mem=${WORK_MEM_MB}MB, max_connections=${MAX_CONNECTIONS}, max_worker_processes=${MAX_WORKER_PROCESSES}, max_parallel_workers=${MAX_PARALLEL_WORKERS}, max_parallel_workers_per_gather=${MAX_PARALLEL_WORKERS_PER_GATHER}"

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

# Apply listen_addresses override if network mode enabled
if [ -n "$LISTEN_ADDRESSES_OVERRIDE" ]; then
    set -- "$@" -c "listen_addresses=${LISTEN_ADDRESSES_OVERRIDE}"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
