# 📚 aza-pg Documentation Index

**Welcome to the aza-pg documentation.** This index organizes all documentation by audience and purpose to help you find what you need quickly.

---

## 🚀 Quick Start (New Users)

Start here if you're new to aza-pg:

1. **[../README.md](../README.md)** - Project overview, quick start, feature highlights
2. **[PRODUCTION.md](PRODUCTION.md)** - Production deployment guide with security checklist
3. **[EXTENSIONS.md](EXTENSIONS.md)** - Extension inventory and management guide

---

## 👨‍💻 By Audience

### For DevOps & System Administrators

| Document                                             | Description                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| **[PRODUCTION.md](PRODUCTION.md)**                   | Production deployment checklist, security hardening, TLS setup |
| **[LOGICAL_REPLICATION.md](LOGICAL_REPLICATION.md)** | Streaming replication setup for high availability              |
| **[UPGRADING.md](UPGRADING.md)**                     | PostgreSQL upgrade procedures and migration paths              |
| **[TESTING.md](TESTING.md)**                         | Comprehensive testing strategy and session isolation guide     |

### For Developers & Contributors

| Document                                                                               | Description                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **[../AGENTS.md](../AGENTS.md)**                                                       | Architecture patterns, agent operations guide (canonical reference) |
| **[ARCHITECTURE.md](ARCHITECTURE.md)**                                                 | System design overview, component interactions                      |
| **[development/EXTENSION-ENABLE-DISABLE.md](development/EXTENSION-ENABLE-DISABLE.md)** | Extension enable/disable architecture (974 lines, comprehensive)    |
| **[TECHNICAL-DEBT.md](TECHNICAL-DEBT.md)**                                             | Known limitations and workarounds                                   |

### For Data Engineers

| Document                                                   | Description                                       |
| ---------------------------------------------------------- | ------------------------------------------------- |
| **[EXTENSIONS.md](EXTENSIONS.md)**                         | Extension catalog and configuration guide         |
| **[pgflow/INTEGRATION.md](pgflow/INTEGRATION.md)**         | Workflow orchestration with pgflow                |
| **[POSTGRESQL-18-FEATURES.md](POSTGRESQL-18-FEATURES.md)** | PostgreSQL 18 specific features and optimizations |

---

## 📖 By Topic

### Extension Management

| Document                                                                                 | Focus Area                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **[EXTENSIONS.md](EXTENSIONS.md)**                                                       | Main extension guide (inventory, enable/disable, categories) |
| **[extensions/SIZE-ANALYSIS.md](extensions/SIZE-ANALYSIS.md)**                           | Per-extension size breakdown and optimization opportunities  |
| **[extensions/PERFORMANCE-IMPACT.md](extensions/PERFORMANCE-IMPACT.md)**                 | Memory overhead analysis for all 38 extensions               |
| **[extensions/PGDG-AVAILABILITY.md](extensions/PGDG-AVAILABILITY.md)**                   | PGDG extension availability and packaging status             |
| **[extensions/PREBUILT-BINARIES-ANALYSIS.md](extensions/PREBUILT-BINARIES-ANALYSIS.md)** | Pre-built binary analysis and optimization research          |
| **[extensions/HOOK-EXTENSIONS-TESTING.md](extensions/HOOK-EXTENSIONS-TESTING.md)**       | Testing strategy for hook-based extensions                   |

### Testing & Quality Assurance

| Document                                                                     | Focus Area                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| **[TESTING.md](TESTING.md)**                                                 | Comprehensive testing framework and strategy    |
| **[testing/README.md](testing/README.md)**                                   | Testing directory overview and test suite index |
| **[testing/IMPLEMENTATION-SUMMARY.md](testing/IMPLEMENTATION-SUMMARY.md)**   | Test implementation details and coverage        |
| **[testing/PGBOUNCER-FAILURE-TESTS.md](testing/PGBOUNCER-FAILURE-TESTS.md)** | PgBouncer failure scenario testing              |

### CI/CD & Build System

| Document                                       | Focus Area                                               |
| ---------------------------------------------- | -------------------------------------------------------- |
| **[ci/README.md](ci/README.md)**               | CI/CD pipeline overview and GitHub Actions configuration |
| **[ci/ARM64-TESTING.md](ci/ARM64-TESTING.md)** | ARM64 architecture testing with QEMU validation          |

### Analysis & Optimization

| Document                                                                       | Focus Area                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **[analysis/README.md](analysis/README.md)**                                   | Analysis directory index and overview                               |
| **[analysis/extension-size-analysis.md](analysis/extension-size-analysis.md)** | Detailed extension size analysis (timescaledb_toolkit optimization) |
| **[analysis/OPTIMIZATION-ROADMAP.md](analysis/OPTIMIZATION-ROADMAP.md)**       | Phased optimization plan and future enhancements                    |
| **[analysis/PIGSTY-EVALUATION.md](analysis/PIGSTY-EVALUATION.md)**             | Alternative platform evaluation and comparison                      |

### Architecture & Design

| Document                                                                                                       | Focus Area                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **[ARCHITECTURE.md](ARCHITECTURE.md)**                                                                         | System design, component interactions, security model    |
| **[development/EXTENSION-ENABLE-DISABLE.md](development/EXTENSION-ENABLE-DISABLE.md)**                         | Complete architecture for extension lifecycle management |
| **[refactoring/config-generator-refactor-2025-11-07.md](refactoring/config-generator-refactor-2025-11-07.md)** | Config generator refactoring rationale                   |

### Verification & Audits

