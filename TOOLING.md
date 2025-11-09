# Tooling & Library Choices

**Purpose**: This document records all intentional tooling and library decisions for the aza-pg project. These choices must not be changed accidentally or without explicit approval.

**Last Updated**: 2025-11-09

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

### TypeScript

**Version**: 5.9.3+
**Why**: Type safety, excellent IDE support, industry standard
**Status**: ✅ LOCKED
**Configuration**: `tsconfig.json` (strict mode enabled)

---

## 🔍 Code Quality & Linting

### Oxlint

**Version**: 0.11.0+
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
- More efficient for large schemas (like manifest with 38 extensions)

**⚠️ IMPORTANT**: If any code suggests using Zod, it MUST be replaced with ArkType.

---

## 🪝 Git Hooks

### bun-git-hooks

**Version**: 0.3.1+
**Why**: Bun-native git hooks manager, lightweight, no Husky dependency
**Status**: ✅ LOCKED
**Configuration**: `git-hooks.config.ts`
**Hooks Configured**:

- `pre-commit`: Security checks + Oxlint + Prettier
- `pre-push`: Full validation suite

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

**Remember**: These tooling choices are intentional and performance-critical. Do not change without explicit justification and approval.
