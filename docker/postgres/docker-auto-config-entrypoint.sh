#!/bin/bash
# AUTO-GENERATED FILE - DO NOT EDIT
# Generated at: 2025-11-23T04:14:44.174Z
# Generator: scripts/docker/generate-entrypoint.ts
# Template: docker/postgres/docker-auto-config-entrypoint.sh.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

# PostgreSQL Auto-Configuration Entrypoint
# Auto-detects RAM, CPU cores, and scales Postgres settings proportionally

set -euo pipefail

readonly DEFAULT_RAM_MB=1024

# Default preload set auto-generated from manifest (extensions with sharedPreload=true and defaultEnable=true).
# This list is automatically derived from the extensions manifest and regenerated when the manifest changes.
# Optional libraries requiring preload (enable via POSTGRES_SHARED_PRELOAD_LIBRARIES):
#   - pgsodium: Requires pgsodium_getkey script for TCE (Transparent Column Encryption)
#   - supautils: Superuser guards for managed Postgres
#   - timescaledb: Time-series database features (disabled by default)
#   - safeupdate: UPDATE/DELETE safety guard (disabled by default)
# Note: pg_stat_monitor and pg_stat_statements can coexist in PG18 via pgsm aggregation
readonly DEFAULT_SHARED_PRELOAD_LIBRARIES="auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,timescaledb"

readonly SHARED_BUFFERS_CAP_MB=32768
readonly MAINTENANCE_WORK_MEM_CAP_MB=2048
readonly WORK_MEM_CAP_MB=32

# Additional caps for new parameters
readonly WORK_MEM_DW_CAP_MB=256
readonly OS_RESERVE_MB=512
readonly CONNECTION_OVERHEAD_PER_CONN_MB=10

# Fixed parameters
readonly CHECKPOINT_COMPLETION_TARGET="0.9"
readonly DEFAULT_STATISTICS_TARGET_DW=500
readonly DEFAULT_STATISTICS_TARGET_STANDARD=100

# Workload type lookup tables (associative arrays)
declare -A WORKLOAD_MAX_CONN=(
    [web]=200
    [oltp]=300
    [dw]=100
    [mixed]=120
)

declare -A WORKLOAD_MIN_WAL_MB=(
    [web]=1024
    [oltp]=2048
    [dw]=4096
    [mixed]=1024
)

declare -A WORKLOAD_MAX_WAL_MB=(
    [web]=4096
    [oltp]=8192
    [dw]=16384
    [mixed]=4096
)

# Storage type lookup tables
declare -A STORAGE_RANDOM_COST=(
    [ssd]=1.1
    [san]=1.1
    [hdd]=4.0
)

declare -A STORAGE_IO_CONCURRENCY=(
    [ssd]=200
    [san]=300
    [hdd]=2
)

declare -A STORAGE_MAINT_IO_CONCURRENCY=(
    [ssd]=20
    [san]=20
    [hdd]=10
)

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

get_workload_type() {
    local workload="${POSTGRES_WORKLOAD_TYPE:-mixed}"

    case "$workload" in
        web|oltp|dw|mixed)
            echo "$workload"
            ;;
        *)
            echo "[POSTGRES] WARNING: Invalid POSTGRES_WORKLOAD_TYPE='$workload' - defaulting to 'mixed'" >&2
            echo "mixed"
            ;;
    esac
}

get_storage_type() {
    local storage="${POSTGRES_STORAGE_TYPE:-ssd}"

    case "$storage" in
        ssd|hdd|san)
            echo "$storage"
            ;;
        *)
            echo "[POSTGRES] WARNING: Invalid POSTGRES_STORAGE_TYPE='$storage' - defaulting to 'ssd'" >&2
            echo "ssd"
            ;;
    esac
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

calculate_max_connections() {
    local workload=$(get_workload_type)
    local base_conn=${WORKLOAD_MAX_CONN[$workload]}

    # Scale for small VPS (shared resources)
    if [ "$TOTAL_RAM_MB" -lt 2048 ]; then
        base_conn=$(( base_conn * 50 / 100 ))
    elif [ "$TOTAL_RAM_MB" -lt 4096 ]; then
        base_conn=$(( base_conn * 70 / 100 ))
    elif [ "$TOTAL_RAM_MB" -lt 8192 ]; then
        base_conn=$(( base_conn * 85 / 100 ))
    fi

    # Minimum 20 connections
    [ "$base_conn" -lt 20 ] && base_conn=20

    echo "$base_conn"
}

