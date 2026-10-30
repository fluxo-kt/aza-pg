#!/bin/bash
# AUTO-GENERATED FILE - DO NOT EDIT
# Generator: scripts/docker/generate-entrypoint.ts
# Template: docker/postgres/docker-auto-config-entrypoint.sh.template
# Manifest: docker/postgres/extensions.manifest.json
# To regenerate: bun run generate

# PostgreSQL Auto-Configuration Entrypoint
# Auto-detects RAM, CPU cores, and scales Postgres settings proportionally

set -euo pipefail

# The server and extensions are compiled for a CPU baseline (`baseline` in flake.nix: x86-64-v3, or Armv8.2-A with
# dot product, AES and SHA2). On an older CPU, or one whose hypervisor hides a feature, they would die with "illegal
# instruction" mid-query, so check the CPU before anything compiled for it runs. Only Bash builtins run here. These
# are /proc/cpuinfo's names for every feature GCC may emit for that baseline (x86-64-v3 includes v2: pni = SSE3,
# abm = LZCNT; Armv8.2-A includes 8.1's CRC32, LSE atomics and RDM); change both together. Take the list from the
# compiler, never from memory: `gcc -march=<baseline> -Q --help=target` prints every -m feature the target enables.
case "$HOSTTYPE" in
x86_64) required_cpu_features="cx16 lahf_lm popcnt pni sse4_1 sse4_2 ssse3 avx avx2 bmi1 bmi2 f16c fma abm movbe" ;;
aarch64) required_cpu_features="crc32 atomics asimdrdm asimddp aes sha2" ;;
*) required_cpu_features="" ;;
esac
cpu_features=""
while IFS= read -r line; do
    case "$line" in flags* | Features*) cpu_features=" ${line#*:} " && break ;; esac
done </proc/cpuinfo
missing_cpu_features=""
for feature in $required_cpu_features; do
    case "$cpu_features" in *" $feature "*) ;; *) missing_cpu_features+=" $feature" ;; esac
done
if [ -n "$missing_cpu_features" ]; then
    printf '%s\n' "[POSTGRES] ERROR: this CPU lacks features the image is compiled for:${missing_cpu_features}. It needs x86-64-v3 (Intel Haswell / AMD Zen or newer) or Armv8.2-A with dot product (Neoverse N1, Graviton2 or newer); if the host CPU has them, the hypervisor hides them (set the VM's CPU model to host)." >&2
    exit 1
fi

readonly DEFAULT_RAM_MB=1024

# Default preload set auto-generated from manifest (extensions with sharedPreload=true and defaultEnable=true).
# POSTGRES_SHARED_PRELOAD_LIBRARIES replaces this list (optional ones such as supautils are added that way).
# Note: pg_stat_monitor and pg_stat_statements can coexist in PG18 via pgsm aggregation
readonly DEFAULT_SHARED_PRELOAD_LIBRARIES="timescaledb,auto_explain,pg_cron,pg_net,pg_stat_monitor,pg_stat_statements,pgaudit,pgsodium,safeupdate,supabase_vault"

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

# PostgreSQL 18's initdb enables data checksums by default; they detect page corruption and let pg_rewind turn a
# failed primary into a replica. DISABLE_DATA_CHECKSUMS=true opts out (not recommended).
if [ "${DISABLE_DATA_CHECKSUMS:-false}" = "true" ]; then
    export POSTGRES_INITDB_ARGS="${POSTGRES_INITDB_ARGS:-} --no-data-checksums"
fi

# New clusters sort text with PostgreSQL's builtin provider: code-point order, defined by PostgreSQL itself, so a
# glibc or ICU upgrade never changes it and never forces a REINDEX. It is also the fastest comparison. PG_UNICODE_FAST
# gives full Unicode case mapping (upper('ß') = 'SS'). Language-aware order stays available per column or query with
# an ICU collation, e.g. COLLATE "en-US-x-icu". --locale=C.UTF-8 sets the libc categories to glibc's built-in locale.
# The operator's POSTGRES_INITDB_ARGS come last so their flags win (initdb takes the last value of a repeated flag).
# These settings are fixed once the cluster exists.
export POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale-provider=builtin --builtin-locale=PG_UNICODE_FAST --locale=C.UTF-8 ${POSTGRES_INITDB_ARGS:-}"

