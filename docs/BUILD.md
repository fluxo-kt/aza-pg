# Build from Source

Complete guide to building aza-pg PostgreSQL images locally and in CI/CD.

## Quick Start

```bash
# Default: Single-platform with intelligent caching
bun run build

# Verify build
docker run --rm aza-pg:pg18 psql --version
docker run --rm aza-pg:pg18 postgres --version
```

## Build Methods

### Local Builds

`bun run build` (`scripts/nix/build-image.ts`) builds the image for this machine's architecture and loads it into Docker as `aza-pg:pg<major>`; `--tag <ref>` retags it. `--push <ref>` (publish.yml, native Nix only) pushes it to the registry with OCI media types and zstd layers instead (Docker Engine 23+ pulls them), then prints the digest: the release index carries annotations, which a Docker manifest list cannot. It refuses a push whose registry copy holds a layer that is not zstd or is raw tar under a compressed media type (reason in the script).

**How it works:**

- Runs `nix build` on `flake.nix`: natively on Linux with Nix installed, otherwise in a `nixos/nix` container (`scripts/nix/nix.ts`) whose store persists in the `aza-pg-nix-<arch>` volume, so only changed packages rebuild; each build then deletes every store path that neither the current image's build nor the flake's inputs need
- Streams the image straight into `docker load` (no tarball on disk) and removes dangling aza-pg images, such as the tag's previous build
- Builds for the host architecture only: an amd64 image comes from an amd64 host, as in CI

**Requirements:** Docker; nothing else on macOS or a Linux host without Nix.

### CI/CD Builds

GitHub Actions workflows handle automated builds:

#### CI (ci.yml)

Runs on every push to main/dev/release and every PR: `bun run validate:all`, an amd64 image build, then one job per routine suite group (`bun scripts/test-all.ts --group <group>`).

#### Production Releases (publish.yml)

Runs when the `CI` workflow succeeds on the `release` branch (`workflow_run`):

- A Nix build per platform on native runners, and an SBOM of each image's exact closure (sbomnix)
- GitHub build-provenance attestation
- Pushes to `ghcr.io/fluxo-kt/aza-pg`
- Tagged with version and convenience tags

`publish.yml` is part of the release contract: current releases are automatic after the build, test, scan, manifest, signature, SBOM, attestation, GitHub Release, and public-artifact gates pass. Do not add a GitHub Environment approval gate without explicitly approving that release-contract change. If that change is approved, use [GITHUB_ENVIRONMENT_SETUP.md](GITHUB_ENVIRONMENT_SETUP.md).

Because `workflow_run` uses workflow definitions from the default branch, release-process edits must be present on `dev` (the default branch) before relying on them for production publishing.

**Version Format:** `MM.mm-TS-TYPE`

- `MM` = PostgreSQL major (18)
- `mm` = PostgreSQL minor (0)
- `TS` = release timestamp YYYYMMDDHHmm (UTC), taken from the newest `## [v…]` heading in the release commit's CHANGELOG.md
- `TYPE` = image type (single-node)

**Example:** `18.1-202511142330-single-node`

**Convenience Tags:**

- `18.0-single-node`
- `18-single-node`
- `18.0`
- `18`

#### Automated GitHub Releases

The publish workflow automatically creates GitHub Releases to showcase image contents and extension catalog. This provides:

- Extension list visibility on repository homepage
- Categorized catalog (AI/ML, time-series, GIS, search, security, operations)
- Quick start examples (Docker + SQL)
- Verification commands (Cosign signature, SBOM download)
- RSS/notification subscriptions for new releases

**How it works:**

1. `scripts/generate-release-notes.ts` reads extension manifest
2. Groups enabled extensions by category
3. Generates structured markdown with:
   - Extension catalog by use case with versions
   - Image metadata (tags, digest, platforms)
   - Quick start examples (Docker run + SQL CREATE EXTENSION)
   - Auto-configuration details
   - Verification commands
   - Documentation links