MAX_CONNECTIONS=$(calculate_max_connections)

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
    # Account for OS (512MB minimum) + other services (20% of RAM)
    local other_usage=$(( TOTAL_RAM_MB * 20 / 100 ))
    [ "$other_usage" -lt "$OS_RESERVE_MB" ] && other_usage=$OS_RESERVE_MB

    # Available for OS page cache
    local cache_avail=$(( TOTAL_RAM_MB - SHARED_BUFFERS_MB - other_usage ))

    # Use 70% of that (conservative)
    local value=$(( cache_avail * 70 / 100 ))

    # Minimum: 2× shared_buffers
    local min_value=$(( SHARED_BUFFERS_MB * 2 ))
    [ "$value" -lt "$min_value" ] && value=$min_value
    [ "$value" -lt 0 ] && value=0

    echo "$value"
}

calculate_maintenance_work_mem() {
    local workload=$(get_workload_type)
    local value

    if [ "$workload" = "dw" ]; then
        # DW: 12.5% of RAM
        value=$(( TOTAL_RAM_MB / 8 ))
    else
        # Others: 6.25% of RAM
        value=$(( TOTAL_RAM_MB / 16 ))
    fi

    [ "$value" -lt 32 ] && value=32
    [ "$value" -gt "$MAINTENANCE_WORK_MEM_CAP_MB" ] && value=$MAINTENANCE_WORK_MEM_CAP_MB

    echo "$value"
}

calculate_work_mem() {
    local workload=$(get_workload_type)

    # Account for connection overhead (10MB per connection)
    local conn_overhead=$(( MAX_CONNECTIONS * CONNECTION_OVERHEAD_PER_CONN_MB ))

    # Available memory pool
    local pool=$(( TOTAL_RAM_MB - SHARED_BUFFERS_MB - conn_overhead - OS_RESERVE_MB ))

    # Safety floor
    [ "$pool" -lt 256 ] && pool=256

    # Divide by connections × operations × safety margin
    local divisor=$(( MAX_CONNECTIONS * 4 ))
    [ "$divisor" -lt 1 ] && divisor=1

    local value=$(( pool / divisor ))

    # Minimum 1MB
    [ "$value" -lt 1 ] && value=1

    # RAM-tiered caps based on workload
    local cap=$WORK_MEM_CAP_MB

    if [ "$workload" = "dw" ] || [ "$workload" = "mixed" ]; then
        if [ "$TOTAL_RAM_MB" -ge 32768 ]; then
            cap=$WORK_MEM_DW_CAP_MB  # 256MB for 32GB+ RAM
        elif [ "$TOTAL_RAM_MB" -ge 8192 ]; then
            cap=128  # 128MB for 8-32GB RAM
        elif [ "$TOTAL_RAM_MB" -ge 2048 ]; then
            cap=64   # 64MB for 2-8GB RAM
        fi
    fi

    [ "$value" -gt "$cap" ] && value=$cap

    echo "$value"
}

calculate_wal_buffers() {
    # wal_buffers = 3% of shared_buffers, min 32KB (expressed as fraction of MB), max 16MB
    local value=$(( (SHARED_BUFFERS_MB * 3) / 100 ))

    # Minimum: 32KB = 0.03125 MB, but we work in MB, so minimum 1MB is practical
    [ "$value" -lt 1 ] && value=1

    # Maximum: 16MB
    [ "$value" -gt 16 ] && value=16

    # Special rounding: if between 14-16MB, round up to 16MB
    if [ "$value" -gt 14 ] && [ "$value" -lt 16 ]; then
        value=16
    fi

    echo "$value"
}

calculate_io_workers() {
    # io_workers: scale with CPU cores, minimum 1 for small systems
    local value=$(( CPU_CORES / 4 ))
    
    # Minimum: 1 (allow small systems), Maximum: 64
    [ "$value" -lt 1 ] && value=1
    [ "$value" -gt 64 ] && value=64
    echo "$value"
}