detect_ram() {
    local ram_mb=0
    local source="unknown"

    if [ -n "${POSTGRES_MEMORY:-}" ]; then
        # No leading zero: bash arithmetic reads 01024 as octal (532) and 08192 as an error.
        if ! [[ "${POSTGRES_MEMORY}" =~ ^[1-9][0-9]*$ ]]; then
            echo "[POSTGRES] ERROR: POSTGRES_MEMORY must be an integer value in MB: positive, without leading zeros" >&2
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
# Minimum 8 workers to support all background workers:
# TimescaleDB (2-3), pg_cron (1), logical replication (1), telemetry (1), plus headroom
# Allow override via POSTGRES_MAX_WORKER_PROCESSES environment variable
MAX_WORKER_PROCESSES=${POSTGRES_MAX_WORKER_PROCESSES:-$MAX_WORKER_PROCESSES}
[ "$MAX_WORKER_PROCESSES" -lt 8 ] && MAX_WORKER_PROCESSES=8
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
EFFECTIVE_IO_CONCURRENCY=${STORAGE_IO_CONCURRENCY[$STORAGE_TYPE]}

# The getkey script is never run here: on a new data directory it creates the key file, and initdb (which runs
# after this script) refuses a non-empty directory. Its failures surface when the server starts.
PG_SHAREDIR=$(pg_config --sharedir)
# A fixed path, not ${PG_SHAREDIR}: it is where docs/PGSODIUM-SETUP.md tells operators to mount their own script,
# and the Nix image's sharedir is a read-only store path. pgsodium.getkey_script below points the server at it.
PGSODIUM_GETKEY_PATH="/usr/share/postgresql/${PG_MAJOR}/extension/pgsodium_getkey"
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

# Logical decoding output plugins that slots may use. Since PostgreSQL 18.6 (CVE-2026-6471) any
# plugin missing from output_plugin_libraries is refused, superusers included, and the built-in
# default lists only pgoutput and test_decoding — the shipped wal2json would stop working for CDC.
# Keep pgoutput in any override (here, -c or ALTER SYSTEM): built-in logical replication needs it.
OUTPUT_PLUGIN_LIBRARIES=${POSTGRES_OUTPUT_PLUGIN_LIBRARIES:-pgoutput,test_decoding,wal2json}

# listen_addresses comes from POSTGRES_BIND_IP and defaults to 127.0.0.1. Inside a container that means only processes
# in the same container can connect: no published port and no other container reaches it. The default stays closed on
# purpose: `-p 5432:5432` publishes on every host interface and bypasses host firewalls such as ufw, so one copied
# `docker run` would expose the database. Reaching it takes an explicit POSTGRES_BIND_IP=0.0.0.0 (or a specific
# address), which the stacks set; the log line below names that fix, because the failure is otherwise only
# "connection refused".
LISTEN_ADDR="${POSTGRES_BIND_IP:-127.0.0.1}"
# Always set listen_addresses explicitly: initdb writes listen_addresses='*' into postgresql.conf
if [ "$LISTEN_ADDR" != "127.0.0.1" ]; then
    echo "[POSTGRES] [AUTO-CONFIG] Network mode enabled → listen_addresses=${LISTEN_ADDR}"
else
    echo "[POSTGRES] [AUTO-CONFIG] Secure mode (localhost only) → listen_addresses=${LISTEN_ADDR}; only this container can connect. Set POSTGRES_BIND_IP=0.0.0.0 to accept connections through a published port or from other containers"
fi

echo "[POSTGRES] [AUTO-CONFIG] RAM: ${TOTAL_RAM_MB}MB ($RAM_SOURCE), CPU: ${CPU_CORES} cores ($CPU_SOURCE), Workload: ${WORKLOAD_TYPE}, Storage: ${STORAGE_TYPE} → shared_buffers=${SHARED_BUFFERS_MB}MB, effective_cache_size=${EFFECTIVE_CACHE_MB}MB, maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB, work_mem=${WORK_MEM_MB}MB, max_connections=${MAX_CONNECTIONS}, wal_buffers=${WAL_BUFFERS_MB}MB, checkpoint_completion_target=${CHECKPOINT_COMPLETION_TARGET}, min_wal_size=${MIN_WAL_SIZE_MB}MB, max_wal_size=${MAX_WAL_SIZE_MB}MB, random_page_cost=${RANDOM_PAGE_COST}, default_statistics_target=${DEFAULT_STATISTICS_TARGET}, io_workers=${IO_WORKERS}, wal_level=${WAL_LEVEL}"

# pg_cron lives in the database initdb creates, which the official entrypoint resolves only after this script has
# run, with file_env: POSTGRES_DB (or the content of POSTGRES_DB_FILE), else the superuser's name, POSTGRES_USER (or
# POSTGRES_USER_FILE), else postgres. The same resolution is repeated here.
env_or_file() {
    local file_var="${1}_FILE"
    if [ -n "${!1:-}" ]; then printf '%s' "${!1}"; elif [ -n "${!file_var:-}" ]; then cat "${!file_var}"; fi
}
CRON_DATABASE="$(env_or_file POSTGRES_DB)"
CRON_DATABASE="${CRON_DATABASE:-$(env_or_file POSTGRES_USER)}"
CRON_DATABASE="${CRON_DATABASE:-postgres}"

AUTO_SETTINGS=(
    "shared_buffers=${SHARED_BUFFERS_MB}MB"
    "effective_cache_size=${EFFECTIVE_CACHE_MB}MB"
    "maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB"
    "work_mem=${WORK_MEM_MB}MB"
    "max_connections=${MAX_CONNECTIONS}"
    "max_worker_processes=${MAX_WORKER_PROCESSES}"
    "wal_level=${WAL_LEVEL}"
    "output_plugin_libraries=${OUTPUT_PLUGIN_LIBRARIES}"
    "shared_preload_libraries=${SHARED_PRELOAD_LIBRARIES}"
    "cron.database_name=${CRON_DATABASE}"
    "checkpoint_completion_target=${CHECKPOINT_COMPLETION_TARGET}"
    "wal_buffers=${WAL_BUFFERS_MB}MB"
    "min_wal_size=${MIN_WAL_SIZE_MB}MB"
    "max_wal_size=${MAX_WAL_SIZE_MB}MB"
    "random_page_cost=${RANDOM_PAGE_COST}"
    "default_statistics_target=${DEFAULT_STATISTICS_TARGET}"
    "io_workers=${IO_WORKERS}"
    "maintenance_io_concurrency=${MAINTENANCE_IO_CONCURRENCY}"
    "listen_addresses=${LISTEN_ADDR}"
    "max_parallel_workers=${MAX_PARALLEL_WORKERS}"
    "max_parallel_workers_per_gather=${MAX_PARALLEL_WORKERS_PER_GATHER}"
    "max_parallel_maintenance_workers=${MAX_PARALLEL_MAINTENANCE_WORKERS}"
    "effective_io_concurrency=${EFFECTIVE_IO_CONCURRENCY}"
    # Set explicitly so the path does not depend on how pgsodium resolves its share directory.
    "pgsodium.getkey_script=${PGSODIUM_GETKEY_PATH}"
    # Parallel queries and index builds keep their shared state in dynamic shared memory. PostgreSQL's Linux default,
    # posix, puts it in /dev/shm, which Docker, Kubernetes and CI runners mount at 64 MB: a parallel hash join or a
    # parallel pgvector HNSW build (sized by maintenance_work_mem) then fails with "could not resize shared memory
    # segment … No space left on device". System V segments come from RAM under the container's memory limit, the limit
    # auto-tuning already sizes against; a container's own IPC namespace has the kernel defaults (shmmax and shmall
    # effectively unlimited, 4096 segments). posix stays one -c away for --ipc=host on a host with low SysV limits.
    # Rejected: shm_size in compose (docker run and Kubernetes still fail; any size is a guess); mmap (writes the
    # shared pages to the data volume); serial builds when /dev/shm is small (hash joins still fail).
    "dynamic_shared_memory_type=sysv"
)
# wal_level=minimal requires max_wal_senders=0 (no replication)
if [ "$WAL_LEVEL" = "minimal" ]; then
    AUTO_SETTINGS+=("max_wal_senders=0")
fi

# Operator values beat auto-tuning, in PostgreSQL's own order (lowest first): the config file and its includes <
# postgresql.auto.conf (ALTER SYSTEM, also applied on reload) < command-line -c. So the tuned values go into a
# generated config file that first includes the operator's config file and then sets them: they beat postgresql.conf
# — where initdb writes max_connections, shared_buffers, max_wal_size, min_wal_size and listen_addresses='*' into every
# data directory, so letting it win would switch auto-tuning off — while ALTER SYSTEM and the operator's own -c win.
# data_directory and hba_file defaults derive from -D/PGDATA, not from config_file, so they stay where they were.
shift # "postgres"
DATA_DIR="${PGDATA:-}"
OPERATOR_CONFIG=""
declare -A OPERATOR_SET=() # setting name → value the operator passed on the command line
OPERATOR_ARGS=()
STARTS_SERVER=true # false for postgres options that print and exit (upstream's _pg_want_help list, plus -C)
while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
        -c) pair="${1:-}"; [ "$#" -gt 0 ] && shift ;;
        -c*) pair="${arg#-c}" ;;
        --*=*) pair="${arg#--}" ;;
        -C* | -'?' | --help | --describe-config | -V | --version) STARTS_SERVER=false; OPERATOR_ARGS+=("$arg"); continue ;;
        -D) DATA_DIR="${1:-}"; OPERATOR_ARGS+=("$arg" "${1:-}"); [ "$#" -gt 0 ] && shift; continue ;;
        *) OPERATOR_ARGS+=("$arg"); continue ;;
    esac
    # PostgreSQL accepts --config-file and -c config_file alike, and matches names case-insensitively.
    name="${pair%%=*}"
    name="${name//-/_}"
    name="${name,,}"
    if [ "$name" = "config_file" ]; then
        OPERATOR_CONFIG="${pair#*=}"
        continue
    fi
    OPERATOR_SET[$name]="${pair#*=}"
    OPERATOR_ARGS+=(-c "$pair")
