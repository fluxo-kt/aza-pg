# Tooling & Library Choices

**Purpose**: This document records all intentional tooling and library decisions for the aza-pg project. These choices must not be changed accidentally or without explicit approval.

**Last Updated**: 2025-11-23

---

## 🎯 Design Principles

All tooling choices follow these principles:

1. **Bun-first**: Prefer Bun-native solutions over Node.js alternatives
2. **Performance**: Choose faster, more efficient tools when quality is equivalent
3. **TypeScript strict mode**: Full type safety with no compromises
4. **Minimal dependencies**: Avoid unnecessary bloat
5. **Production-ready**: Only mature, well-maintained libraries

---

## 📦 Core Runtime & Tooling

### Bun Runtime

**Version**: 1.3.0+
**Why**: Fastest JavaScript/TypeScript runtime, native TypeScript support, superior performance
**Status**: ✅ LOCKED - Core dependency, do not replace with Node.js
**Configuration**: `bunfig.toml`, `.tool-versions`

#### Nested Bun Config (scripts/config-generator/)

**Decision**: KEEP nested `bunfig.toml` and `bun.lock` in `scripts/config-generator/`
**Rationale**:

- Security hardening: OSV scanner enabled for dependency vulnerability scanning
- Supply chain protection: 1-day release delay (`minimumReleaseAge = 86400`) prevents immediate zero-day exploits
- Isolation: Config generator is critical infrastructure that generates all stack configs - deserves extra protection
- Trade-off: Slight complexity increase is acceptable for security benefits on critical infrastructure code

**Configuration**: `scripts/config-generator/bunfig.toml`

```toml
[install.security]
scanner = "bun-osv-scanner"
minimumReleaseAge = 86400  # 1 day delay
```

### TypeScript

**Version**: 5.9.3+
**Why**: Type safety, excellent IDE support, industry standard
**Status**: ✅ LOCKED
**Configuration**: `tsconfig.json` (strict mode enabled)

### Bun-Only Scripting