4. `create-release` job creates GitHub Release via `gh` CLI
5. Tag format: `v{pg-version}-{timestamp}`, without the image-type suffix (e.g., `v18.1-202511132330`)

**Release notes include:**

- Enabled extensions across all categories (see [Extension Catalog](EXTENSIONS.md))
- Version information for each extension
- Image digest and multi-platform confirmation
- Production-ready quick start commands
- Security verification steps

All data is dynamically generated from `docker/postgres/extensions.manifest.json`.

**Discoverability benefits:**

- Releases appear on GitHub homepage and repository insights
- Extension names indexed by GitHub search
- RSS feeds available for new releases (`/releases.atom`)
- Email notifications for watchers
- Historical record of extension changes per version

See workflow files in `.github/workflows/` for complete workflow details.

## CI/CD Build Design

**1. Security Scanning**

- vulnix (`scripts/security/vulnix-gate.ts`, build job, before the push) checks every store path of the image against NVD; `scripts/security/vulnix-whitelist.toml` lists the hits that do not affect the image, each with its evidence. It is the only scan of the C libraries: Trivy finds no OS package database in a Nix image

- SARIF upload runs only when the file exists (`hashFiles()` check), so a scan that wrote no SARIF does not fail the upload step
- The Trivy vulnerability DB is cached between runs (`actions/cache`, `.trivy-cache`)

**2. Native ARM64 Runners with Parallel Builds**

Each platform builds on its own native runner in parallel; no QEMU emulation.

**publish.yml jobs:**

1. **prep** - Validation and metadata (version, tags, labels, annotations)
2. **build** - Matrix builds on native runners (amd64 + arm64 in parallel), pushed by digest
3. **merge** - Multi-arch manifest from platform digests under the `testing-<sha>` tag
4. **test** - One job per routine suite group (`bun scripts/test-all.ts --group <g>`) on amd64, plus `extensions` on arm64 so the arm64 image is started before release; **test-complete** gates on all of them
5. **scan** - Security scanning (Dockle + Trivy)
6. **release** - Cosign signing, promotion to production tags, SBOM and provenance attestation
7. **create-release** - GitHub Release with generated notes
8. **verify-public-release** - Verifies the published GitHub Release, manifests, signatures, SBOM and attestation
9. **cleanup** - Deletes the run's testing images

**Key implementation:**

- **Push by digest:** each platform image is pushed under a run-scoped tag and recorded by its registry digest
- **Store cache:** `.github/actions/setup-nix` restores and saves the Nix store per OS and architecture
- **Native ARM64:** `ubuntu-24.04-arm` runner (NO QEMU during build)
- **Parallel execution:** Both platforms build simultaneously

### Technical Details

**Matrix Strategy:**

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - platform: linux/amd64
        runner: ubuntu-26.04
        artifact: linux-amd64
      - platform: linux/arm64
        runner: ubuntu-24.04-arm
        artifact: linux-arm64
