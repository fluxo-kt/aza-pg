#!/bin/bash
# Promote PostgreSQL replica to primary
#
# USAGE:
#   ./promote-replica.sh [OPTIONS]
#
# OPTIONS:
#   -c, --container NAME    Container name (default: postgres-replica)
#   -d, --data-dir PATH     Data directory path (default: /var/lib/postgresql/data)
#   -n, --no-backup         Skip backup before promotion (not recommended)
#   -y, --yes               Skip confirmation prompt
#   -h, --help              Show this help message
#
# DESCRIPTION:
#   Promotes a PostgreSQL replica to primary role by:
#   1. Verifying replica is in recovery mode
#   2. Creating backup of current state (optional)
#   3. Stopping the replica container
#   4. Promoting replica using pg_ctl promote
#   5. Updating configuration for primary role
#   6. Restarting as primary
#
# EXAMPLES:
#   # Promote default replica container
#   ./promote-replica.sh
#
#   # Promote specific container without confirmation
#   ./promote-replica.sh -c my-replica -y
#
#   # Promote without backup (fast, risky)
#   ./promote-replica.sh -n -y
#
# PREREQUISITES:
#   - Docker or Docker Compose installed
#   - Replica container running in standby mode
#   - Sufficient disk space for backup (unless -n used)
#
# WARNINGS:
#   - This is a one-way operation - cannot revert to replica after promotion
#   - Old primary must be stopped before promoting replica to avoid split-brain
#   - Ensure clients are redirected to new primary after promotion

set -euo pipefail

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Default values
CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-postgres-replica}"
DATA_DIR="/var/lib/postgresql/data"
CREATE_BACKUP=true
SKIP_CONFIRMATION=false

# Error handler
error_exit() {
    log_error "$1"
    exit 1
}

# Show usage
show_help() {
    sed -n '2,41p' "$0" | sed 's/^# \?//'
    exit 0
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -c|--container)
                CONTAINER_NAME="$2"
                shift 2
                ;;
            -d|--data-dir)
                DATA_DIR="$2"
                shift 2
                ;;
            -n|--no-backup)
                CREATE_BACKUP=false
                shift
                ;;
            -y|--yes)
                SKIP_CONFIRMATION=true
                shift
                ;;
            -h|--help)
                show_help
                ;;
            *)
                error_exit "Unknown option: $1. Use -h for help."
                ;;
        esac
    done
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check if docker is available
    if ! command -v docker &> /dev/null; then
        error_exit "Docker is not installed or not in PATH"
    fi

    # Check if container exists
    if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        error_exit "Container '${CONTAINER_NAME}' does not exist"
    fi

    # Check if container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        error_exit "Container '${CONTAINER_NAME}' is not running"
    fi

    log_success "Prerequisites check passed"
}

# Verify replica is in recovery mode
verify_replica_state() {
    log_info "Verifying replica state..."

    local in_recovery
    in_recovery=$(docker exec "$CONTAINER_NAME" psql -U postgres -t -c "SELECT pg_is_in_recovery();" | tr -d '[:space:]')

    if [[ "$in_recovery" != "t" ]]; then
        error_exit "Container '${CONTAINER_NAME}' is not in recovery mode (already a primary?)"
    fi

    log_success "Confirmed: Container is in standby/recovery mode"
}

# Create backup before promotion
create_backup() {
    if [[ "$CREATE_BACKUP" == false ]]; then
        log_warning "Skipping backup (--no-backup flag set)"
        return 0
    fi

    log_info "Creating backup before promotion..."

    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_name="pre-promotion-backup-${timestamp}"

    # Create backup using pg_basebackup
    if docker exec "$CONTAINER_NAME" pg_basebackup -D "/backup/${backup_name}" -F tar -z -P 2>&1; then
        log_success "Backup created: /backup/${backup_name}"
    else
        log_warning "Backup failed, but continuing with promotion"
        log_warning "Manual backup recommended if this is production"
    fi
}

# Confirm promotion
confirm_promotion() {
    if [[ "$SKIP_CONFIRMATION" == true ]]; then
        return 0
    fi

    echo ""
    log_warning "========================================="
    log_warning "REPLICA PROMOTION WARNING"
    log_warning "========================================="
    echo "You are about to promote replica to primary."
    echo ""
    echo "Container: ${CONTAINER_NAME}"
    echo "Data Dir:  ${DATA_DIR}"
    echo "Backup:    $(if [[ "$CREATE_BACKUP" == true ]]; then echo "Yes"; else echo "No"; fi)"
    echo ""
    log_warning "IMPORTANT:"
    echo "  - This is a ONE-WAY operation"
    echo "  - Ensure old primary is STOPPED to avoid split-brain"
    echo "  - Clients must be redirected to new primary after promotion"
    echo "  - Replication slots from old primary will be lost"
    echo ""
    read -rp "Continue with promotion? [yes/NO]: " response

    if [[ ! "$response" =~ ^[Yy][Ee][Ss]$ ]]; then
        log_info "Promotion cancelled by user"
        exit 0
    fi
}