| Document                                                                                                   | Focus Area                                     |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **[verification/DOCUMENTATION-VERIFICATION-REPORT.md](verification/DOCUMENTATION-VERIFICATION-REPORT.md)** | Documentation verification and accuracy report |
| **[audit/CONFIGURATION-AUDIT-REPORT.md](audit/CONFIGURATION-AUDIT-REPORT.md)**                             | Configuration audit findings                   |

---

## 🔍 By Common Task

### "I want to deploy aza-pg to production"

→ Start with **[PRODUCTION.md](PRODUCTION.md)**, then review **[LOGICAL_REPLICATION.md](LOGICAL_REPLICATION.md)** for HA setup

### "I need to enable/disable specific extensions"

→ Read **[EXTENSIONS.md](EXTENSIONS.md)** → **[development/EXTENSION-ENABLE-DISABLE.md](development/EXTENSION-ENABLE-DISABLE.md)**

### "I want to understand the architecture"

→ **[../AGENTS.md](../AGENTS.md)** (canonical patterns) → **[ARCHITECTURE.md](ARCHITECTURE.md)** (detailed design)

### "I need to set up replication"

→ **[LOGICAL_REPLICATION.md](LOGICAL_REPLICATION.md)** has step-by-step instructions

### "I want to contribute or modify the codebase"

→ **[../AGENTS.md](../AGENTS.md)** → **[TECHNICAL-DEBT.md](TECHNICAL-DEBT.md)** → **[development/EXTENSION-ENABLE-DISABLE.md](development/EXTENSION-ENABLE-DISABLE.md)**

### "I need to troubleshoot extension issues"

→ **[EXTENSIONS.md](EXTENSIONS.md)** → **[extensions/PERFORMANCE-IMPACT.md](extensions/PERFORMANCE-IMPACT.md)** → **[TESTING.md](TESTING.md)**

### "I want to optimize image size"

→ **[analysis/extension-size-analysis.md](analysis/extension-size-analysis.md)** → **[extensions/SIZE-ANALYSIS.md](extensions/SIZE-ANALYSIS.md)**

### "I need to run the test suite"

→ **[TESTING.md](TESTING.md)** → **[testing/README.md](testing/README.md)** → **[../scripts/README.md](../scripts/README.md)**

### "I want to upgrade PostgreSQL versions"

→ **[UPGRADING.md](UPGRADING.md)** → **[POSTGRESQL-18-FEATURES.md](POSTGRESQL-18-FEATURES.md)**

---

## 📁 Directory Structure

```
docs/
├── INDEX.md (this file)                  ← Master navigation
├── ARCHITECTURE.md                       ← System design
├── EXTENSIONS.md                         ← Extension guide
├── PRODUCTION.md                         ← Deployment guide
├── TESTING.md                            ← Testing strategy
├── LOGICAL_REPLICATION.md                ← Replication setup
├── UPGRADING.md                          ← Upgrade procedures
├── POSTGRESQL-18-FEATURES.md             ← PG18 features
├── TECHNICAL-DEBT.md                     ← Known issues
├── NOTES.md                              ← Research notes (manual-only)
│
├── analysis/                             ← Performance & optimization
│   ├── README.md
│   ├── extension-size-analysis.md
│   ├── OPTIMIZATION-ROADMAP.md
│   └── PIGSTY-EVALUATION.md
│
├── audit/                                ← Audit reports
│   └── CONFIGURATION-AUDIT-REPORT.md
│
├── ci/                                   ← CI/CD documentation
│   ├── README.md
│   └── ARM64-TESTING.md
│
├── development/                          ← Developer guides
│   └── EXTENSION-ENABLE-DISABLE.md
│
├── extensions/                           ← Extension-specific docs
│   ├── SIZE-ANALYSIS.md
│   ├── PERFORMANCE-IMPACT.md
│   ├── PGDG-AVAILABILITY.md
│   ├── PREBUILT-BINARIES-ANALYSIS.md
│   └── HOOK-EXTENSIONS-TESTING.md
│
├── pgflow/                               ← pgflow integration
│   └── INTEGRATION.md
│
├── refactoring/                          ← Refactoring documentation
│   └── config-generator-refactor-2025-11-07.md
│
├── testing/                              ← Testing documentation
│   ├── README.md
│   ├── IMPLEMENTATION-SUMMARY.md
│   └── PGBOUNCER-FAILURE-TESTS.md
│
└── verification/                         ← Verification reports
    └── DOCUMENTATION-VERIFICATION-REPORT.md
```

---

## 🗄️ Historical Documentation

Historical audit reports and outdated documents are archived in **[../.archived/](../.archived/)** (not actively maintained).

---

## 📝 Documentation Standards

- **AGENTS.md**: Canonical architecture patterns and agent operations guide
- **README.md**: User-facing quick start and feature overview (root directory)
- **CHANGELOG.md**: Version history and release notes (root directory)
- All current docs maintained in `docs/` (this directory)
- Historical/stale docs moved to `.archived/` (root level)

---

## 🔗 External Resources

- **[PostgreSQL 18 Documentation](https://www.postgresql.org/docs/18/)**
- **[PgBouncer Documentation](https://www.pgbouncer.org/)**
- **[pgflow GitHub](https://github.com/bdon/pgflow)**
- **[Timescale Toolkit](https://github.com/timescale/timescaledb-toolkit)**

---

**Last Updated:** 2025-11-08
**Maintained By:** aza-pg project
**Questions?** Check [../AGENTS.md](../AGENTS.md) for architecture patterns and conventions.