```

Every workflow names its runner image (`ubuntu-26.04`, `ubuntu-24.04-arm`) instead of `ubuntu-latest`, so a runner upgrade lands as a commit that CI tests instead of on the date GitHub moves the label.

**Digest Handling:**

1. Each platform builds and pushes by digest (immutable reference)
2. Digests exported as artifacts (empty files named with SHA256 hash)
3. Merge job downloads digests and creates multi-arch manifest
4. All subsequent operations use merged manifest digest

See workflow files in `.github/workflows/` for complete implementation details.

## OCI Annotations for Multi-Arch Manifests

### Overview

GitHub Container Registry (GHCR) displays package metadata (description, license, documentation links) by reading **OCI annotations** from the image manifest. For multi-arch images, these annotations must be applied to the **image index** (manifest list), not just the individual platform images.

**Why annotations matter:**

- GitHub shows "No description provided" warning without `org.opencontainers.image.description`
- Source repository linking requires `org.opencontainers.image.source`
- License information displayed from `org.opencontainers.image.licenses`
- All standard OCI annotations improve discoverability and documentation

### Application Method

Annotations are applied using `docker buildx imagetools create` with `--annotation` flags. The `index:` prefix indicates the annotation applies to the image index (multi-arch manifest list) rather than individual platform manifests.

**Shape of the command** that `scripts/docker/create-manifest.ts` (merge job) and `scripts/release/promote-image.ts` (release job) run:

```bash
docker buildx imagetools create \
  -t ghcr.io/fluxo-kt/aza-pg:testing-sha \
  --annotation "index:org.opencontainers.image.title=aza-pg Single-Node PostgreSQL" \
  --annotation "index:org.opencontainers.image.description=PostgreSQL {version} with {count} extensions..." \
  --annotation "index:org.opencontainers.image.authors=Art Shendrik" \
  --annotation "index:org.opencontainers.image.version={version}-{timestamp}-single-node" \
  --annotation "index:org.opencontainers.image.source=https://github.com/fluxo-kt/aza-pg" \
  --annotation "index:org.opencontainers.image.licenses=MIT" \
  ghcr.io/fluxo-kt/aza-pg@sha256:{amd64-digest} \
  ghcr.io/fluxo-kt/aza-pg@sha256:{arm64-digest}
```

**Critical notes:**

- Annotations must be reapplied when creating new tags (they don't automatically propagate)
- Both merge and release jobs apply annotations to ensure all tags have proper metadata
- The `index:` prefix is required for multi-arch manifests (OCI 1.1 spec)
- Annotations are applied to the manifest list, not individual platform images

### Verification

Verify annotations are present in the image index:

```bash
# View manifest in raw format
docker buildx imagetools inspect ghcr.io/fluxo-kt/aza-pg:18-single-node --raw | jq '.annotations'

# Check specific annotation
docker buildx imagetools inspect ghcr.io/fluxo-kt/aza-pg:18-single-node --raw | \
  jq -r '.annotations."org.opencontainers.image.description"'

# Verify multi-arch structure
docker buildx imagetools inspect ghcr.io/fluxo-kt/aza-pg:18-single-node --raw | \
  jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture)"'
```

Expected output shows both platforms and all annotations:

```json
{
  "org.opencontainers.image.title": "aza-pg Single-Node PostgreSQL",
  "org.opencontainers.image.description": "PostgreSQL {version} with {count} extensions...",
  "org.opencontainers.image.authors": "Art Shendrik",
  "org.opencontainers.image.source": "https://github.com/fluxo-kt/aza-pg",
  "org.opencontainers.image.licenses": "MIT"
}
```

### Impact on Existing Tags

GHCR shows the metadata of each tag's most recent push. A tag published without manifest-level annotations keeps showing "No description provided" until a `publish.yml` run re-pushes it; every release re-pushes the convenience tags with annotations.

### Applied Annotations

Standard OCI annotations applied to all published images:

| Annotation                               | Purpose             | Format/Example                                                                       |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `org.opencontainers.image.title`         | Display name        | `aza-pg Single-Node PostgreSQL`                                                      |
| `org.opencontainers.image.description`   | Package description | `PostgreSQL {version} with {count} extensions...`                                    |
| `org.opencontainers.image.vendor`        | Organization        | `fluxo-kt` (image labels only; the index carries `org.opencontainers.image.authors`) |
| `org.opencontainers.image.version`       | Full version tag    | `{major}.{minor}-{timestamp}-{type}`                                                 |
| `org.opencontainers.image.created`       | Build timestamp     | RFC 3339 (`2025-11-14T23:30:00Z`)                                                    |
| `org.opencontainers.image.revision`      | Git commit SHA      | `{sha}`                                                                              |
| `org.opencontainers.image.source`        | Repository URL      | `https://github.com/fluxo-kt/aza-pg`                                                 |
| `org.opencontainers.image.url`           | Homepage URL        | `https://github.com/fluxo-kt/aza-pg`                                                 |
| `org.opencontainers.image.documentation` | Docs URL            | `https://github.com/fluxo-kt/aza-pg/blob/main/README.md`                             |
| `org.opencontainers.image.licenses`      | License             | `MIT`                                                                                |