# Stop replica container
stop_container() {
    log_info "Stopping container '${CONTAINER_NAME}'..."

    if docker stop "$CONTAINER_NAME" &> /dev/null; then
        log_success "Container stopped"
    else
        error_exit "Failed to stop container"
    fi
}

# Promote replica using pg_ctl
promote_replica() {
    log_info "Promoting replica to primary..."

    # Start container temporarily to run pg_ctl promote
    docker start "$CONTAINER_NAME" &> /dev/null || error_exit "Failed to start container"

    # Wait for container to be ready
    sleep 2

    # Run pg_ctl promote
    if docker exec "$CONTAINER_NAME" su - postgres -c "pg_ctl promote -D \"${DATA_DIR}\""; then
        log_success "Replica promoted successfully"
    else
        error_exit "Failed to promote replica"
    fi

    # Wait for promotion to complete
    log_info "Waiting for promotion to complete..."
    sleep 5

    # Verify promotion
    local in_recovery
    in_recovery=$(docker exec "$CONTAINER_NAME" psql -U postgres -t -c "SELECT pg_is_in_recovery();" | tr -d '[:space:]')

    if [[ "$in_recovery" == "f" ]]; then
        log_success "Promotion verified: Container is now a primary"
    else
        error_exit "Promotion verification failed: Container still in recovery mode"
    fi
}

# Update configuration for primary role
update_configuration() {
    log_info "Updating configuration for primary role..."

    # Remove standby.signal if it exists
    if docker exec "$CONTAINER_NAME" test -f "${DATA_DIR}/standby.signal"; then
        docker exec "$CONTAINER_NAME" rm -f "${DATA_DIR}/standby.signal"
        log_success "Removed standby.signal"
    fi

    # Note: Config changes (e.g., hot_standby settings) are typically handled
    # by postgresql.conf mounted from host. If using auto-config, no changes needed.

    log_success "Configuration updated"
}

# Restart as primary
restart_primary() {
    log_info "Restarting container as primary..."

    # Stop container
    docker stop "$CONTAINER_NAME" &> /dev/null || error_exit "Failed to stop container"

    # Start container
    if docker start "$CONTAINER_NAME" &> /dev/null; then
        log_success "Container restarted"
    else
        error_exit "Failed to restart container"
    fi

    # Wait for PostgreSQL to be ready
    log_info "Waiting for PostgreSQL to accept connections..."
    local max_attempts=30
    local attempt=0

    while [[ $attempt -lt $max_attempts ]]; do
        if docker exec "$CONTAINER_NAME" pg_isready -U postgres &> /dev/null; then
            log_success "PostgreSQL is ready and accepting connections"
            return 0
        fi
        ((attempt++))
        sleep 1
    done

    error_exit "PostgreSQL failed to start within ${max_attempts} seconds"
}

# Display post-promotion instructions
show_post_promotion_instructions() {
    echo ""
    log_success "========================================="
    log_success "PROMOTION COMPLETE"
    log_success "========================================="
    echo ""
    echo "Next steps:"
    echo ""
    echo "1. Verify primary status:"
    echo "   docker exec ${CONTAINER_NAME} psql -U postgres -c \"SELECT pg_is_in_recovery();\""
    echo ""
    echo "2. Check replication slots (if setting up new replicas):"
    echo "   docker exec ${CONTAINER_NAME} psql -U postgres -c \"SELECT * FROM pg_replication_slots;\""
    echo ""
    echo "3. Update application connection strings to point to new primary"
    echo ""
    echo "4. Configure new replicas to connect to this primary (if needed)"
    echo ""
    echo "5. Stop or reconfigure old primary to prevent split-brain"
    echo ""
    log_warning "IMPORTANT: Ensure only ONE primary exists in your cluster!"
    echo ""
}

# Main function
main() {
    parse_args "$@"

    echo ""
    log_info "========================================="
    log_info "PostgreSQL Replica Promotion Script"
    log_info "========================================="
    echo ""

    check_prerequisites
    verify_replica_state
    confirm_promotion
    create_backup
    stop_container
    promote_replica
    update_configuration
    restart_primary
    show_post_promotion_instructions
}

# Run main function
main "$@"