done
OPERATOR_CONFIG="${OPERATOR_CONFIG:-${DATA_DIR}/postgresql.conf}"

as_postgres() { if [ "$(id -u)" = 0 ]; then gosu postgres "$@"; else "$@"; fi; }

# pgsodium root key, read by the image's pgsodium_getkey (its header explains where it lives). The operator's
# PGSODIUM_KEY_FILE is checked here so a wrong path or content stops the container naming it, before the
# server would stop on it with a less direct message.
# Images before per-database keys shipped one fixed key, published in this repository. A data directory they
# created may hold data encrypted with it, and a new key would make that data unreadable, so it keeps that key
# as its key file and every start warns until the operator rotates it (docs/PGSODIUM-SETUP.md).
# An operator who mounts their own pgsodium_getkey owns the key, so none of this applies: the image's script
# differs from the pristine copy the image keeps beside it.
readonly PUBLISHED_PGSODIUM_KEY=4670bdf714d653c15779e67e0bb6012f1e229c86edbdf75285f3c592670cece2
pgsodium_key_file=""
if cmp -s "$PGSODIUM_GETKEY_PATH" /usr/local/share/aza-pg/pgsodium_getkey; then
    image_getkey=true
elif [ $? -eq 1 ]; then
    image_getkey=false
else # cmp could not read one of them: the image is broken, and guessing either way could pick the wrong key
    printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: cannot compare pgsodium_getkey with the image's copy" >&2
    exit 1