Image config labels (what `docker inspect` shows) come from `nix/image.nix`. They carry every standard key above, plus `io.fluxo-kt.aza-pg.postgresql.version`. Two differ from the annotations: `version` is the PostgreSQL version (`18.6`), because the release tag is chosen after the image is built, and `title`/`description` are worded without the extension count. The index annotations, written by `scripts/utils/oci-metadata.ts`, add two custom keys:

| Annotation                              | Purpose                 | Format/Source                                     |
| --------------------------------------- | ----------------------- | ------------------------------------------------- |
| `io.fluxo-kt.aza-pg.postgresql.version` | PostgreSQL version      | `MANIFEST_METADATA.pgVersion` (`{major}.{minor}`) |
| `io.fluxo-kt.aza-pg.catalog.enabled`    | Enabled extension count | From manifest (count where `enabled != false`)    |
| `io.fluxo-kt.aza-pg.catalog.total`      | Total extension count   | From manifest (total entries)                     |

## Build Architecture

### Nix Build

`flake.nix` defines the image; `nix/extensions.nix` and `nix/image.nix` hold the details:

- **server** - nixpkgs' PostgreSQL with JIT (LLVM, only `libLLVM.so` kept) and without features no container uses; the reason for each option sits beside it
- **extensions** - every enabled manifest entry built from its pinned commit, with a nixpkgs recipe where the entry names one (`nix.package`), else from `build.type`
- **image** - `dockerTools.streamLayeredImage` over the server, the extensions, the entrypoint scripts and configs, and the few tools the scripts call. Nothing else reaches it: no package manager, compiler or Bun

### Supply Chain Security

**Pinning:**

- Source-built extensions name a git tag (or ref) in `scripts/extensions/manifest-data.ts`; `bun run generate` resolves it to a commit SHA in `docker/postgres/extensions.manifest.json`, and the build fetches that commit
- `flake.lock` pins nixpkgs, and with it the server, glibc and every library, to one commit

**Why SHA pinning:**

- Tags can be force-pushed (mutable)
- Commit SHAs are immutable
- Prevents supply chain attacks via tag mutation

**Build Attestation:**

- SBOM (Software Bill of Materials) of each image's exact Nix closure, generated by sbomnix
- Provenance proves build authenticity
- Generated automatically in CI/CD via GitHub Actions

### Extension System

See [EXTENSIONS.md](EXTENSIONS.md) for the complete extension catalog with enabled/disabled status and classification details (tools vs modules vs extensions, preloaded defaults). The manifest at `scripts/extensions/manifest-data.ts` is the single source of truth for all extension configuration.

**Manifest-Driven:**

All extension metadata lives in `scripts/extensions/manifest-data.ts`:

- Enabled/disabled state
- Git tags/refs for every non-builtin entry
- Dependencies and build flags

**Customizing Extensions:**

To disable an extension (e.g., reduce image size):

1. Edit `scripts/extensions/manifest-data.ts`: Set `enabled: false` and add `disabledReason`
2. Regenerate: `bun run generate` (manifest JSON and the other generated files)
3. Rebuild: `bun run build`

**Default preloads:** Disabling an entry that is preloaded by default also drops it from the default `shared_preload_libraries` when `bun run generate` runs (the pre-commit hook does it too); `validate-manifest.ts` only checks that the generated default matches the manifest. Databases that already created the extension can no longer load it.

See [EXTENSIONS.md](EXTENSIONS.md) for complete details.

## Testing & Validation