SHARED_BUFFERS_MB=$(calculate_shared_buffers)
EFFECTIVE_CACHE_MB=$(calculate_effective_cache)
MAINTENANCE_WORK_MEM_MB=$(calculate_maintenance_work_mem)
WORK_MEM_MB=$(calculate_work_mem)

# Leave CPU headroom for other services
# For smaller systems (<=4 cores): CPU + 1
# For larger systems: CPU × 1.5
if [ "$CPU_CORES" -le 4 ]; then
    MAX_WORKER_PROCESSES=$(( CPU_CORES + 1 ))
else
    MAX_WORKER_PROCESSES=$(( CPU_CORES + CPU_CORES / 2 ))
fi
[ "$MAX_WORKER_PROCESSES" -lt 2 ] && MAX_WORKER_PROCESSES=2
[ "$MAX_WORKER_PROCESSES" -gt 64 ] && MAX_WORKER_PROCESSES=64

# Set parallel workers based on CPU cores
# For <4 cores: limit parallel workers to prevent resource exhaustion
if [ "$CPU_CORES" -ge 4 ]; then
    MAX_PARALLEL_WORKERS=$CPU_CORES
    MAX_PARALLEL_WORKERS_PER_GATHER=$(( CPU_CORES / 2 ))
    [ "$MAX_PARALLEL_WORKERS_PER_GATHER" -lt 1 ] && MAX_PARALLEL_WORKERS_PER_GATHER=1

    # PostgreSQL 11+ feature
    MAX_PARALLEL_MAINTENANCE_WORKERS=$(( CPU_CORES / 2 ))
    [ "$MAX_PARALLEL_MAINTENANCE_WORKERS" -gt 4 ] && MAX_PARALLEL_MAINTENANCE_WORKERS=4
else
    # Low-core systems: set conservative parallel worker limits
    MAX_PARALLEL_WORKERS=$CPU_CORES
    MAX_PARALLEL_WORKERS_PER_GATHER=1
    MAX_PARALLEL_MAINTENANCE_WORKERS=1
fi

# Calculate new parameters
WORKLOAD_TYPE=$(get_workload_type)
STORAGE_TYPE=$(get_storage_type)

WAL_BUFFERS_MB=$(calculate_wal_buffers)
IO_WORKERS=$(calculate_io_workers)

# Workload-based parameters
MIN_WAL_SIZE_MB=${WORKLOAD_MIN_WAL_MB[$WORKLOAD_TYPE]}
MAX_WAL_SIZE_MB=${WORKLOAD_MAX_WAL_MB[$WORKLOAD_TYPE]}

if [ "$WORKLOAD_TYPE" = "dw" ]; then
    DEFAULT_STATISTICS_TARGET=$DEFAULT_STATISTICS_TARGET_DW
else
    DEFAULT_STATISTICS_TARGET=$DEFAULT_STATISTICS_TARGET_STANDARD
fi

# Storage-based parameters
RANDOM_PAGE_COST=${STORAGE_RANDOM_COST[$STORAGE_TYPE]}
MAINTENANCE_IO_CONCURRENCY=${STORAGE_MAINT_IO_CONCURRENCY[$STORAGE_TYPE]}

# Linux-only parameter
if [ "$(uname -s)" = "Linux" ]; then
    EFFECTIVE_IO_CONCURRENCY=${STORAGE_IO_CONCURRENCY[$STORAGE_TYPE]}
else
    EFFECTIVE_IO_CONCURRENCY=""
fi

SHARED_PRELOAD_LIBRARIES=${POSTGRES_SHARED_PRELOAD_LIBRARIES:-$DEFAULT_SHARED_PRELOAD_LIBRARIES}

# WAL level configuration (logical for CDC, replica for replication, minimal for single-node)
# Default: logical (safest, enables CDC extensions like wal2json)
# Override: Set POSTGRES_WAL_LEVEL to 'minimal' (single-node) or 'replica' (read replica)
WAL_LEVEL=${POSTGRES_WAL_LEVEL:-logical}

# Validate wal_level value
case "$WAL_LEVEL" in
    minimal|replica|logical)
        ;;
    *)
        echo "[POSTGRES] ERROR: Invalid POSTGRES_WAL_LEVEL='$WAL_LEVEL' (must be: minimal, replica, or logical)" >&2
        exit 1
        ;;