**Policy**: All build and utility scripts use Bun TypeScript exclusively. Node.js is not supported.
**Bun APIs**: Use `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.$` `, `Bun.argv`, `Bun.env`instead of Node.js equivalents.
**Status**: Migration from Node.js APIs ongoing where practical; production containers contain no Bun.
**Examples**: See`scripts/` directory for Bun-native patterns.

---

## 🔍 Code Quality & Linting

### Oxlint

**Version**: See `package.json` (`devDependencies.oxlint`)
**Why**: Extremely fast TypeScript/JavaScript linter (50-100x faster than ESLint), Rust-based
**Status**: ✅ LOCKED - Do NOT replace with ESLint
**Configuration**: `.oxlintrc.json`
**Usage**: `bun run lint`, `bun run lint:fix`

**Decision Rationale**:

- Oxlint is 50-100x faster than ESLint
- Native Rust implementation provides superior performance
- Sufficient rule coverage for infrastructure project
- Better CI/CD performance

### Prettier (temporary - migrate to Oxfmt when stable)

**Version**: 3.6.2+
**Why**: Industry-standard code formatter, zero-config philosophy
**Status**: ✅ CURRENT - **Planned migration to Oxfmt when stable**
**Configuration**: `.prettierrc.json`, `.prettierignore`
**Usage**: `bun run format`, `bun run format:check`

**Decision Rationale**:

- Prettier is battle-tested and production-ready (current stable: 3.6.2)
- Oxfmt is preferred but **NOT YET STABLE** (pre-alpha as of Nov 2025, npm package marked "DO NOT USE")
- When Oxfmt reaches stable (planned: 99.99% Prettier-compatible):
  - Performance: ~45x faster than Prettier, 2-3x faster than Biome
  - Migration: Minimal diffs due to high Prettier compatibility
  - Config: Just rename `.prettierrc.json` → `.oxfmtrc.jsonc`

**Migration Checklist (when Oxfmt stable)**:

1. ✅ Verify Oxfmt npm package is stable (not pre-alpha)
2. ✅ Test formatting on codebase: `npx oxfmt --check .`
3. ✅ Compare diff size (should be minimal due to 99.99% compat)
4. ✅ Rename config file: `.prettierrc.json` → `.oxfmtrc.jsonc`
5. ✅ Update package.json: Replace `prettier` with `oxfmt`
6. ✅ Update scripts: `oxfmt` instead of `prettier`
7. ✅ Update git hooks to use `oxfmt`
8. ✅ Document migration in CHANGELOG.md

### sql-formatter + Squawk + Custom PostgreSQL Linting

**Version**: 15.6.10+ (sql-formatter) + 2.30.0+ (Squawk) + Bun-native linting
**Why**: Comprehensive SQL quality - formatting AND dual-layer PostgreSQL-specific linting
**Status**: ✅ LOCKED
**Configuration**: `.sql-formatter.json` + `scripts/check-sql.ts` + `scripts/lint-sql-squawk.ts`
**Usage**: `bun run check:sql`, `bun run lint:sql`, `bun run format:sql`

**Decision Rationale**:

- **Formatting**: sql-formatter for PostgreSQL dialect (keywords, functions, indentation)
- **Linting Layer 1 (Squawk)**: Rust-based PostgreSQL migration/SQL linter - production-grade best practices
- **Linting Layer 2 (Custom)**: Bun-native rules for additional security/performance checks
- Fast execution: ~50ms (formatting) + ~200ms (Squawk) + ~50ms (custom) = ~300ms total
- Zero Python/Ruby dependencies (Bun + Rust only)
- Integrated into generation pipeline, pre-commit hooks, and CI/CD validation

**Formatting Rules** (`.sql-formatter.json`):

- Dialect: `postgresql`
- Keywords: `UPPER` (CREATE, SELECT, etc.)
- Functions: `lower` (now, array_append, etc.)
- Indentation: 2 spaces, no tabs
- Expression width: 80 chars (optimized for readability)
- Lines between queries: 2 (better visual separation)

**Squawk Linting Rules** (`scripts/lint-sql-squawk.ts` - PostgreSQL Production Best Practices):

1. **Migration Safety**:
   - Require CONCURRENT for index creation (avoid blocking writes)
   - Require timeout settings for slow operations (lock_timeout, statement_timeout)
   - Detect adding columns with DEFAULT (table rewrites)
   - Warn on renaming/dropping columns (data loss risks)
2. **Type Safety**:
   - Prefer BIGINT over INT (avoid 32-bit limit)
   - Prefer IDENTITY over SERIAL (better schema management)
   - Detect problematic type changes
3. **Performance**:
   - Detect missing indexes on foreign keys
   - Warn on full table scans
   - Identify blocking operations
4. **Security**:
   - Detect privilege escalations
   - Warn on dangerous permissions

**Custom Bun-Native Linting Rules** (`scripts/check-sql.ts` - Complementary Checks):

1. **Security**:
   - DELETE/UPDATE without WHERE clause (dangerous)
   - Potential SQL injection in EXECUTE without format() interpolation
2. **Performance**:
   - Missing indexes on foreign keys (heuristic)
   - SELECT \* anti-pattern (suggest explicit columns)
   - Long transaction blocks (>50 statements, lock concerns)
3. **Correctness**:
   - Unmatched parentheses
   - TRUNCATE warnings (permanent data loss)
   - Missing transaction control for DDL
4. **Code Quality**:
   - Trailing whitespace
   - Mixed line endings (CRLF/LF)

**Integration Points**:

1. **Generation**: `generateExtensionsInitScript()` auto-formats SQL at build time
2. **Pre-commit**: Auto-formats staged `.sql` files via `scripts/pre-commit.ts`
3. **Validation**: Required check in `scripts/validate.ts` (fast mode)
4. **Scripts**:
   - `scripts/format-sql.ts` - PostgreSQL formatter
   - `scripts/check-sql.ts` - Custom validator + linter
   - `scripts/lint-sql-squawk.ts` - Squawk PostgreSQL linter wrapper

**Scope**:

- `docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql` (auto-generated)
- `docker/postgres/docker-entrypoint-initdb.d/05-pgflow.sql` (pgflow schema)
- `examples/pgflow/10-pgflow.sql` (pgflow example)

---

## ✅ Validation & Schema

### ArkType (NOT Zod)

**Version**: 2.1.25+
**Why**: Significantly faster than Zod, more efficient runtime validation, better performance
**Status**: ✅ INSTALLED - **CRITICAL: Use ArkType, NOT Zod**
**Use Cases**:

- Manifest validation (`extensions.manifest.json`)
- Configuration validation
- Runtime type checking

**Decision Rationale**:

- ArkType is much faster than Zod for runtime validation
- Lower memory overhead
- Better TypeScript inference
- More efficient for large schemas (like manifest with 36 enabled extensions)

**⚠️ IMPORTANT**: If any code suggests using Zod, it MUST be replaced with ArkType.

---

## 🪝 Git Hooks

### bun-git-hooks

**Version**: 0.3.1+
**Why**: Bun-native git hooks manager, lightweight, no Husky dependency
**Status**: ✅ LOCKED
**Configuration**: `git-hooks.config.ts`
**Hooks Configured**:

- `pre-commit`: Bun script `scripts/pre-commit.ts` (oxlint --fix, Prettier --write, regenerate manifest-driven artifacts when `manifest-data.ts` changes, auto-stage fixes)
- `pre-push`: Disabled – rely on CI (`ci.yml`) for full validation

---

## 🧪 Testing

### Bun Test

**Why**: Native Bun test runner, fast, zero configuration
**Status**: ✅ LOCKED - Currently using Bun's `$` shell integration for test scripts
**Note**: No external test framework needed for current infrastructure tests

---

## 🐳 Docker & Infrastructure

### Docker Compose

**Version**: Per system installation
**Why**: Standard for multi-container deployments
**Status**: ✅ LOCKED

### PostgreSQL

**Version**: 18 (official postgres:18-trixie image)
**Why**: Latest stable PostgreSQL with performance improvements
**Status**: ✅ LOCKED

### PgBouncer

**Why**: Industry-standard PostgreSQL connection pooler
**Status**: ✅ LOCKED

---

## 📊 Monitoring

### postgres_exporter

**Why**: Prometheus-compatible PostgreSQL metrics exporter
**Status**: ✅ LOCKED
**Configuration**: `docker/postgres/configs/postgres_exporter_queries.yaml`

---

## 🔧 Build Tools

### Docker Buildx

**Why**: Multi-platform Docker builds (amd64 + arm64)
**Status**: ✅ LOCKED

### Cargo/Rust (for extension compilation)

**Why**: Required for cargo-pgrx extensions (pg_jsonschema, timescaledb_toolkit, etc.)
**Status**: ✅ LOCKED - Build-time only, not in runtime image

---

## 📝 Documentation

### Markdown (CommonMark spec)

**Why**: Universal documentation format
**Status**: ✅ LOCKED

---

## ❌ Explicitly NOT Used

### Libraries We Do NOT Use (and why):

1. **Zod** ❌
   - Reason: Replaced by ArkType (faster, more efficient)
   - If you see Zod in code, replace it with ArkType

2. **ESLint** ❌
   - Reason: Replaced by Oxlint (50-100x faster)
   - Infrastructure project doesn't need ESLint's plugin ecosystem

3. **Oxfmt** ❌ (temporarily)
   - Reason: Pre-alpha, npm package marked "DO NOT USE" (as of Nov 2025)
   - Status: Will migrate when stable (planned 99.99% Prettier compat, 45x faster)
   - Current: Using Prettier 3.6.2 until Oxfmt reaches production-ready state

4. **Husky** ❌
   - Reason: Replaced by bun-git-hooks (Bun-native, lighter)

5. **Node.js** ❌ (for scripting)
   - Reason: Replaced by Bun (faster, native TypeScript)
   - Note: Node.js compatibility maintained in `package.json` engines for CI/CD

6. **Jest/Vitest** ❌
   - Reason: Using Bun's native test capabilities
   - Overhead not needed for infrastructure testing

7. **ts-node** ❌
   - Reason: Bun runs TypeScript natively

---

## 🔒 Change Control

### How to Propose Tooling Changes

1. **Document rationale**: Why is the current choice insufficient?
2. **Benchmark comparison**: Provide performance/feature comparison
3. **Migration plan**: How to migrate existing code
4. **Approval required**: Must be explicitly approved

### Protected Decisions

These choices are **LOCKED** and must not be changed without explicit approval:

- ✅ Bun as runtime (not Node.js)
- ✅ Oxlint for linting (not ESLint)
- ✅ ArkType for validation (not Zod)
- ✅ bun-git-hooks (not Husky)
- ✅ PostgreSQL 18
- ✅ TypeScript strict mode

---

## 🔧 Script Execution Patterns

### Command Execution Strategy

**Pattern**: Mixed use of `Bun.spawn()` and shell template literals

The codebase uses two different approaches for executing shell commands:

1. **Bun.spawn()** (~76 usages)
   - Use cases: Programmatic control, output capture, error handling
   - Benefits: Better control over stdin/stdout/stderr, async handling
   - Examples: Extension builds, validation checks, Docker operations

2. **Template literals ($\`...\`)** (~202 usages)
   - Use cases: Simple shell commands, Unix pipelines, quick operations
   - Benefits: Concise syntax, natural shell command composition
   - Examples: File operations, git commands, quick checks

**Rationale**: Pragmatic approach - use the right tool for each case

- `Bun.spawn()` when you need programmatic control or output processing
- Template literals when the shell pipeline is the most natural expression
- No mandate to unify - both have valid use cases

**Decision**: This pattern is **intentional** and **not enforced**. Choose based on:

- Complexity: Simple one-liners → template literals
- Output handling: Need to parse/process → Bun.spawn()
- Error handling: Critical operations → Bun.spawn() with proper error checking
- Shell features: Pipelines, redirects → template literals

---

## 📋 Quick Reference

| Category   | Choice        | Alternative Rejected | Why                            |
| ---------- | ------------- | -------------------- | ------------------------------ |
| Runtime    | Bun 1.3.0+    | Node.js              | Faster, native TS              |
| Linting    | Oxlint 0.11+  | ESLint               | 50-100x faster                 |
| Formatting | Prettier 3.6+ | Oxfmt (pre-alpha)    | Prettier stable, Oxfmt pending |
| Validation | **ArkType**   | **Zod**              | **Faster, more efficient**     |
| Git Hooks  | bun-git-hooks | Husky                | Bun-native                     |
| Testing    | Bun native    | Jest/Vitest          | Simpler for infra              |

---

## 🆕 Adding New Dependencies

Before adding ANY new dependency:

1. ✅ Check if Bun has a native solution
2. ✅ Verify it's actively maintained (commits in last 3 months)
3. ✅ Check bundle size impact
4. ✅ Ensure TypeScript types are available
5. ✅ Document the choice in this file

---

## 📍 Configuration File Map

| File                  | Purpose                     | Tool          |
| --------------------- | --------------------------- | ------------- |
| `package.json`        | Root dependencies & scripts | Bun/npm       |
| `bunfig.toml`         | Bun configuration           | Bun           |
| `tsconfig.json`       | TypeScript compiler options | TypeScript    |
| `.oxlintrc.json`      | Linting rules               | Oxlint        |
| `.prettierrc.json`    | Formatting rules            | Prettier      |
| `git-hooks.config.ts` | Git hooks configuration     | bun-git-hooks |
| `.tool-versions`      | Runtime versions (asdf)     | asdf          |

---

## 🔄 Version Management

- **Bun**: Pinned in `.tool-versions` (asdf)
- **npm packages**: Use caret ranges (^) for patch/minor updates
- **Lock file**: `bun.lockb` (binary format, committed to git)

---

## 🔗 Tool References & Documentation

Comprehensive list of all tools used in this project with links to their documentation and source code.

### Runtime & Language

| Tool                                         | Repository                                        | Documentation                               | Purpose                                                                       |
| -------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| [Bun](https://bun.sh)                        | [GitHub](https://github.com/oven-sh/bun)          | [Docs](https://bun.sh/docs)                 | Fast JavaScript/TypeScript runtime, bundler, test runner, and package manager |
| [TypeScript](https://www.typescriptlang.org) | [GitHub](https://github.com/microsoft/TypeScript) | [Docs](https://www.typescriptlang.org/docs) | Type-safe JavaScript superset with strict mode                                |

### Code Quality & Linting

| Tool                                             | Repository                                        | Documentation                                          | Purpose                                                                  |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Oxlint](https://oxc.rs)                         | [GitHub](https://github.com/oxc-project/oxc)      | [Docs](https://oxc.rs/docs/guide/usage/linter)         | Rust-based fast linter (50-100x faster than ESLint)                      |
| [Prettier](https://prettier.io)                  | [GitHub](https://github.com/prettier/prettier)    | [Docs](https://prettier.io/docs/)                      | Industry-standard opinionated code formatter                             |
| [Oxfmt](https://oxc.rs)                          | [GitHub](https://github.com/oxc-project/oxc)      | [Docs](https://oxc.rs/docs/guide/usage/formatter.html) | Fast formatter (planned migration when stable, 45x faster than Prettier) |
| [shellcheck](https://www.shellcheck.net)         | [GitHub](https://github.com/koalaman/shellcheck)  | [Wiki](https://github.com/koalaman/shellcheck/wiki)    | Static analysis tool for shell scripts                                   |
| [hadolint](https://hadolint.github.io/hadolint/) | [GitHub](https://github.com/hadolint/hadolint)    | [Docs](https://hadolint.github.io/hadolint/)           | Dockerfile linter with best practices validation                         |
| [yamllint](https://yamllint.readthedocs.io)      | [GitHub](https://github.com/adrienverge/yamllint) | [Docs](https://yamllint.readthedocs.io)                | YAML linter for syntax and cosmetic checking                             |

### Validation & Schema

| Tool                          | Repository                                     | Documentation                   | Purpose                                                                     |
| ----------------------------- | ---------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| [ArkType](https://arktype.io) | [GitHub](https://github.com/arktypeio/arktype) | [Docs](https://arktype.io/docs) | TypeScript 1:1 validator optimized from editor to runtime (faster than Zod) |

### Git Hooks

| Tool                                                       | Repository                                          | Documentation                                              | Purpose                                              |
| ---------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| [bun-git-hooks](https://github.com/stacksjs/bun-git-hooks) | [GitHub](https://github.com/stacksjs/bun-git-hooks) | [README](https://github.com/stacksjs/bun-git-hooks#readme) | Bun-native git hooks manager (lightweight, no Husky) |

### Docker & Infrastructure

| Tool                                               | Repository                                       | Documentation                                                  | Purpose                                                    |
| -------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------- |
| [Docker Compose](https://docs.docker.com/compose/) | [GitHub](https://github.com/docker/compose)      | [Docs](https://docs.docker.com/compose/)                       | Multi-container Docker application orchestration           |
| [Docker Buildx](https://docs.docker.com/build/)    | [GitHub](https://github.com/docker/buildx)       | [Docs](https://docs.docker.com/build/building/multi-platform/) | Multi-platform Docker builds (amd64 + arm64)               |
| [PostgreSQL](https://www.postgresql.org)           | [GitHub](https://github.com/postgres/postgres)   | [Docs](https://www.postgresql.org/docs/18/)                    | PostgreSQL 18 database (official postgres:18-trixie image) |
| [PgBouncer](https://www.pgbouncer.org)             | [GitHub](https://github.com/pgbouncer/pgbouncer) | [Docs](https://www.pgbouncer.org/usage.html)                   | Lightweight PostgreSQL connection pooler                   |

### Build Tools

| Tool                                                      | Repository                                            | Documentation                                                                        | Purpose                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Rust](https://www.rust-lang.org)                         | [GitHub](https://github.com/rust-lang/rust)           | [Docs](https://doc.rust-lang.org/book/)                                              | Systems programming language for extension compilation                     |
| [Cargo](https://doc.rust-lang.org/cargo/)                 | [GitHub](https://github.com/rust-lang/cargo)          | [Docs](https://doc.rust-lang.org/cargo/)                                             | Rust package manager and build system                                      |
| [cargo-pgrx](https://github.com/pgcentralfoundation/pgrx) | [GitHub](https://github.com/pgcentralfoundation/pgrx) | [Docs](https://github.com/pgcentralfoundation/pgrx/blob/master/cargo-pgrx/README.md) | Build PostgreSQL extensions with Rust (pg_jsonschema, timescaledb_toolkit) |

### Monitoring & Security

| Tool                                                                           | Repository                                                          | Documentation                                                              | Purpose                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| [postgres_exporter](https://github.com/prometheus-community/postgres_exporter) | [GitHub](https://github.com/prometheus-community/postgres_exporter) | [README](https://github.com/prometheus-community/postgres_exporter#readme) | Prometheus-compatible PostgreSQL metrics exporter |
| [Cosign](https://docs.sigstore.dev)                                            | [GitHub](https://github.com/sigstore/cosign)                        | [Docs](https://docs.sigstore.dev/cosign/signing/signing_with_containers/)  | Container signing and verification (Sigstore)     |

---

## **Remember**: These tooling choices are intentional and performance-critical. Do not change without explicit justification and approval.