Run regression test suite:

```bash
# Full: build image, validate:all, every routine suite group
bun run test:all

# Fast mode (validation only, skips Docker build and functional tests)
bun run validate

# Docker suites only, against an existing image
bun scripts/test-all.ts [--group G[,G…]] [--image REF] [--shuffle[=SEED]]
```

Release validation requires both exit code `0` and a final summary with `Failed: 0`; a zero exit code alone is insufficient.

The test suite includes:

- **Validation**: manifest, TypeScript, linting, formatting, docs, shell scripts, YAML
- **Build**: Docker image build (`bun run build`)
- **Functional**: the Docker suite groups in `SUITES` of `scripts/test-all.ts` (extensions, security, stacks, features, regression)

See [TESTING.md](TESTING.md) for detailed testing documentation.

### Individual Validation Commands

```bash
# Fast validation (skips Docker build)
bun run validate

# Full validation (includes all checks)
bun run validate:all

# Aliases (run validate with different modes)
bun run lint                      # Check only (alias for validate)
bun run format                    # Check + auto-fix (alias for validate:fix)
bun scripts/extensions/validate-manifest.ts  # Manifest validation
bun scripts/ci/lint-yaml-tracked.ts  # YAML files (pinned yamllint image; .yamllint, .yamllint-workflows)
```

ShellCheck (every tracked `*.sh`) runs inside `bun run validate:all`; it is the reference invocation.

## Troubleshooting

### Build Failures

**`nix build failed`:** the log above it names the derivation that failed and its build output. A patch that no longer applies, a pgrx release Nix lacks, or a `pgVersion` that differs from nixpkgs' server each fail with a message saying what to change ([VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md)).

**Out of disk space during build:**

**Solution:** collect Nix store garbage (paths no build roots keep), then reclaim aza-pg Docker leftovers:

```bash
bun scripts/nix/nix.ts store gc
bun run cleanup
```

**SHA verification failed:**

```
fatal: reference is not a tree: <commit>
```

**Solution:** The commit resolved from the entry's tag may be gone (tag moved or history rewritten). Compare with upstream:

```bash
git ls-remote https://github.com/OWNER/REPO.git 'refs/tags/TAG' 'refs/tags/TAG^{}'
```

Fix the tag in `scripts/extensions/manifest-data.ts`, then `bun run generate` to re-resolve the commit.

### CI Workflow Failure Diagnostics

**Test failures:** each `Test <group>` job prints every failed suite's full output (a suite that cannot start PostgreSQL includes the container's last log lines). The job log is the only record: `test-all` removes every container a suite started before it exits, so no step after it could collect their logs.

**Scan failures** (`scan-failure-diagnostics-<SHA>`): full Trivy output, Trivy JSON, image manifest metadata and the SARIF file when generated.

Artifacts are kept for 7 days (GitHub Actions run page → Artifacts).

### Performance Issues

**Slow first build:**

**Expected:** A cold store compiles PostgreSQL and every extension (the Rust ones longest); later builds reuse the store and rebuild only what changed.

## Development Standards

All builds follow the Bun-first philosophy:

**Tooling:**

- **Bun** for all TypeScript scripts (no Node.js)
- **Oxlint** for linting (50-100x faster than ESLint)
- **Prettier** for formatting (will migrate to Oxfmt when stable)
- **ArkType** for validation (NOT Zod - faster runtime)
- **bun-git-hooks** for pre-commit hooks

**Quality Checks:**

- Pre-commit (`scripts/pre-commit.ts`): oxlint --fix, prettier --write, regenerate if `manifest-data.ts` changed, then `bun run validate`
- No pre-push hook; CI runs `bun run validate:all` on every push and PR

See [TOOLING.md](TOOLING.md) for complete tooling decisions.

## Script Reference

Build, test and operational scripts are Bun TypeScript under `scripts/`.

### Shared Utilities

New scripts import these instead of writing their own:

