# Bun API Migration Status

## Current State

The project is **partially migrated** from Node.js APIs to Bun-native APIs:

- **47 of 53 files** (88.7%) use Bun APIs exclusively
- **10 files** (18.9%) still use Node.js standard library APIs

## Node.js API Usage

Files still using Node.js APIs (as of 2025-11-10):

### Test Scripts (4 files)

- `scripts/test/test-build.ts` - Uses `process.*`, `node:path`, `node:fs`
- `scripts/test/test-pgbouncer-failures.ts` - Uses `node:fs`, `node:path`, `process.*`
- `scripts/test/test-pgbouncer-healthcheck.ts` - Uses `node:fs`, `node:path`, `process.*`
- `scripts/test/test-replica-stack.ts` - Uses `node:path`, `process.*`

### Config Generator (3 files)

- `scripts/config-generator/manifest-loader.ts` - Uses `fs.readFileSync`
- `scripts/config-generator/config-writer.ts` - Uses `fs.writeFileSync`, `fs.mkdirSync`
- `scripts/config-generator/validate-configs.ts` - Uses `fs.readFileSync`

### Core Scripts (3 files)

- `scripts/extensions/validate-manifest.ts` - Uses `fs.existsSync`, `fs.readFileSync`
- `scripts/generate-version-info.ts` - Uses `fs.existsSync`, `fs.readFileSync`, `process.*`
- `scripts/build.ts` - Uses `process.env`, `process.argv`, `process.exit`, `process.on`

## Migration Decision

**STATUS: INTENTIONALLY DEFERRED**

### Rationale

1. **Production Impact**: Node API usage does NOT affect production - all runtime code is pure PostgreSQL/shell
2. **Build-time Only**: These scripts run during development and CI, not in containers
3. **Functional Correctness**: All scripts work reliably with current implementation
4. **Priority**: Phase 5-7 focused on CRITICAL functional bugs and correctness issues
5. **Effort vs Value**: Migration would require ~4-6 hours for minimal benefit

### Migration Plan (Future)

When resources allow, migrate in this order:

**Priority 1: Core Scripts** (2 hours)

- `generate-version-info.ts` - High visibility, runs in Dockerfile
- `build.ts` - Central to development workflow

**Priority 2: Config Generator** (1.5 hours)

- Replace `fs.*Sync` with `await Bun.file().text()` / `await Bun.write()`
- Keep path manipulation (minimal usage)

**Priority 3: Test Scripts** (1.5 hours)

- Replace `process.*` with `Bun.*` equivalents
- Standardize error handling

### Bun Equivalents Reference

| Node.js API                    | Bun Equivalent                           |
| ------------------------------ | ---------------------------------------- |
| `process.argv`                 | `Bun.argv`                               |
| `process.env`                  | `Bun.env`                                |
| `process.exit(code)`           | `process.exit(code)` (same)              |
| `fs.readFileSync(path)`        | `await Bun.file(path).text()`            |
| `fs.writeFileSync(path, data)` | `await Bun.write(path, data)`            |
| `fs.existsSync(path)`          | `await Bun.file(path).exists()`          |
| `path.join()`                  | `path.join()` or `import.meta.dir + "/"` |

### .tool-versions Consideration

Currently pins `nodejs 24.10.0` alongside `bun 1.3.0`. If full Bun migration completes, consider:

- Remove nodejs from .tool-versions
- Update CI to only install Bun
- Document Bun-only requirement in README

**Decision Date**: 2025-11-10
**Review Date**: Q1 2026 or when major refactoring occurs