fi
if [ "$image_getkey" = false ]; then
    : # the operator's getkey owns the key: nothing to check, write or warn about
elif [ -n "${PGSODIUM_KEY_FILE:-}" ]; then
    operator_key=$(as_postgres cat "$PGSODIUM_KEY_FILE" 2>/dev/null | tr -d '[:space:]' || true)
    if ! [[ "$operator_key" =~ ^[0-9a-fA-F]{64}$ ]]; then
        printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: PGSODIUM_KEY_FILE=${PGSODIUM_KEY_FILE} must be readable by postgres and hold 64 hex characters; create one with: head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \\n'" >&2
        exit 1
    fi
    pgsodium_key_file="$PGSODIUM_KEY_FILE"
    # An existing data directory already has a key, and data encrypted under it is unreadable under any other, so
    # the file must hold that same key. Its key is the data-directory key file when present, else (a directory made
    # by an image that predates per-database keys and never started on a later one) the published key. A directory
    # created with PGSODIUM_KEY_FILE has no key the entrypoint can read; one created with the operator's own
    # getkey needs that getkey.
    key_source=$(as_postgres cat "${PGDATA}/pgsodium_key_source" 2>/dev/null || true)
    if [ ! -f "${PGDATA}/PG_VERSION" ] || [ "$key_source" = "PGSODIUM_KEY_FILE" ]; then
        :
    elif [ "$key_source" = "pgsodium_getkey" ]; then
        printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: this data directory was created with your own pgsodium_getkey, which is not mounted now; mount it again (docs/PGSODIUM-SETUP.md)" >&2
        exit 1
    else
        directory_key_file="${PGDATA}/pgsodium_root.key"
        if [ -e "$directory_key_file" ]; then
            directory_key=$(as_postgres cat "$directory_key_file" 2>/dev/null | tr -d '[:space:]' || true)
            directory_key_name="the key in ${directory_key_file}"
        elif [ -z "$key_source" ]; then
            directory_key="$PUBLISHED_PGSODIUM_KEY"
            directory_key_name="the key older aza-pg images published"
        else
            printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: ${directory_key_file} is missing, but this data directory was created with it; restore it from a backup: data encrypted under it cannot be read without it (docs/PGSODIUM-SETUP.md)" >&2
            exit 1
        fi
        if [ "${operator_key,,}" != "${directory_key,,}" ]; then
            printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: PGSODIUM_KEY_FILE=${PGSODIUM_KEY_FILE} holds a different key than this data directory uses (${directory_key_name}); data encrypted under that key would be unreadable. Put that key in the file, or unset PGSODIUM_KEY_FILE; to change the key, see docs/PGSODIUM-SETUP.md, section \"Rotating the published key\"" >&2
            exit 1
        fi
        # The same key: from now on it comes from the operator's file, so the copy in the data directory may go.
        # shellcheck disable=SC2016 # $1 is the inner sh's argument
        as_postgres sh -c 'printf "%s\n" PGSODIUM_KEY_FILE > "$1"' sh "${PGDATA}/pgsodium_key_source"
    fi
