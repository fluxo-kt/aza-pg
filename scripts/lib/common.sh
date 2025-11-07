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