- `scripts/utils/docker.ts`: `checkCommand(cmd)`, `checkDockerDaemon()`, `isDockerDaemonRunning()`, `waitForPostgres({ container, timeout })` (or `{ host, port, user, timeout }`; throws on timeout), `generateUniqueContainerName(prefix)`, `dockerCleanup(container)`
- `scripts/utils/logger.ts`: `info()`, `success()`, `warning()`, `error()`, `section()`

```typescript
import { checkDockerDaemon, waitForPostgres } from "../utils/docker";
import { info } from "../utils/logger";

await checkDockerDaemon();
await waitForPostgres({ container, timeout: 60 });
info("PostgreSQL is ready");
```

### Test Scripts

Docker suites are listed once, in `SUITES` of `scripts/test-all.ts`, and run by group; `docs/TESTING.md` "Running Tests" has the commands and what each group proves.

#### wait-for-postgres.ts [host] [port] [user] [timeout]

Waits for PostgreSQL to accept connections.

**Usage:**

```bash
bun scripts/test/wait-for-postgres.ts                             # localhost:5432, 60s
bun scripts/test/wait-for-postgres.ts db.example.com 5432 admin   # Remote host
PGHOST=localhost PGPORT=6432 bun scripts/test/wait-for-postgres.ts  # Via PgBouncer
bun scripts/test/wait-for-postgres.ts localhost 5432 postgres 120   # 2min timeout
```

**Dependencies:** `pg_isready`

---

### Operational Scripts (tools/)

#### backup-postgres.ts [database] [output-file]

Creates compressed PostgreSQL backup using `pg_dump`.

**Features:**

- Auto-named backup files with timestamp
- Gzip compression
- Backup validation (file size, gzip integrity)
- Remote host support via `PGHOST`/`PGPORT`/`PGUSER`
- Safe: prevents overwriting existing backups

**Usage:**

```bash
bun scripts/tools/backup-postgres.ts                      # Backup 'postgres' db
bun scripts/tools/backup-postgres.ts mydb                 # Backup 'mydb'
bun scripts/tools/backup-postgres.ts mydb backup.sql.gz   # Custom output file
PGHOST=db.example.com PGUSER=admin bun scripts/tools/backup-postgres.ts mydb
```

**Environment variables:**

- `PGHOST` - PostgreSQL host (default: localhost)
- `PGPORT` - PostgreSQL port (default: 5432)
- `PGUSER` - PostgreSQL user (default: postgres)
- `PGPASSWORD` - PostgreSQL password (required for remote)

**Dependencies:** `pg_dump`, `psql` (dumps roles too), `pg_isready`, `gzip`, `du`

---

#### restore-postgres.ts <backup-file> [database]

Restores PostgreSQL database from backup.

**Features:**

- Compressed (.gz) and plain SQL file support
- Backup file validation (existence, readability, gzip integrity)
- Interactive confirmation (destructive operation)
- Database statistics after restore

**Usage:**

```bash
bun scripts/tools/restore-postgres.ts backup.sql.gz           # Restore to 'postgres'
bun scripts/tools/restore-postgres.ts backup.sql.gz mydb      # Restore to 'mydb'
PGHOST=db.example.com bun scripts/tools/restore-postgres.ts backup.sql.gz
```

**Environment variables:** Same as `backup-postgres.ts`

**Dependencies:** `psql`, `pg_isready`, `gunzip`

---

#### promote-replica.ts [OPTIONS]

Promotes PostgreSQL replica to primary role.

**Features:**

- Refuses unless the container's server is a running standby (read with `pg_controldata`, no database login)
- Refuses while the standby still streams from a live upstream (`pg_stat_wal_receiver`); `--force` overrides
- `pg_ctl promote` on the running server, which waits until the server is a primary (no restart)

**Options:**

