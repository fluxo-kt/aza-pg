# Docker Compose Consistency Check - Summary

**Date**: 2025-11-10  
**Scope**: All 5 compose files in the repository  
**Total Issues Found**: 21+ inconsistencies

## Files Checked

- `/opt/apps/art/infra/aza-pg/stacks/primary/compose.yml`
- `/opt/apps/art/infra/aza-pg/stacks/primary/compose.dev.yml`
- `/opt/apps/art/infra/aza-pg/stacks/replica/compose.yml`
- `/opt/apps/art/infra/aza-pg/stacks/single/compose.yml`
- `/opt/apps/art/infra/aza-pg/examples/backup/compose.yml`

## Critical Issues (Must Fix)

| Issue                               | File(s)             | Line(s)        | Impact                              |
| ----------------------------------- | ------------------- | -------------- | ----------------------------------- |
| Volume mount/definition mismatch    | primary/compose.yml | 18-19, 159-162 | Volumes won't mount correctly       |
| Replica network defaults to primary | replica/compose.yml | 87             | Replica can't connect independently |

## High Priority Issues (Breaks Consistency)

| Issue                        | Category      | Count | Files Affected                |
| ---------------------------- | ------------- | ----- | ----------------------------- |
| Service naming inconsistent  | Naming        | 1     | primary, single               |
| Port allocation unclear      | Ports         | 6     | primary, replica, single      |
| Environment variable quoting | Env Vars      | 2     | primary vs replica/single     |
| Password error handling      | Env Vars      | 1     | replica, single               |
| Volume env var support       | Volumes       | 2     | replica, single               |
| Config file naming           | Configuration | 1     | all                           |
| Backup container naming      | Naming        | 1     | backup example                |
| Network naming pattern       | Networks      | 4     | primary, replica, single, dev |

## Medium Priority Issues (Maintainability)

- Initdb script paths inconsistent (configs/initdb/ vs scripts/)
- Resource limits inconsistent (values and key ordering)
- Health check timing differences (postgres vs pgbouncer)
- Dev override uses different memory values

## Low Priority Issues (Nice-to-have)

- Image SHA pinning incomplete (exporters, backup lack SHA)
- Dependency patterns incomplete

## Quick Statistics

```
Service Naming Patterns:    3 variations
Network Naming Patterns:    4 variations
Port Allocations:           6 inconsistencies
Volume Naming Patterns:     3 variations
Environment Variable Patterns: 2 inconsistencies
Resource Limits:            3+ inconsistencies
Health Check Patterns:      1 inconsistency
Config File Paths:          2 inconsistencies
Image Versioning:           3 inconsistencies
Dependency Patterns:        1 inconsistency
```

## Documentation Files Generated

1. **COMPOSE_ANALYSIS.md** - High-level overview of all inconsistencies with recommendations
2. **COMPOSE_DETAILED_COMPARISON.txt** - Detailed line-by-line comparison with tables
3. **COMPOSE_FIX_RECOMMENDATIONS.txt** - Specific remediation steps for each issue with code examples
4. **COMPOSE_CONSISTENCY_SUMMARY.md** - This file

## Most Critical Findings

### 1. Primary Volume Mismatch

**Lines 18-19 vs 159-162 in primary/compose.yml**

Mount defaults use: `postgres_data`, `postgres_backup`  
Definition defaults use: `postgres-primary-data`, `postgres-primary-backup`

These don't match! The volumes won't mount correctly.

**Fix**: Update mount defaults to match volume definitions

```yaml
# Change from:
- ${POSTGRES_DATA_VOLUME:-postgres_data}:/var/lib/postgresql

# To:
- ${POSTGRES_DATA_VOLUME:-postgres-primary-data}:/var/lib/postgresql
```

### 2. Replica Network Bug

**Line 87 in replica/compose.yml**

The replica network defaults to `postgres-primary-net` instead of a replica-specific name.

**Fix**: Change default to `postgres-replica-net`

```yaml
# Change from:
name: ${POSTGRES_NETWORK_NAME:-postgres-primary-net}

# To:
name: ${POSTGRES_NETWORK_NAME:-postgres-replica-net}
```

### 3. Port Allocation Strategy Missing

All three stacks use different exporter ports (9187, 9188, 9189) with no documented strategy.
Replica uses non-standard postgres port (5433) without explanation.

**Recommendation**: Document port allocation strategy or standardize to same ports per stack.

## Next Steps

1. **Review** COMPOSE_FIX_RECOMMENDATIONS.txt for detailed fixes
2. **Fix critical issues** (#1 volume mismatch, #2 replica network)
3. **Implement high-priority fixes** in order of dependency
4. **Create** COMPOSE_STANDARDS.md to prevent future inconsistencies
5. **Document** port allocation strategy in PORT_ALLOCATION.md

## Implementation Checklist

See COMPOSE_FIX_RECOMMENDATIONS.txt for full implementation checklist (16 items).

---

For detailed analysis, see:

- **COMPOSE_ANALYSIS.md** - Categorized by consistency area
- **COMPOSE_DETAILED_COMPARISON.txt** - Tables and comparison views
- **COMPOSE_FIX_RECOMMENDATIONS.txt** - Step-by-step remediation guide