else
    pgsodium_key_file="${PGDATA}/pgsodium_root.key"
    if [ -f "${PGDATA}/PG_VERSION" ] && [ ! -e "$pgsodium_key_file" ]; then
        # Data directories this image creates record their key's home (initdb script 00-pgsodium-key.sh); with that
        # record present a missing key is an operator error, and the published key would silently replace it.
        key_source=$(as_postgres cat "${PGDATA}/pgsodium_key_source" 2>/dev/null || true)
        if [ "$key_source" = "PGSODIUM_KEY_FILE" ]; then
            printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: this data directory was created with PGSODIUM_KEY_FILE, which is not set now; set it to the same key file (docs/PGSODIUM-SETUP.md)" >&2
            exit 1
        elif [ "$key_source" = "pgsodium_getkey" ]; then
            printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: this data directory was created with your own pgsodium_getkey, which is not mounted now; mount it again (docs/PGSODIUM-SETUP.md)" >&2
            exit 1
        elif [ -n "$key_source" ]; then
            printf '%s\n' "[POSTGRES] [AUTO-CONFIG] ERROR: ${pgsodium_key_file} is missing, but this data directory was created with it; restore it from a backup: data encrypted under it cannot be read without it (docs/PGSODIUM-SETUP.md)" >&2
            exit 1
        fi
        # shellcheck disable=SC2016 # $1/$2 are the inner sh's arguments
        as_postgres sh -c 'umask 077 && printf "%s\n" "$1" > "$2"' sh "$PUBLISHED_PGSODIUM_KEY" "$pgsodium_key_file"
    fi
fi
current_key=""
[ -z "$pgsodium_key_file" ] || current_key=$(as_postgres cat "$pgsodium_key_file" 2>/dev/null | tr -d '[:space:]' || true)
if [ "${current_key,,}" = "$PUBLISHED_PGSODIUM_KEY" ]; then
    echo "[POSTGRES] [AUTO-CONFIG] WARNING: pgsodium uses the key older aza-pg images published (${pgsodium_key_file}); anyone can decrypt data encrypted with it. Rotate it: docs/PGSODIUM-SETUP.md, section \"Rotating the published key\"" >&2
fi

# A config-file string literal doubles single quotes and treats backslash as an escape character.
conf_quote() {
    local q="'" text="${1//\\/\\\\}"
    printf "'%s'" "${text//$q/$q$q}"
}

