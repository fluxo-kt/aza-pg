#!/bin/bash
# Common library for aza-pg scripts
# Provides shared functions for Docker cleanup and logging
#
# Usage:
#   source "$(dirname "$0")/../lib/common.sh"
#   or
#   source "$(dirname "$0")/../../lib/common.sh"  (for nested scripts)

set -euo pipefail

# Color definitions for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Docker cleanup function
# Usage: docker_cleanup "container_name"
# Removes a Docker container by name, suppressing errors if it doesn't exist
docker_cleanup() {
    local container_name=${1:-}
    if [[ -z "$container_name" ]]; then
        log_error "docker_cleanup: container name is required"
        return 1
    fi
    docker rm -f "$container_name" >/dev/null 2>&1 || true
}

# Check if a command exists
# Usage: check_command "command_name"
# Returns: 0 if command exists, 1 if not found
check_command() {
    local cmd=${1:-}
    if [[ -z "$cmd" ]]; then
        log_error "check_command: command name is required"
        return 1
    fi

    if ! command -v "$cmd" &>/dev/null; then
        log_error "Required command not found: $cmd"
        return 1
    fi
    return 0
}

# Check if Docker daemon is running
# Usage: check_docker_daemon
# Returns: 0 if Docker daemon is running, 1 if not
check_docker_daemon() {
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker daemon is not running"
        return 1
    fi
    return 0
}

# Wait for PostgreSQL to be ready
# Usage: wait_for_postgres [host] [port] [user] [timeout] [container]
# If container is provided, runs pg_isready inside container (for Docker tests)
# Returns: 0 if PostgreSQL is ready, 1 if timeout exceeded
wait_for_postgres() {
    local host=${1:-localhost}
    local port=${2:-5432}
    local user=${3:-postgres}
    local timeout=${4:-60}
    local container=${5:-}

    # Validate timeout is a number
    if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
        log_error "Invalid timeout value: $timeout (must be a positive integer)"
        return 1
    fi

    # Validate port is a number
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
        log_error "Invalid port value: $port (must be a number between 1-65535)"
        return 1
    fi

    # Validate port range
    if [[ "$port" -lt 1 || "$port" -gt 65535 ]]; then
        log_error "Port out of range: $port (must be between 1-65535)"
        return 1
    fi

    log_info "Waiting for PostgreSQL at $host:$port (user: $user, timeout: ${timeout}s)..."

    local seconds_waited=0
    while [[ $seconds_waited -lt $timeout ]]; do
        # If container specified, check from inside container
        if [[ -n "$container" ]]; then
            if docker exec "$container" pg_isready -U "$user" >/dev/null 2>&1; then
                log_success "PostgreSQL is ready"
                return 0
            fi
        else
            # Check from host
            if pg_isready -h "$host" -p "$port" -U "$user" >/dev/null 2>&1; then
                log_success "PostgreSQL is ready at $host:$port"
                return 0
            fi
        fi

        sleep 2
        seconds_waited=$((seconds_waited + 2))
    done

    log_error "PostgreSQL not ready after ${timeout} seconds"
    return 1
}

# Container cleanup function for tests
# Usage: cleanup_test_container "container_name"
# Alias for docker_cleanup with explicit test-oriented naming
cleanup_test_container() {
    local container_name="$1"
    if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}\$"; then
        echo "Cleaning up container: $container_name"
        docker rm -f "$container_name" >/dev/null 2>&1 || true
    fi
}