- `--container NAME` - Container name (default: `aza-pg-replica-postgres-replica`)
- `--data-dir PATH` - Data directory (default: the container's `$PGDATA`)
- `--yes` - Skip confirmation prompt
- `--force` - Promote even while still streaming from a live upstream
- `--help` - Show help message

**Usage:**

```bash
bun scripts/tools/promote-replica.ts                     # Interactive promotion
bun scripts/tools/promote-replica.ts --container my-replica --yes    # Skip confirmation
```

**Dependencies:** `docker`

**Warnings:**

- One-way operation (cannot revert)
- Ensure old primary is stopped (avoid split-brain)
- Update client connection strings after promotion

---

#### generate-ssl-certs.ts

Generates self-signed SSL certificates for PostgreSQL TLS.

**Output:**

- `server.key` - Private key (mode 600)
- `server.crt` - Self-signed certificate
- `ca.crt` - Copy of `server.crt`

**Usage:**

```bash
bun scripts/tools/generate-ssl-certs.ts <cert-directory> [days-valid]
bun scripts/tools/generate-ssl-certs.ts stacks/primary/certs 3650
```

**Dependencies:** `openssl`

---

### Recommended Test Sequence

`bun run test:all` builds the image, runs `validate:all`, then every routine suite group. Docker suites are listed once, in `SUITES` of `scripts/test-all.ts`, and run by group; `docs/TESTING.md` "Running Tests" has the commands and what each group proves.

### Operational Workflows

#### Backup and Restore Cycle

```bash
# Backup production database
PGHOST=prod.db.example.com PGPASSWORD=xxx bun scripts/tools/backup-postgres.ts mydb

# Restore to staging
PGHOST=staging.db.example.com PGPASSWORD=yyy bun scripts/tools/restore-postgres.ts backup_mydb_20250131_120000.sql.gz mydb
```

#### Replica Promotion (Failover)

```bash
# 1. Stop old primary (critical!)
docker stop aza-pg-postgres-primary

# 2. Promote replica
bun scripts/tools/promote-replica.ts --container aza-pg-replica-postgres-replica

# 3. Verify promotion
docker exec aza-pg-replica-postgres-replica psql -U postgres -c "SELECT pg_is_in_recovery();"  # Should return 'f'

# 4. Update application connection strings to new primary
```

### Script Dependencies

**Required for all scripts:**

- `bun` (install via `curl -fsSL https://bun.sh/install | bash`)
- `docker` (Docker Engine or Docker Desktop)

**Test scripts:**

- `psql` / `pg_isready` (for PgBouncer test)

**Tool scripts:**

- `pg_dump`, `pg_isready`, `psql` (PostgreSQL client tools)
- `gzip`, `gunzip`, `du` (standard Unix utilities)
- `openssl` (for SSL cert generation)

### Contributing Scripts

- Use the shared utilities above and Bun APIs (AGENTS.md "Development Standards"); import without file extensions.
- Remove containers in `finally`, never in a `process.on("exit")` handler: an exit handler cannot wait for async work.
- Describe usage and the reason for each non-obvious choice in the file's header comment.

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System design and data flows
- [EXTENSIONS.md](EXTENSIONS.md) - Extension catalog and customization
- [TESTING.md](TESTING.md) - Test patterns and session isolation
- [PRODUCTION.md](PRODUCTION.md) - Deployment and security
- [TOOLING.md](TOOLING.md) - Tech choices and locked decisions
- [../AGENTS.md](../AGENTS.md) - Quick reference for development

## Quick Reference

```bash
# Build
bun run build                         # Local build with cache

# Validate
bun run validate                      # Fast checks
bun run validate:all                  # Full suite

# Test
bun run test:all                      # Full test suite
bun run validate                      # Validation only (fast)

# Generate
bun run generate                      # Regenerate all configs

# Deploy
cd stacks/primary && docker compose up  # Test locally
```

---

**Production-ready PostgreSQL builds with supply chain security and intelligent caching.**