# /var/run/postgresql is PostgreSQL's socket directory, writable even on read-only root filesystems.
AUTO_CONFIG_DIR=/var/run/postgresql
[ -w "$AUTO_CONFIG_DIR" ] || AUTO_CONFIG_DIR="${TMPDIR:-/tmp}"
AUTO_CONFIG_FILE="${AUTO_CONFIG_DIR}/aza-auto-config.conf"
{
    echo "# Written at every start by docker-auto-config-entrypoint.sh; edits here are lost."
    echo "# Override a value with ALTER SYSTEM or -c name=value; postgresql.conf values below are replaced."
    # Later lines win, so the order is the precedence: aza-pg's base settings (logging, telemetry off, …) for every
    # container, then the operator's file, then auto-tuning. A plain include, not include_if_exists: the image ships
    # the file, and a missing one should stop the server rather than silently drop the base settings.
    echo "include '/etc/postgresql/postgresql-base.conf'"
    echo "include $(conf_quote "$OPERATOR_CONFIG")"
    for setting in "${AUTO_SETTINGS[@]}"; do
        echo "${setting%%=*} = $(conf_quote "${setting#*=}")"
    done
} > "$AUTO_CONFIG_FILE"
chmod 0644 "$AUTO_CONFIG_FILE"

# One log line per tuned setting that does not take the tuned value, so no operator value is silently overridden
# or silently ignored. postgresql.conf values are compared through `postgres -C`, which prints PostgreSQL's base
# units (8kB pages, kB) and needs an initialised data directory, so the check skips the very first start. A file
# value equal to what initdb writes is indistinguishable from initdb's own lines, and one equal to the tuned value
# changes nothing; neither is reported. initdb writes the image's postgresql.conf.sample (listen_addresses = '*' — the
# official image sets it there) plus lines holding the built-in default (max_connections = 100, …), so that sample is
# the baseline.
ALTER_SYSTEM_FILE="${DATA_DIR}/postgresql.auto.conf"
for setting in "${AUTO_SETTINGS[@]}"; do
    name="${setting%%=*}"
    tuned="${setting#*=}"
    if [ -n "${OPERATOR_SET[$name]+set}" ]; then
        echo "[POSTGRES] [AUTO-CONFIG] ${name}: -c ${OPERATOR_SET[$name]} overrides auto-tuned ${tuned}"
        continue
    fi
    # postgresql.auto.conf is written by PostgreSQL itself, one "name = 'value'" line per setting.
    altered=$(awk -F ' = ' -v n="$name" '$1 == n { v = $2 } END { print v }' "$ALTER_SYSTEM_FILE" 2>/dev/null || true)
    if [ -n "$altered" ]; then
        echo "[POSTGRES] [AUTO-CONFIG] ${name}: ALTER SYSTEM ${altered} overrides auto-tuned ${tuned}"
        continue
    fi
    [ -f "${DATA_DIR}/PG_VERSION" ] || continue
    in_file=$(as_postgres postgres -D "$DATA_DIR" -c "config_file=${OPERATOR_CONFIG}" -C "$name" 2>/dev/null) || continue
    initdb_value=$(as_postgres postgres -D "$DATA_DIR" -c "config_file=${PG_SHAREDIR}/postgresql.conf.sample" -C "$name" 2>/dev/null) || continue
    [ "$in_file" != "$initdb_value" ] || continue
    applied=$(as_postgres postgres -D "$DATA_DIR" -c config_file=/dev/null -c "${name}=${tuned}" -C "$name" 2>/dev/null) || applied="$tuned"
    if [ "$in_file" != "$applied" ]; then
        echo "[POSTGRES] [AUTO-CONFIG] ${name}: ${in_file} from ${OPERATOR_CONFIG} is ignored, auto-tuned ${applied} applies (base units; override with ALTER SYSTEM or -c)"
    fi
done

# A server recovering WAL (standby.signal: a replica; recovery.signal: a backup restore) refuses to start with
# "insufficient parameter settings" when any of these five is below the value the primary ran with: they size
# shared-memory arrays that replayed WAL must fit into. pg_control records the primary's values. Auto-tuning sizes
# max_connections and max_worker_processes from this container's RAM and CPUs, so a replica smaller than its primary
# never started. Each one below the primary's is raised to it, as -c after every operator argument because nothing
# lower can work; `postgres -C` with the same arguments gives the value the server would otherwise use.
RAISE_ARGS=()
if [ -f "${DATA_DIR}/standby.signal" ] || [ -f "${DATA_DIR}/recovery.signal" ]; then
    controldata=$(as_postgres pg_controldata -D "$DATA_DIR")
    for pair in max_connections:max_connections max_worker_processes:max_worker_processes \
        max_wal_senders:max_wal_senders max_prepared_transactions:max_prepared_xacts \
        max_locks_per_transaction:max_locks_per_xact; do
        name="${pair%%:*}"
        primary=$(awk -F ': *' -v l="${pair#*:} setting" '$1 == l { print $2 }' <<<"$controldata")
        current=$(as_postgres postgres -D "$DATA_DIR" -c "config_file=${AUTO_CONFIG_FILE}" "${OPERATOR_ARGS[@]}" -C "$name")
        if ! [[ "$primary" =~ ^[0-9]+$ && "$current" =~ ^[0-9]+$ ]]; then
            echo "[POSTGRES] [AUTO-CONFIG] ERROR: cannot compare ${name} with the primary's (pg_controldata: '${primary}', postgres -C: '${current}'); the line format of pg_controldata -D ${DATA_DIR} may have changed" >&2
            exit 1
        fi
        if [ "$current" -lt "$primary" ]; then
            echo "[POSTGRES] [AUTO-CONFIG] ${name}: raised from ${current} to the primary's ${primary} (recovery cannot start below it)"
            RAISE_ARGS+=(-c "${name}=${primary}")
        fi
    done
fi

# The first start on a different image fixes, before the server serves clients, what an image change breaks in an
# existing data directory. The data directory records the image it last did this for (aza-pg-image); the key is the
# resolved server binary (in the Nix image a store path, which changes with glibc, ICU or anything else it links) plus
# TimescaleDB's version (constant paths on Debian), so other starts cost one file read. A private socket and a
# trust-only hba_file keep clients out and need no password whatever pg_hba.conf says. Standbys get both fixes through
# WAL from their primary; a restore gets them on the next start once it has finished. Connections go to database
# postgres, as pgflow-upgrade's do: releases made template1 refuse connections.
# 1. TimescaleDB's loader opens the library of each database's INSTALLED version (timescaledb-<version>.so) and the
#    image ships only its own, so a database on an older one fails every statement except
#    `ALTER EXTENSION timescaledb UPDATE`, which must be the session's first and needs timescaledb preloaded (hence the
#    image's config file). VERBOSITY=sqlstate makes "not installed in this database" (42704) exact; it is the last
#    line, after any connection-time warning, which client_min_messages does not reach.
# 2. A libc collation's version is glibc's, and glibc can change sort order between versions (2.28 did), so a text
#    index built under the old glibc can silently miss rows under the new one. en_US.utf8 (every release's default)
#    between glibc versions measured to sort it the same only records the new version, so the move from Debian's
#    glibc to the Nix image's costs no rebuild. Any other libc collation version change rebuilds every index
#    that orders, or filters, by such a collation, then records the new version: correct by construction, at the cost
#    of startup time. Range partitions and CHECKs that compare text in that order cannot be rebuilt, so they stop the
#    container naming the fix. One DO per database: all of it lands or none. ICU collations are left alone: their
#    versions track order changes too, and PostgreSQL warns where one is used.
IMAGE_MIGRATED_FILE="${DATA_DIR}/aza-pg-image"
REBUILD_FOR_GLIBC=$(cat <<'SQL'
DO $$DECLARE same text[] := '{2.41,2.44}'; colls oid[]; idx regclass[]; i regclass; c regcollation; bad text; BEGIN
    -- en_US between glibc versions in "same" only records the version; refreshed first, they are no longer stale
    -- below, so only unmeasured changes are rebuilt. A version joins "same" only on a "same" verdict from
    -- scripts/nix/compare-en-us-order.ts, which sorts in PostgreSQL itself: any other sorter (coreutils sort, ICU,
    -- a language runtime) orders differently and measures nothing about these indexes. A wrong entry corrupts silently.
    FOR c IN SELECT oid FROM pg_collation WHERE collprovider = 'c' AND collcollate LIKE 'en\_US.%'
        AND collversion <> pg_collation_actual_version(oid) AND collversion = ANY (same)
        AND pg_collation_actual_version(oid) = ANY (same) LOOP
        EXECUTE format('ALTER COLLATION %s REFRESH VERSION', c);
    END LOOP;
    IF (SELECT datlocprovider = 'c' AND datcollate LIKE 'en\_US.%' AND datcollversion <> pg_database_collation_actual_version(oid)
            AND datcollversion = ANY (same) AND pg_database_collation_actual_version(oid) = ANY (same)
            FROM pg_database WHERE datname = current_database()) THEN
        EXECUTE format('ALTER DATABASE %I REFRESH COLLATION VERSION', current_database());
    END IF;
    SELECT array_agg(oid) INTO colls FROM pg_collation
        WHERE collprovider = 'c' AND collversion IS DISTINCT FROM pg_collation_actual_version(oid);
    IF (SELECT datlocprovider = 'c' AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
            FROM pg_database WHERE datname = current_database()) THEN
        colls := colls || 100::oid; -- "default": the collation of the database itself
    END IF;
    IF colls IS NULL THEN RETURN; END IF;
    SELECT string_agg(o, ', ') INTO bad FROM (
        SELECT format('range partitioning of %s', partrelid::regclass) o FROM pg_partitioned_table
            WHERE partstrat = 'r' AND partcollation::oid[] && colls
        UNION ALL
        SELECT format('CHECK %I on %s', con.conname, con.conrelid::regclass) FROM pg_constraint con
            WHERE con.contype = 'c' AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = con.conrelid
                AND a.attnum = ANY (con.conkey) AND a.attcollation = ANY (colls))
            -- Operators come from the stored expression: pg_depend records none on builtin (pinned) operators.
            AND EXISTS (SELECT FROM regexp_matches(con.conbin::text, ':opno (\d+)', 'g') m JOIN pg_operator op
                ON op.oid = m[1]::oid JOIN pg_type t ON t.oid = op.oprleft
                WHERE op.oprname IN ('<', '<=', '>', '>=') AND t.typcollation <> 0)) s;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'database %: % compare text in a libc collation order that changed with glibc, and no rebuild re-sorts them. Re-create them (docs/UPGRADING.md), then start the container again', current_database(), bad;
    END IF;
    -- Key or expression collations, plus every column an index reads (the predicate of a partial index included).
    SELECT array_agg(DISTINCT x.indexrelid::regclass) INTO idx FROM pg_index x WHERE x.indcollation::oid[] && colls
        OR EXISTS (SELECT FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
            WHERE d.classid = 'pg_class'::regclass AND d.objid = x.indexrelid AND d.refclassid = 'pg_class'::regclass
            AND a.attcollation = ANY (colls));
    PERFORM set_config('client_min_messages', 'notice', true);
    RAISE NOTICE '[POSTGRES] [AUTO-CONFIG] database %: glibc changed its libc collation order; rebuilt % index(es) that depend on it', current_database(), coalesce(cardinality(idx), 0);
    FOREACH i IN ARRAY coalesce(idx, '{}') LOOP EXECUTE format('REINDEX INDEX %s', i); END LOOP;
    FOR c IN SELECT oid FROM pg_collation WHERE oid = ANY (colls) AND oid <> 100 LOOP
        EXECUTE format('ALTER COLLATION %s REFRESH VERSION', c);
    END LOOP;
    IF 100 = ANY (colls) THEN EXECUTE format('ALTER DATABASE %I REFRESH COLLATION VERSION', current_database()); END IF;
END$$
SQL
)
timescaledb_version=$(sed -n "s/^default_version = '\(.*\)'$/\1/p" "${PG_SHAREDIR}/extension/timescaledb.control" 2>/dev/null || true)
image_key="$(readlink -f "$(command -v postgres)") ${timescaledb_version}"
migrate_sql() { # database, then psql arguments; failures are collected, the container stops after the server does
    local db="$1" out
    shift
    out=$(PGOPTIONS="-c client_min_messages=error" as_postgres psql -X -q -h "$update_dir" -d "$db" -v ON_ERROR_STOP=1 "$@" 2>&1) ||
        { [ "${out##*$'\n'}" = "ERROR:  42704" ] && return; update_failed+="${db}: ${out}"$'\n'; return; }
    [ -z "$out" ] || printf '%s\n' "${out//NOTICE:  /}" >&2 # REBUILD_FOR_GLIBC's report
}
migrate_database() {
    migrate_sql "$1" -v VERBOSITY=sqlstate -c "ALTER EXTENSION timescaledb UPDATE"
    migrate_sql "$1" -c "$REBUILD_FOR_GLIBC"
}
if [ "$STARTS_SERVER" = true ] && [ -f "${DATA_DIR}/PG_VERSION" ] && [ ! -f "${DATA_DIR}/standby.signal" ] &&
    [ ! -f "${DATA_DIR}/recovery.signal" ] && [ "$(as_postgres cat "$IMAGE_MIGRATED_FILE" 2>/dev/null)" != "$image_key" ]; then
    update_dir=$(as_postgres mktemp -d)
    # shellcheck disable=SC2016 # $1 is the inner sh's argument
    as_postgres sh -c 'printf "local all all trust\n" > "$1/pg_hba.conf"' sh "$update_dir"
    as_postgres pg_ctl -D "$DATA_DIR" -w -l "${update_dir}/server.log" -o "-c config_file=${AUTO_CONFIG_FILE} -c listen_addresses= -c unix_socket_directories=${update_dir} -c hba_file=${update_dir}/pg_hba.conf" start >/dev/null ||
        { cat "${update_dir}/server.log" >&2; exit 1; }
    update_failed=""
    echo "[POSTGRES] [AUTO-CONFIG] first start on this image: updating extensions and rebuilding indexes whose text order changed with glibc; clients wait until it is done" >&2
    # postgres first: until then an older timescaledb there fails the queries below too. A command substitution, not
    # `< <(…)`: a failed listing must stop the container, never read as "no databases". template0 records no version.
    migrate_database postgres
    # A database refusing connections (releases made template1 so) only records the version: no session ever put a
    # user index in it, and catalog indexes sort by C, which glibc does not change.
    migrate_sql postgres -c "DO \$\$DECLARE d name; BEGIN
        FOR d IN SELECT datname FROM pg_database WHERE NOT datallowconn AND datlocprovider = 'c'
            AND datcollversion <> pg_database_collation_actual_version(oid) LOOP
            EXECUTE format('ALTER DATABASE %I REFRESH COLLATION VERSION', d);
        END LOOP; END\$\$"
    databases=$(PGOPTIONS="-c client_min_messages=error" as_postgres psql -X -h "$update_dir" -d postgres -tA \
        -c "SELECT datname FROM pg_database WHERE datallowconn AND datname <> 'postgres'")
    while IFS= read -r db; do
        [ -z "$db" ] || migrate_database "$db"
    done <<<"$databases"
    as_postgres pg_ctl -D "$DATA_DIR" -w -m fast stop >/dev/null
    if [ -n "$update_failed" ]; then
        printf '%s\n%s' "[POSTGRES] [AUTO-CONFIG] ERROR: the first start on this image could not bring these databases up to it, so the server was not started; every step is idempotent and the next start retries them all:" "$update_failed" >&2
        exit 1
    fi
    # shellcheck disable=SC2016 # $1/$2/$3 are the inner sh's arguments
    as_postgres sh -c 'printf "%s\n" "$1" > "$2" && rm -rf "$3"' sh "$image_key" "$IMAGE_MIGRATED_FILE" "$update_dir"
    echo "[POSTGRES] [AUTO-CONFIG] data directory brought up to this image: TimescaleDB ${timescaledb_version:-absent}, en_US collation versions current"