esac

# Override listen_addresses based on POSTGRES_BIND_IP
# Default: 127.0.0.1 (localhost only, secure)
# Network replication: Set POSTGRES_BIND_IP to specific IP or 0.0.0.0 for all interfaces
LISTEN_ADDR="${POSTGRES_BIND_IP:-127.0.0.1}"
# Always set listen_addresses explicitly to prevent PostgreSQL's default of '*'
if [ "$LISTEN_ADDR" != "127.0.0.1" ]; then
    echo "[POSTGRES] [AUTO-CONFIG] Network mode enabled → listen_addresses=${LISTEN_ADDR}"
else
    echo "[POSTGRES] [AUTO-CONFIG] Secure mode (localhost only) → listen_addresses=${LISTEN_ADDR}"
fi

echo "[POSTGRES] [AUTO-CONFIG] RAM: ${TOTAL_RAM_MB}MB ($RAM_SOURCE), CPU: ${CPU_CORES} cores ($CPU_SOURCE), Workload: ${WORKLOAD_TYPE}, Storage: ${STORAGE_TYPE} → shared_buffers=${SHARED_BUFFERS_MB}MB, effective_cache_size=${EFFECTIVE_CACHE_MB}MB, maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB, work_mem=${WORK_MEM_MB}MB, max_connections=${MAX_CONNECTIONS}, wal_buffers=${WAL_BUFFERS_MB}MB, checkpoint_completion_target=${CHECKPOINT_COMPLETION_TARGET}, min_wal_size=${MIN_WAL_SIZE_MB}MB, max_wal_size=${MAX_WAL_SIZE_MB}MB, random_page_cost=${RANDOM_PAGE_COST}, default_statistics_target=${DEFAULT_STATISTICS_TARGET}, io_workers=${IO_WORKERS}, wal_level=${WAL_LEVEL}"

set -- "$@" \
    -c "shared_buffers=${SHARED_BUFFERS_MB}MB" \
    -c "effective_cache_size=${EFFECTIVE_CACHE_MB}MB" \
    -c "maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB" \
    -c "work_mem=${WORK_MEM_MB}MB" \
    -c "max_connections=${MAX_CONNECTIONS}" \
    -c "max_worker_processes=${MAX_WORKER_PROCESSES}" \
    -c "wal_level=${WAL_LEVEL}" \
    -c "shared_preload_libraries=${SHARED_PRELOAD_LIBRARIES}" \
    -c "cron.database_name=${POSTGRES_DB:-postgres}" \
    -c "checkpoint_completion_target=${CHECKPOINT_COMPLETION_TARGET}" \
    -c "wal_buffers=${WAL_BUFFERS_MB}MB" \
    -c "min_wal_size=${MIN_WAL_SIZE_MB}MB" \
    -c "max_wal_size=${MAX_WAL_SIZE_MB}MB" \
    -c "random_page_cost=${RANDOM_PAGE_COST}" \
    -c "default_statistics_target=${DEFAULT_STATISTICS_TARGET}" \
    -c "io_workers=${IO_WORKERS}" \
    -c "maintenance_io_concurrency=${MAINTENANCE_IO_CONCURRENCY}"

# Conditional parameters
if [ -n "$MAX_PARALLEL_WORKERS" ]; then
    set -- "$@" \
        -c "max_parallel_workers=${MAX_PARALLEL_WORKERS}" \
        -c "max_parallel_workers_per_gather=${MAX_PARALLEL_WORKERS_PER_GATHER}" \
        -c "max_parallel_maintenance_workers=${MAX_PARALLEL_MAINTENANCE_WORKERS}"
fi

if [ -n "$EFFECTIVE_IO_CONCURRENCY" ]; then
    set -- "$@" -c "effective_io_concurrency=${EFFECTIVE_IO_CONCURRENCY}"
fi

# wal_level=minimal requires max_wal_senders=0 (no replication)
if [ "$WAL_LEVEL" = "minimal" ]; then
    set -- "$@" -c "max_wal_senders=0"
fi

# Always apply listen_addresses explicitly (prevents PostgreSQL default of '*')
set -- "$@" -c "listen_addresses=${LISTEN_ADDR}"

exec /usr/local/bin/docker-entrypoint.sh "$@"