fi

# Keep the superuser password out of the server's environment. Upstream file_env exports POSTGRES_PASSWORD (or the
# content of POSTGRES_PASSWORD_FILE) and its final `exec "$@"` hands it to postgres, so the postmaster kept the
# secret in /proc/<pid>/environ for its whole life, readable by any process running as postgres. The password is needed only while initialising an empty
# data directory, by functions in the same shell. Upstream supports being sourced (`_is_sourced`), so source it and
# un-export the variable right after docker_setup_env: init still sees it as a shell variable; exec'd postgres does
# not inherit it. Root is skipped on purpose: upstream then re-executes itself as postgres via gosu and needs the
# exported value, so a container started as root keeps upstream behaviour; the image's default user is postgres.
# Upstream is written for `set -Eeo pipefail`, not nounset: its functions test optional variables bare.
set +u
# shellcheck source=/dev/null
source /usr/local/bin/docker-entrypoint.sh
eval "upstream_$(declare -f docker_setup_env)"
docker_setup_env() {
    upstream_docker_setup_env
    if [ "$(id -u)" != 0 ]; then export -n POSTGRES_PASSWORD; fi
}
_main postgres -c "config_file=${AUTO_CONFIG_FILE}" "${OPERATOR_ARGS[@]}" "${RAISE_ARGS[@]}"
