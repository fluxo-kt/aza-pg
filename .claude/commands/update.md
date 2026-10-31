---
name: /update
description: Comprehensive dependency and extension update guide
argument-hint: (optional additional notes)
id: p-update
category: project
tags: [project, update, maintenance]
---

# /update

You are updating dependencies and extensions in the aza-pg PostgreSQL container project.

**CRITICAL**: See AGENTS.md "AI Agent Knowledge Updates" section for surprising facts (PG18 released Sep 2025, pgrx needs Rust 1.88+, etc.)

OPTIONAL ADDITIONAL NOTES FROM USER: $ARGUMENTS

# Update Process

## Pre-Flight: Docker Availability Check (FIRST)

Before launching Docker checks, confirm Docker is available. Keep unavailable runtime checks open; they block acceptance of the update, not preservation of finished local work:

```bash
docker info >/dev/null 2>&1 && echo "Docker: OK" || echo "Docker offline: finish independent work; runtime verification remains open"
```

If Docker is offline, finish independent discovery and focused commits. Restore Docker and complete every affected runtime check before presenting the update for acceptance.

## Pre-Flight: Detect Available Updates (RUN IN PARALLEL)

Use parallel tool calls or sub-agents only when the active environment supports them. Keep each
check bounded, verify every returned claim locally, and never let a sub-agent make the decision.
Do not start implementation from only one row of this list. The update scope is the full matrix
below; a clean Bun/actions update is still incomplete until nixpkgs (PostgreSQL and every library), extension
and compose-image surfaces have also been checked.
Check:

1. **Git-based extensions**:

   ```bash
   bun scripts/extensions/check-updates.ts --format=json > /tmp/aza-updates.json
   echo "exit=$?"   # 0 = no ENABLED entry has an update, 1 = one does (NOT a failure), 2 = the check itself failed
   ```
   stdout carries only the report (progress goes to stderr), so the JSON file parses as-is. Exit 1 is the
   normal "work to do" answer: in a Bun script use `.nothrow()` and branch on 1 vs 2, never treat non-zero
   as broken. Exit 0 can still carry `updateAvailable: true` rows for disabled entries (Phase 5.5 decides
   those), so read the JSON, not just the code.
   Mandatory interpretation:
   - Treat `sourceType: "git-ref"` rows exactly like tagged updates: compare `current` vs `latest`
   - If any git-ref row has `latest: null`, stop and fix connectivity/parsing before proceeding
   - If any enabled row has `updateAvailable: true`, either update it now or document a concrete skip reason
   Verify candidate updates are true upgrades in the same release family:
   - Ignore mismatched tag-family noise (e.g., monorepo tags like `foo@X.Y.Z` vs plain `X.Y.Z`)
   - Ignore prereleases (`-beta`, `-rc`) unless intentionally targeting prereleases
   - Ignore downgrades (`current > candidate`) caused by mixed/non-semver tags
   - If GitHub API rate limits (`403`), verify the checker still resolves via tags API / `git ls-remote`
   - Compare compatible stable tags even when the latest-release endpoint succeeds: release metadata can lag a published tag or container image. Wrapper images can also appear without any matching Git tag: use the registry's complete compatible tag list, then run the pinned binary to verify its component version. A wrapper release name alone proves neither publication nor bundled contents.

2. **Bun dependencies**:

   ```bash
   bun outdated  # Check what's outdated
   ```

3. **nixpkgs** (every round — see Phase 3): it supplies PostgreSQL, glibc and every library, so their security
   fixes reach the image only through `flake.lock`. Due when the locked revision is behind the channel head:

   ```bash
   git ls-remote https://github.com/NixOS/nixpkgs refs/heads/nixos-unstable   # channel head
   jq -r .nodes.nixpkgs.locked.rev flake.lock                                 # locked revision
   ```

   The `sbomnix` input (publish.yml's SBOM generator) is pinned to a release tag, which `flake update` never
   moves: due when `gh release view -R tiiuae/sbomnix --json tagName` names a newer tag. Set it in `flake.nix`,
   run `bun scripts/nix/nix.ts flake lock`, then run publish.yml's "Generate SBOM" command for this host's system:
   CI never runs that step, so a broken bump would otherwise surface only mid-release.

4. **Companion images** — every container image the repo runs or tells operators to run (not in manifest!).
   `check-updates.ts` (item 1) already reports each image pinned in `stacks/` and `deployments/` against its
   upstream releases, naming the files that pin it. A row "could not check … IMAGE_SOURCES" is a new image:
   add its GitHub repository to `IMAGE_SOURCES` in that script. Docs copying a companion pin are held to it by
   `validate`'s Companion Image Pins. The stack suites pull the stacks' images, but nothing pulls an image
   only `deployments/` uses: check each still resolves (`docker buildx imagetools inspect <ref>`). Update
   procedure: Phase 5.6.

## Pre-Flight: Additional Checks (MANDATORY)

5. **Test file version strings**: Search test files for hardcoded version strings of extensions being updated:
   ```bash
   # TypeScript test files — search ALL scripts/ subdirs (scripts/test/, scripts/docker/, scripts/config/, etc.)
   command grep -rn -E "0\.8|2\.8|0\.5" scripts/ | command grep -iE "version|include|assert" | command grep -v "\.bun/"
   # Hardcoded PG major in paths breaks on a PG major bump (tool checks read binaryPath/soFileName and pg_config)
   command grep -rn -E "postgresql/[0-9]+/lib" scripts/ | command grep -v "\.bun/"
   ```
   Regression expected outputs hold no version strings (`scripts/test/test-extension-versions.ts` owns versions).
   These WILL break tests if not updated alongside the extension. This is the #1 missed item.

6. **Upstream build changes**: for each extension being updated, check the upstream build system and
   dependencies at the exact new tag. An entry with `nix.package` reuses nixpkgs' recipe, which may not follow an
   upstream switch (e.g. PGXS → Meson) or a new dependency; override it in `nix/extensions.nix`.

7. **Pre-plan the changelog obligation** (MANDATORY): if you touch any image-affecting source
   (`scripts/extensions/manifest-data.ts`, `docker/postgres/`, `stacks/*/compose.yml`), you MUST update `CHANGELOG.md` in the
   same update round before Phase 12.

## Phase 1: Review Upstream Changes (CRITICAL FOR TESTS & CHANGELOG)

For EACH extension to update, inspect upstream delta before writing tests or changelog text:

```bash
# Method 1: GitHub releases (PREFERRED — curl | jq is broken via RTK proxy)
gh release view vX.Y.Z --repo OWNER/REPO --json body --jq .body

# Method 2: Latest release (no tag needed)
gh release view --repo OWNER/REPO --json body --jq .body

# Method 3: Upstream CHANGELOG (raw file — still works via curl since RTK only transforms API JSON)
curl -s https://raw.githubusercontent.com/OWNER/REPO/NEW_TAG/CHANGELOG.md | head -100

# Method 4: Compare tags via gh
gh api repos/OWNER/REPO/compare/OLD_TAG...NEW_TAG --jq '.commits[].commit.message'

# Method 5 (MANDATORY for git-ref updates): inspect commit range and touched paths
git clone https://github.com/OWNER/REPO.git /tmp/EXT-REPO
cd /tmp/EXT-REPO
git log --oneline OLD_REF..NEW_REF
git diff --name-status OLD_REF..NEW_REF
```

**⚠️ RTK proxy note**: `curl` to `api.github.com` returns RTK-filtered non-JSON output — `| jq` will fail. Always use `gh` CLI for GitHub API calls.

**MANDATORY evidence discipline**:
- Do not claim "bug fixes", "schema fixes", or "new features" unless the commit range proves it
- For git-ref bumps, summarize what changed by path class (`src/`, `sql/`, docs/CI/release scripts)
- If only CI/docs/release metadata changed, say exactly that in CHANGELOG (no runtime-claim inflation)

**Document findings** — you'll need this for:
- Writing new tests (Phase 6)
- Updating CHANGELOG.md (Phase 9)

## Phase 2: Bun Dependencies

```bash
# Update package dependencies to latest versions
bun update --latest

# Normalize bun.lock root specs back to package.json ranges after --latest resolution
bun install

# If Bun reports blocked lifecycle scripts, inspect them before proceeding.
# Trust only scripts that are expected, necessary, and runnable; otherwise document why blocked is acceptable.
bun pm untrusted

# Validate immediately
bun run validate
```

**⚠️ Linter version jumps**: If oxlint/squawk jumps multiple minor versions, new lint rules may flag
existing code. Run `bun run validate` immediately and fix issues before proceeding. Do NOT blindly
disable new rules — evaluate each one. If a rule is a false positive, suppress only that specific
rule with a comment; if legitimate, fix the code.

**⚠️ OSV security scanner blocks install (no-TTY)**: read the scanner selected by `bunfig.toml [install.security]` and follow `docs/TOOLING.md#Bun OSV install gate`; do not substitute another scanner or bypass it. Inspect the reported advisory and the working-tree diff after a failed install. The correct fix is
to force the affected package to a patched version via a package.json `overrides` block, then re-install:
```jsonc
"overrides": { "ws": "^8.20.1", "uuid": "^14.0.0" }  // pin transitive deps to patched versions
```
Look up the fixed version (the advisory states it), prefer the latest compatible line, and VERIFY the
override did not break the dependent — run its tests (e.g. `bun test scripts/pgflow/schema-fixture.test.ts`
for @pgflow-tree deps) plus `bun run validate`. These dev/test-only deps are absent from the final image
(no Bun, no node_modules), so the CHANGELOG note belongs under Development, not a user-facing section.

**⚠️ ALWAYS check Bun runtime version separately** — `bun update` bumps package dependencies (incl.
`@types/bun`) but does NOT update the Bun runtime pinned in `.tool-versions`. These are independent:

```bash
# Check current pinned runtime version vs latest stable
cat .tool-versions | command grep bun          # e.g. "bun 1.3.10"
gh release view --repo oven-sh/bun --json tagName --jq .tagName  # e.g. "bun-v1.3.11"
# NOTE: `bun upgrade` has no --dry-run flag — it upgrades immediately; do NOT run it
```

If a new stable runtime is available, update `.tool-versions` manually:
```bash
# Edit .tool-versions: bump bun X.Y.Z to latest stable
```

Note: `@types/bun` may lag the runtime release. That is expected.
Keep `.tool-versions` and `@types/bun` approximately in sync but they need not be identical.

**TypeScript major bumps**: TypeScript 7+ is the native (Go) compiler, shipped as per-platform
`@typescript/typescript-<os>-<arch>` packages; `import "typescript"` now yields only the version (the
old compiler API is gone; a different one sits under `typescript/unstable/*`). Before accepting
a major bump: `rg -n "from ['\"]typescript['\"]"` must find no programmatic users (this repo only
runs the `tsc` CLI); `bun.lock` must list the `linux-x64` and `linux-arm64` packages (CI runners);
compare `tsc --noEmit --listFilesOnly` file sets between old and new (same project files); and plant
a type error in a scratch `scripts/*.ts` file to prove the new `tsc` exits 1 on it. A fast green
proves nothing until the plant fails.

## Phase 2.5: GitHub Actions Pins

GitHub Actions use SHA-pinned `uses:` references for security. Run `actions-up` to bump all SHAs
to the latest verified commit for each action's current tag.

```bash
# Update all GitHub Actions SHA pins to latest
actions-up --yes --include-branches --prefer-tags
```

This updates the `uses:` SHA in every workflow and composite action. It will report how many
actions were updated and how many were **breaking** (major version bumps).

### MANDATORY: Identify and Audit Breaking Changes

`actions-up` reports breaking changes (major version jumps) separately. **These require manual
review** — do NOT blindly accept without checking each one.

**For every major-version bump** (e.g., `actions/upload-artifact` bumping a major version):

1. Fetch the upstream release notes (RTK proxy breaks `curl | jq` — use `gh` instead):
   ```bash
   # PREFERRED — works reliably via RTK proxy
   gh release view vN.0.0 --repo OWNER/REPO --json body --jq .body
   # Or fetch raw RELEASES.md (curl of raw content works fine — RTK only transforms API JSON):
   curl -s https://raw.githubusercontent.com/OWNER/REPO/main/RELEASES.md | head -80
   ```

2. Check for each category of breaking change:
   - **Renamed or removed inputs**: does your workflow pass an input that no longer exists?
   - **Renamed or removed outputs**: does a subsequent step reference `steps.X.outputs.Y`?
   - **Behaviour changes** (silent→loud defaults): new defaults may turn previously-tolerated
     warnings into hard failures — this is the most dangerous category
   - **New required inputs**: does the action now require a parameter you haven't set?
   - **Runner version requirements**: Node.js runtime version bump = new minimum runner version;
     self-hosted runners below the threshold will fail with "nodeXX not found" (check release notes
     for the minimum runner version required by the action's Node.js release)

3. Fix any incompatible usages before committing.

### Known Breaking Patterns for Common Actions

| Action | Typical major-version changes | What to verify |
|--------|------------------------------|----------------|
| `actions/upload-artifact` | Node.js runtime bump; additive params | Generally safe; check release notes for new required inputs or default changes |
| `actions/download-artifact` | Default strictness changes (hash-mismatch handling); new inputs | Check if workflow relied on lenient defaults (e.g., silent mismatch tolerance) |
| `sigstore/cosign-installer` | Cosign bundle format compatibility; default cosign version bump | If you pin `cosign-release:`, verify pinned version still installs; check CLI compat |
| `actions/attest-build-provenance` | Node.js runtime bump; new optional inputs (additive) | Check runner version requirement in release notes; new additive inputs are safe if not referenced |
| `actions/checkout` | Credentials storage location can change | Breaks scripts parsing `.git/config` directly; normal git usage unaffected |
| `actions/cache` | Input removals/renames (e.g., `save-always` was removed) | Grep all `cache:` steps for removed/renamed inputs; use `cache-hit` output pattern |
| `docker/login-action` | Has historically been runtime-only (no interface changes) | For self-hosted runners: check Node.js runtime requirement in release notes |
| `docker/setup-qemu-action` | Has historically been runtime-only (no interface changes) | Same pattern as docker/login-action; GitHub-hosted runners always qualify |

### MANDATORY: Audit for Stale Prose Version Comments

**`actions-up` updates the SHA AND the `# vX.Y.Z` tag on each `uses:` line, but does NOT update
version references in prose comments elsewhere in the file** (e.g., a comment in a `run:` step
or a description block that mentions an old version like `# Uses upload-artifact v6`).

After running `actions-up`, scan ALL workflow and composite action files for stale prose comments:

```bash
# Find prose version references that may be stale (distinct from the uses: line comments)
command grep -rn "@v[0-9]" .github/workflows/ .github/actions/ | command grep "#"
```

Cross-reference each result against the `# vX.Y.Z` tag on the corresponding `uses:` line.
Update any prose comment that references an old version. This is easy to miss and creates
actively misleading documentation.

### MANDATORY: Fix Branch-Pinned Reusable Workflow Refs

Use the installed `actions-up` to resolve action and reusable-workflow pins, including branches. Inspect its actual update and skip results; do not infer support from an older tool version. `--json` is for the dry-run report and cannot be combined with `--yes`.

After `actions-up`, manually check for any remaining branch-pinned reusable workflow calls:

```bash
# Find all job-level uses: with branch refs (not SHA-pinned)
command grep -rn "uses:.*\.yml@[a-zA-Z]" .github/workflows/ | command grep -v "@[0-9a-f]\{40\}"
```

For each remaining branch reference, inspect the tool's skip reason and correct its invocation or integration. Every new or updated `uses:` SHA comes from `actions-up`; never resolve or type a replacement by hand.

This is especially important for reusable workflows with broad permissions (`contents: write`,
`packages: write`, etc.) — a compromised upstream branch would get those permissions on the
next manual or scheduled invocation.

### MANDATORY: Pin Container Images in Workflow Shell Steps

`actions-up` only updates `uses:` refs. It does not see Docker images embedded in `run:` blocks.
After action updates, scan workflow/composite scripts for mutable images and pin them:

```bash
command grep -rn -E ":[Ll]atest\\b" .github/workflows/ .github/actions/ scripts/ | command grep -E "docker run|image"
```

For security scanners, prefer the same pinned container used by local tooling (for example,
`scripts/security/cve-scan.ts`) so CI diagnostics and local scans use the same scanner family.

Tool images run by scripts (actionlint, yamllint, trivy) are invisible to `actions-up` and
`bun outdated`, so bump them here. List them:

```bash
rg -n '"[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}"' scripts .github   # digest pins
bun scripts/extensions/check-updates.ts                                           # reports every repo:tag@sha256 tool image in scripts/ and .github/
```

A digest pin without a tag gets a "could not check" row (exit 2): rewrite it as `repo:tag@sha256:…`.
`nixos/nix` (local Nix, `scripts/nix/nix.ts`) must equal CI's Nix: set its tag to the `nix_version=` in the pinned `cachix/install-nix-action`'s `install-nix.sh` after every `actions-up` run. A newer Docker Hub tag waits until that action ships it. A wrapper image's tag versions the wrapper, not the tool, so also run the pinned binary's `--version`
against the tool's upstream release: a wrapper that stopped publishing reads as "up to date".

For each, read the latest release, resolve the index digest with `docker buildx imagetools inspect`,
replace the reference everywhere it appears, and run the check that uses it (`bun run validate:all`
runs actionlint and yamllint).

**Validate after actions-up**:
```bash
bun run validate:all  # catches yamllint and workflow syntax issues
```

## Phase 3: nixpkgs (ALWAYS CHECK — Security Patches!)

`flake.lock` pins nixpkgs, which supplies PostgreSQL, glibc and every C library; their security fixes reach the image
only by bumping it, so every round bumps it unless pre-flight item 3 shows it current. After the bump run
`bun scripts/security/vulnix-gate.ts` (the release gate): a hit means upgrade the package; only a CVE proven not to
affect the image goes into `scripts/security/vulnix-whitelist.toml`, with its evidence. Entries name a package
version, so a bumped package's entry no longer matches: re-check its CVEs, then move or delete the entry.
Judge a hit from the CVE record and the nixpkgs source (applied patches, affected code path), never vulnix's version
match alone: it reports name collisions and already-patched builds. vulnix sees only CVEs NVD has matched to a package
name, so also read the security pages of PostgreSQL, OpenSSL and glibc for the shipped versions.
After `bun run build` and before (never beside) `test:all`, `bun run security:scan HEAD aza-pg:pg18` runs both scanners on what this round will release:
vulnix on HEAD's closure, Trivy on the local image (Rust crates, bundled JS). Without the image argument Trivy scans
the last release, not HEAD.

```bash
bun scripts/nix/nix.ts flake update nixpkgs
bun run build   # flake.nix refuses a pgVersion that differs from nixpkgs' server and names the right one
```

- **PostgreSQL minor moved**: set `MANIFEST_METADATA.pgVersion` to the version the build names, regenerate, add the
  CHANGELOG entry.
- **glibc moved**: build the old and new images, run `bun scripts/nix/compare-en-us-order.ts <old> <new>`. "same" adds
  the new version to the `same` list in the entrypoint template's glibc migration; otherwise the first start on the
  new image rebuilds libc-collated indexes, which the CHANGELOG must say. Only a PostgreSQL sort decides this:
  coreutils `sort` orders differently from PostgreSQL on the same glibc.
- **Closure review**: every new store path in the image names the shipped feature that needs it
  (`docker run --rm --entrypoint sh <image> -c 'du -sk /nix/store/* | sort -rn | head'`); see AGENTS.md invariants.

**⚠️ New security settings in PG minors**: a minor release can add a setting whose default refuses
something the image ships. PostgreSQL 18.6 added `output_plugin_libraries`, refusing (superusers
included) any logical-decoding plugin not listed, which would have broken the shipped wal2json. On every
minor bump, read the release notes' new settings and their defaults. When adding or renaming a logical
decoding plugin, add it to the `POSTGRES_OUTPUT_PLUGIN_LIBRARIES` default in
`docker/postgres/docker-auto-config-entrypoint.sh.template` and `docs/ENVIRONMENT-VARIABLES.md`.

Rosetta (Docker Desktop/OrbStack on Apple silicon) runs amd64 images but cannot choose a CPU model,
and its `/proc/cpuinfo` lists no `avx`/`avx2` flags, so a Rosetta run says nothing about a specific x86
CPU. To prove a binary runs on an older or newer CPU, use QEMU user mode with `-cpu Nehalem` / `-cpu
Haswell` (vectorscale procedure: docs/VERSION-MANAGEMENT.md Procedure 4). QEMU user mode cannot run
`initdb` or a full server (they start `postgres` child processes, which leave QEMU without binfmt
registration), so: export the amd64 image's filesystem, `initdb` under Rosetta, then in an arm64
container with `qemu-user` run `qemu-x86_64 -cpu Nehalem -L <rootfs> <rootfs><the image's postgres, `command -v
postgres`> --single -D <pgdata> postgres` and feed it SQL on stdin.

**⚠️ PG MAJOR version bump** (18→19): additional files need updating beyond manifest-data.ts:
- Tool checks need no edit: `testToolsPresent` finds each tool by its manifest entry's `binaryPath`/`soFileName` and takes PG-major paths from `pg_config`; still grep `scripts/` for hardcoded `postgresql/[0-9]+/` paths
- pgrx feature flags in manifest-data.ts (e.g., `features: ["pg18"]` → `features: ["pg19"]`)
- nixpkgs must package `postgresql_<new major>` at the locked revision; flake.nix picks it from `pgVersion`'s major

## Phase 4: Extensions (BY SOURCE TYPE)

**CRITICAL**: Update in dependency order (dependencies BEFORE dependents).

### Dependency Graph

**Extract from manifest**: `command grep 'dependencies:' scripts/extensions/manifest-data.ts -B 2 | command grep 'name:'`

Extensions with `dependencies: ["extension1", "extension2"]` field must be updated AFTER their dependencies.

**Example**: If extension B has `dependencies: ["extensionA"]`, update extensionA first, verify compatibility, then update B.

### ⚠️ CRITICAL: Dependency Compatibility

**BEFORE updating any extension that has dependents, verify compatibility:**

```bash
# Find dependents
command grep -B 30 "dependencies:.*EXTENSION_NAME" scripts/extensions/manifest-data.ts | command grep 'name:'

# Check compatibility:
# - Read dependent's Cargo.toml / package.json for version constraints
# - Check dependent's changelog/releases for breaking changes
# - Major version changes often break dependents

# Test after update
bun run generate
bun run build  # Fails if ABI incompatible
bun run test:all  # Verify runtime compatibility
```

**Common dependency chains:**
- `pgvector` → vectorscale
- Vault and pgsodium share the retained root-key getter; neither extension's key-format compatibility follows from a fresh-install pass.
- `pgmq/pg_net/pg_cron/supabase_vault` → pgflow
- `hypopg` → index_advisor
- `postgis` → pgrouting
- `timescaledb` → timescaledb_toolkit

**If incompatible**: Skip update OR update both together in single commit.

For encryption or key-loading changes, initialize the previous image with a disposable key and encrypted value, stop it, and open the same data with the candidate image and key. Check decryption before and after the documented SQL upgrade, plus restart/restore through the existing recovery suite. A fresh encrypted value cannot expose loss of access to old ciphertext.

### Patched Source Extensions (`build.patches`)

**Identify**: `command grep -n "patches: \[" scripts/extensions/manifest-data.ts`

A bump can stop the build with `Patch <file> no longer applies`: refresh the diff in `docker/postgres/patches/` against the new tag (vectorscale: docs/VERSION-MANAGEMENT.md Procedure 4, including the non-AVX2 CPU proof).

### Source-Built Extensions

**Identify**: every entry that is not `kind: "builtin"`
- `command grep -B 5 'build:' scripts/extensions/manifest-data.ts | command grep 'name:'`

Update ONLY `source.tag`:

```typescript
{
  name: "extension_name",
  source: { type: "git", tag: "vX.Y.Z" },         // ← Only this field
}
```

**Every extension is built from source** by `nix/extensions.nix`, with nixpkgs' recipe when the entry sets `nix.package`.

**Commit lock**: `docker/postgres/extensions.manifest.json` is the lock file for tags, as `bun.lock` is
for `package.json`. `bun run generate` resolves a tag to its commit only when the entry's repository or
tag changes, and the build fetches that commit. So a tag that upstream moved after you pinned it changes
nothing until you edit the tag; to pick up a re-pushed tag, delete that entry's `commit` line from the
generated manifest and regenerate. Review the `commit` diff of every tag you bump (annotated tags:
`git ls-remote URL 'refs/tags/TAG^{}'` gives the commit).

**Portable, optimised builds**: nixpkgs' compiler wrapper drops `-march/-mtune/-mcpu=native`
(`NIX_ENFORCE_NO_NATIVE`), which would tie a binary to the build host's CPU. Every C compile of the server and
extensions keeps upstream's release `-O` level and adds the CPU baseline (`targetCpu` in `flake.nix`). A make build whose own compile lines end below `-O2` (e.g.
upstream's `PG_CPPFLAGS = -O0`) fails (`nix/extensions.nix` preBuild): find upstream's reason, then clear the variable
with `build.makeOptions` on the entry and record why. Meson and cargo builds are not checked. A Meson recipe runs at
nixpkgs' `--buildtype=plain`: compare upstream's `meson.build` for flags it adds only at release (pgBackRest's).

### Builtin Extensions

**Identify**: `command grep 'kind: "builtin"' scripts/extensions/manifest-data.ts`

**No manual updates required** - Builtin extensions are part of PostgreSQL core and update with nixpkgs (Phase 3).

These only need updates when PostgreSQL version changes.

## Phase 5: Special Extensions

**IMPORTANT**: When updating any extension, check for local patches/compatibility layers in `docker/postgres/`:
- Search for files: `find docker/postgres -name "*EXTENSION_NAME*patch*" -o -name "*EXTENSION_NAME*stub*" -o -name "*EXTENSION_NAME*compat*"`
- Review init scripts: `command grep -r "EXTENSION_NAME" docker/postgres/docker-entrypoint-initdb.d/`
- Verify patches still apply with new version or if upstream fixed them

### 5.1: pgflow

The version is written once: the pgflow entry's tag (`pgflow@X.Y.Z`) in `manifest-data.ts`;
`scripts/pgflow/generate-schema.ts` writes it into the schema fixture, and `scripts/pgflow/schema-fixture.test.ts`
(in `validate`) fails when the fixture's version differs from the manifest's.

```bash
# 1. Edit the pgflow tag in manifest-data.ts, then regenerate the schema fixture and upgrade bundle
#    (tests/fixtures/pgflow/schema.sql + upgrade/: migrations, versions.tsv, aza-overrides.sql)
bun scripts/pgflow/generate-schema.ts
# 2. Client pins must equal the tag (scripts/pgflow/version.test.ts checks them in validate)
bun add --dev @pgflow/client@X.Y.Z @pgflow/dsl@X.Y.Z
# 3. Regenerate, then prove fresh installs AND upgrades of existing databases
bun run generate
bun test scripts/pgflow/
bun run build                              # the image COPYs schema.sql and upgrade/; suites test the image
bun scripts/test-all.ts --group features   # includes test-pgflow*.ts and test-pgflow-upgrade.ts
```

Review the local layers against the new upstream: `docker/postgres/pgflow/security-patches.sql` and the
functions the generator overrides (aza-overrides). The generator stops when an expected upstream text
is missing (`replaceRequired`); fix the replacement, never loosen it. `test-pgflow-upgrade.ts` upgrades a
database created by the last release in its `LEGACY` list with `pgflow-upgrade` and requires it to equal
a fresh install: if it fails, the new migrations or overrides break existing databases. A release whose schema changes
needs a CHANGELOG entry telling operators to run `docker exec <container> pgflow-upgrade` (stop pgflow
workers first; upgrade the database before deploying the new `@pgflow/client`).

### 5.2: git-ref Extensions (HEAD Drift Verification REQUIRED)

**Identify**: `command grep 'type: "git-ref"' scripts/extensions/manifest-data.ts -B 2 | command grep 'name:'`

These use commit SHAs (no version tags). Verification is mandatory:

```bash
# Primary check (must be zero for enabled extensions before closing round)
bun scripts/extensions/check-updates.ts --format=json | jq -r '
  .[] | select(.sourceType=="git-ref" and .enabled==true and .updateAvailable==true) |
  "\(.name): \(.current) -> \(.latest)"'

# Check if upstream now has stable tags
git ls-remote --tags https://github.com/OWNER/REPO | tail -20

# If tags exist: migrate from git-ref to git type
# Change: type: "git-ref", ref: "..."
# To:     type: "git", tag: "vX.Y.Z"

# If no tags: verify newer commit is PG18-compatible
# Check: CI status, changelog mentions, no breaking changes
gh api repos/OWNER/REPO/commits/COMMIT_REF/status
```

Any non-empty output from the `jq` command above is actionable work, not an informational note.

### 5.3: cargo-pgrx Extensions (Rust Version Alignment)

**Identify**: `command grep 'type: "cargo-pgrx"' scripts/extensions/manifest-data.ts -B 5 | command grep 'name:'`

These extensions use Rust pgrx framework for building PostgreSQL extensions in Rust.

**Version alignment**: cargo-pgrx must equal the pgrx crate the source's `Cargo.lock` pins. `nix/extensions.nix`
takes it from nixpkgs, or stops and prints the `pgrx-<version>` input to add to `flake.nix` (then
`bun scripts/nix/nix.ts flake lock`); drop an input once nixpkgs packages its release. Feature flags must match the
PostgreSQL major (e.g. `features: ["pg18"]`).

### 5.4: Disabling Unmaintained Extensions

Incompatibility starts investigation, not permission to remove a shipped capability. Compare a compatible patched release, the existing source-build path and a narrow upstream patch first; retain the working pin when the newer release removes useful behavior. Ask the owner about unresolved capability loss before disabling it. For an approved removal:

```typescript
{
  name: "pg_plan_filter",
  enabled: false,
  disabledReason: "Not compatible with PostgreSQL 18. Last updated for PG13 (2021). Maintainer inactive.",
}
```

**Also remove from `scripts/config/size-baselines.json`** if the extension is listed there.
A disabled extension can never be size-checked (no Docker image runs it), so keeping its entry
creates false confidence that it's being validated. The `postgis` incident: it was disabled AND
had the wrong `.so` filename — the dead entry went unnoticed until an explicit audit.

### 5.5: Updating Disabled Extensions

**Identify**: `command grep 'enabled: false' scripts/extensions/manifest-data.ts -B 2 | command grep 'name:'`

**Principle**: Update disabled extensions if they're still tested or might be re-enabled. Skip if permanently incompatible.

Extensions still in test suites should stay current. Permanently broken extensions can be skipped.

### 5.6: Compose Stack Images (Outside Manifest)

**Not in manifest-data.ts.** A companion image (pgbouncer, the exporters) has ONE pin: the
`${VAR:-repo:tag@sha256:…}` default in `stacks/*/compose.yml`. `bun run validate` ("Companion Image
Pins", `scripts/validate/companion-image-pins.ts`) requires every other mention of that repository —
`.env.example` files, `docs/`, `scripts/test/`, `deployments/`, this file — to carry the same
`tag@digest`, and lists each drifted `file:line`. So: edit the compose defaults, run validate, fix
what it lists.

Images that appear only outside `stacks/` (e.g. `deployments/` Prometheus/Grafana, or a different
pgbouncer repository there) have no compose pin, so the check cannot see them: update and pin them by
hand, each with `tag@digest`.

```bash
# Index digest for a new tag (no layers downloaded)
docker buildx imagetools inspect ORG/REPO:TAG --format '{{json .Manifest.Digest}}'
```

**Per image**:
1. Read the release notes from the current tag to the new one for removed or renamed flags, env vars
   and metrics. postgres-exporter 0.20 is the pattern: `PG_EXPORTER_DISABLE_SETTINGS_METRICS` was
   removed (the exporter ignores unknown env vars, so a dead setting stays silent) and
   `pg_replication_slot_*` metrics became `pg_replication_slots_*`. Confirm each env var the stacks set
   against the new binary's own flag list (`docker run --rm IMAGE --help`), with a definitely-invalid flag
   as control. Rename users of changed metrics (dashboards and queries in `deployments/`).
2. Update the compose defaults; run `bun run validate` until the pin check is clean.
3. CHANGELOG entry (operators see companion images); removed settings or renamed metrics go under Breaking.
4. Run the stack suites (`bun scripts/test-all.ts --group stacks`); each exporter's `/metrics` must show
   `pg_up 1` / `pgbouncer_up 1`.
   For shipped Prometheus/Grafana examples, also query the metrics through Prometheus and check Grafana's provisioned datasource: a healthy exporter does not prove scrape filters retain what its dashboard needs. Use disposable Compose state and remove it after the check.

## Phase 6: Verify Changed Consumer Contracts

### MANDATORY Pre-Test Checks

Before writing tests, search for hardcoded version strings in ALL test files:

```bash
# Find hardcoded version strings in ALL scripts/ subdirs (scripts/test/, scripts/docker/, scripts/config/, etc.)
command grep -rn -E 'includes\("0\.|includes\("1\.|includes\("2\.' scripts/ | command grep -v "\.bun/"
# Also search for specific old version patterns:
command grep -rn -E "0\.8|0\.5|2\.8|1\.10|5\.4" scripts/ | command grep -v "\.bun/" | command grep -iE "include|assert|version"
# Hardcoded PG major in paths breaks on a PG major bump (tool checks read binaryPath/soFileName and pg_config)
command grep -rn -E "postgresql/[0-9]+/lib" scripts/ | command grep -v "\.bun/"
```

These WILL break tests if not updated alongside the extension — this is the #1 missed item in
update rounds. Update any hardcoded version strings before running the test suite.

For each changed extension, identify the material consumer failure that existing checks cannot expose. Add a test only when its additional evidence justifies its maintenance and normal-run cost; feature presence and facts already guaranteed by types do not earn tests. **ALWAYS verify the actual SQL API** by
reading the extension's SQL files or docs before writing tests — planned API signatures are
frequently wrong (extension may use different function names than expected).

Breaking changes need consumer compatibility evidence; reuse the existing functional suite before adding another verifier.

Prefer the shipped dependency's native configuration probe or validation command over replacing it with a stub. For startup scripts, exercise the real upstream entrypoint and process arguments: a replacement shell can accept a configuration production rejects, or fail because its copied function contract went stale.

### Test Creation Criteria

- **API or behavior changed** → Exercise affected real callers and failure paths; retain a regression only for a meaningful gap in existing guarantees.
- **New feature added** → Test only a relevant consumer contract with a material failure to distinguish.
- **Breaking change** → Preserve the promised behavior or document and verify the migration; changing expectations alone is not compatibility evidence.

### Where Tests Live

Docker suites are `scripts/**/test-*.ts` files listed in `SUITES` in `scripts/test-all.ts`, each with a
group (`extensions`, `security`, `stacks`, `features`, `regression`); CI runs each group as
one job. A new suite must be added to `SUITES` (`bun run validate` fails naming any unregistered one).
Extension behaviour belongs in the suite of group `extensions` that already owns the extension: `rg`
the extension name in `scripts/` first. Run one group with
`bun scripts/test-all.ts --group <group> [--image <ref>]`.

## Phase 7: Regenerate & Validate

```bash
# Regenerate all files from manifest
bun run generate

# Fast validation: static checks + unit tests; runs without Docker
bun run validate

# MANDATORY full validation: + shellcheck, yamllint
bun run validate:all
```

Use affected checks for each focused commit, then run `validate:all` for the completed shell and YAML changes. It catches ShellCheck and yamllint defects that fast validation misses. Commit before long verification; a failed gate gets a follow-up repair commit.

## Phase 8: Build & Test (Intermediate Check)

```bash
# Build, validate:all, then every registered suite against the new image (exit 1 on any failure)
bun run test:all
# Already built? Only the suites: bun run test
```

**IMPORTANT**: This is an intermediate check — NOT the final gate. Phases 9–11 add more commits
(CHANGELOG, skill update). **Phase 12 is the mandatory final gate** after all commits are done.

**Multi-arch verification**: Image builds for both amd64 and arm64 are verified in GitHub Actions after the user pushes changes. Agents should ensure local tests pass before committing.

**NOTE**: `bun run test` (quick test) exists but should NOT be used for updates — always run full
`test:all` to verify comprehensive compatibility. Build success alone is NOT sufficient: a broken
image can build cleanly if `set -e` is bypassed by `|| true` patterns.

### Build Failure Troubleshooting

**Build errors name the failing extension and error type.**

Common causes:
- Missing build dependencies → add the nixpkgs attribute to the entry's `nix.inputs` (build tools: `nix.nativeInputs`)
- Version incompatibility → Check the actual compiler/pgrx constraints and update compatible dependencies together
- ABI break → Repair compatibility or retain the working pin; capability removal follows Phase 5.4

Resolution options:
1. Fix (add missing deps, update versions) → regenerate → rebuild
2. Retain the working pin with its concrete compatibility reason; escalate unresolved capability loss
3. Patch build (add `build.patches` for sed fixes)

## Phase 9: Update CHANGELOG.md (Image Consumer Focus)

**MANDATORY GATE**: If this round changed any image-affecting files, `CHANGELOG.md` must be
updated before proceeding to Phase 10/12. No exceptions.

**Rules**:
1. **User-facing changes**: Full detail with migration guidance
2. **Breaking changes**: Separate section with "action required" flag
3. **Development (non-image) changes**: One line max, or omit if trivial

**Standard categories** (in impact order): `Breaking` | `Security` | `Fixed` | `Changed` | `Added` | `Deprecated` | `Removed` | `Development`. Do not invent categories beyond this set.

**Format**:

```markdown
## [Unreleased]

### Breaking (action required)
- **pgflow 0.13.0**: Handler signature changed - root steps now receive `(flowInput, ctx)` instead of `(input)`. Update your handler functions.

### Security
- **pg_partman**: Patched CVE-XXXX-YYYY (privilege escalation via search_path in run_maintenance())

### Fixed
- **pg_cron**: Fixed scheduled jobs failing silently when pg_cron.max_running_jobs limit was reached

### Changed (user-facing)
- **pgvector 0.8.1 → 0.9.0**: New HNSW parameters (ef_search default changed from 40 to 100)
- **TimescaleDB 2.24.0**: 4-5× faster recompression

### Added
- New extension: xyz with feature ABC

### Development (non-image)
- Updated pgrx to 0.16.1, Rust to 1.88.0
```

## Phase 9.5: Review Each Focused Change Before Commit

Review every changed hunk against the requested update and the consumer behavior it affects. Use the relevant checks below; reuse a passing result while its inputs remain unchanged. Preserve finished work in focused commits before long checks. Phase 12 verifies the final committed tree.

**Pre-commit mechanical checklist** (run these commands, check the output):
```bash
# 1. Verify CHANGELOG gating
git diff --name-only -- scripts/extensions/manifest-data.ts docker/postgres stacks
# If non-empty → must also show: git diff --name-only -- CHANGELOG.md (non-empty)

# 2. Verify no stale version strings in tests
command grep -rn -E 'includes\(|startsWith\(' scripts/ | command grep -E '[0-9]+\.[0-9]' | command grep -v "\.bun/"

# 3. Companion image pins propagated: covered by validate ("Companion Image Pins"), step 5

# 4. Verify no branch-pinned reusable workflow refs remain
command grep -rn "uses:.*\.yml@[a-zA-Z]" .github/workflows/ | command grep -v "@[0-9a-f]\{40\}"
# (non-empty output = action required)

# 5. Run full static validation for the finished affected surface, not again for unchanged inputs
bun run validate:all

```

**Then review these qualitative questions** — try to break your own work:

**Tests**
- Do any new tests pass trivially regardless of the fix they claim to cover?
  (e.g., EXPLAIN test on a tiny table uses SeqScan → never touches the HNSW-specific code path)
- Does the test actually force the execution path it claims to verify?
  Query planner optimisations, small row counts, or default settings can silently bypass the exact
  code path being tested. Add session-level forcing (e.g. `SET enable_seqscan = OFF`) or sufficient
  data volume to guarantee the expected path is taken.
- Does the test verify the actual bug mode, or just that no crash occurred?
- Did secret scanning run on changed scripts, and did it flag false positives from ambiguous names
  (`token`, `secret`, `password`) used as ordinary local variables? Prefer explicit non-secret names
  (`versionChunk`, `authHeader`) and re-run `bun run test:all`.

**File completeness**
- When touching a file that documents required changes (README, validator error messages,
  skill files): do the instructions in that file still work? Are any file references stale?
- When touching any validator: do its own fix instructions actually fix the error it reports?
  Validators with inline copies of data must point users to update BOTH the canonical file
  AND the validator's own inline copy.
- Are all tooling version files in sync? (`.tool-versions`, `package.json`, lock files)

**Version strings and URLs**
- Every URL, version string, and file path you wrote or modified — verify it, don't assume.
  GitHub repository transfers happen; org names change. Check the actual URL before "fixing" it.

**What you didn't look at**
- List files that are related to your changes but that you haven't read. Read them now.
- Specifically: auto-generated files (`docker/postgres/extensions.manifest.json`, `docs/EXTENSIONS.md`) — did they regenerate correctly?

**Mandatory doc sync** (NOT auto-generated — must be updated manually every round):
- **`CHANGELOG.md` gate**: If `git diff --name-only -- scripts/extensions/manifest-data.ts docker/postgres stacks` is non-empty, `git diff --name-only -- CHANGELOG.md` MUST also be non-empty before Phase 12.
- **Check for orphaned test files**: When migrating an extension's install method, search for
  dedicated test files (`test-EXT-NAME-*.ts`) that may now be stale (wrong version assertions,
  wrong install path descriptions). Delete or migrate their valuable tests.
- **`scripts/test/test-timescaledb-tsl.ts`** (suite group `extensions`): compresses chunks and refreshes a
  continuous aggregate over them; update it when a TimescaleDB release changes those APIs.
- **Tools**: `testToolsPresent` finds each enabled tool by its manifest entry's `binaryPath` or `soFileName`,
  so a new or moved tool is an edit to that entry. Find hardcoded PG-major paths anyway:
  `command grep -rn -E "postgresql/[0-9]+/lib" scripts/ | command grep -v "\.bun/"`
- **Search all test files for hardcoded version strings** that would fail after the update:
  `command grep -rn -E 'includes|startsWith|=== "' scripts/ | command grep -E '[0-9]+\.[0-9]' | command grep -v "\.bun/"`
- **Size baselines after updating any tracked extension**: After updating any extension listed in
  `scripts/config/size-baselines.json` (timescaledb, pgroonga, pg_jsonschema, wrappers,
  vectorscale, etc.), run the size regression check. Advisory warnings indicate a stale baseline:
  ```bash
  bun scripts/check-size-regression.ts  # requires a built image; run bun run build first if needed
  ```
  If advisory warnings appear for an extension you just updated, update `scripts/config/size-baselines.json`
  with the new observed range (keep ~10-20% headroom above measured size for the `max`).

**The question to answer**: "If the user ran an adversarial audit on what I just did,
what would they find?" Find it yourself first.

## Phase 10: Commit

**Conventional commit format**:
- `chore(deps): update Bun dependencies`
- `feat(extensions): upgrade pgvector to 0.9.0 with new HNSW params`
- `fix(postgres): update TimescaleDB to 2.24.0, fixes recompression perf`

**Always include** your own co-author trailer from AGENTS.md "Git Workflow" (e.g.
`Co-Authored-By: Claude <noreply@anthropic.com>`).

**Commit granularity**: One logical change per commit (e.g., one extension update, or all Bun deps).
Commit with `git commit --only -m "…" -- <every file of the change>`: a bare `git commit` takes the
whole index, including renames and files another agent staged.

## Phase 11: Retrospective & Skill Self-Update (MANDATORY)

After every update round, perform a mandatory self-reflection before closing out the work:

1. **What was missed in pre-flight?** Items caught mid-implementation instead of upfront
2. **What was assumed without verification?** Version strings, API signatures, URLs, compatibility
3. **What hardcoded values broke tests?** Document the pattern for future detection
4. **What files were unexpectedly required?** A change that needs edits in several files to stay
   consistent means a fact is stored twice — move it onto the manifest entry instead of syncing copies
5. **What upstream API was different from expected?** (e.g., pgmq topic API uses `bind_topic`,
   not `create_topic`/`subscribe` — always verify from actual source before writing tests)
6. **Were all tooling version files kept in sync?** `.tool-versions` (Bun runtime), `package.json`
   (@types/bun). These are updated separately — `bun update` does NOT touch `.tool-versions`.
7. **Were validator error messages and fix instructions actually correct?** When editing any
   validator script, verify that following its own fix instructions would resolve the error it
   reports.
8. **Were stale prose version comments audited?** `actions-up` updates `uses:` line comments
   automatically — the risk is prose comments *elsewhere* in the file. See Phase 2.5 MANDATORY
   section for the exact grep command and what to look for.
8a. **Were branch-pinned reusable workflow refs checked?** Run Phase 2.5's branch-reference search and inspect `actions-up`'s skips; obtain every replacement SHA through that tool.
9. **Was `flake.lock` bumped (or shown current)?** It carries every C library's security fixes; a clean extension list
   says nothing about them.
10. **Was extension update detection quality-checked?** If `check-updates.ts` output looked noisy,
    verify each candidate is same-family + monotonic (not prerelease/downgrade) and confirm fallback
    paths were exercised when GitHub API was rate-limited.
11. **Was changelog gating enforced?** If any image-affecting files changed, verify `CHANGELOG.md`
    was updated in the same round with user-facing entries (or explicitly document why no user-facing
    impact exists).
12. **Are changelog claims evidence-backed?** Cross-check each changelog statement against actual
    upstream diff evidence (release notes, compare output, commit/file diffs). Remove any claim that
    cannot be tied to concrete upstream changes.
13. **Were all bug fixes systematically verified with a full-codebase grep?** A targeted fix (e.g.,
    fixing `.env()` calls in the files that visibly failed) is not the same as verifying the entire
    codebase. After any structural fix pattern, run a grep across ALL relevant files to confirm zero
    remaining violations before declaring done. Latent bugs in gracefully-degrading code paths
    (try/catch → warning, optional fallback branches) pass tests silently until they hit edge cases.
    Run the validate check or a direct grep: `bun run validate` now includes "Subprocess Env Safety"
    for the `.env()` pattern specifically.

Then update THIS SKILL FILE (`.claude/commands/update.md`) with concrete improvements:
- Add checks that would have caught missed items
- Strengthen wording where guidance was too weak
- Fix any outdated file references or procedures
- Add new edge cases discovered

**This is kaizen — each update round improves the next. The skill should be a living document
that gets better with every use. Commit the skill update as the final commit of the round.**

## Phase 12: Final Verification Gate (MANDATORY — The Only Acceptable End State)

Before final verification, prove the full update matrix is closed. Do not claim "update complete"
unless every item below has either been updated or has an evidence-backed no-op/skip reason. A skip that
waits on time (a release newer than the minimum release age) records when it ends; after that the item is
due in this round, not the next:

- nixpkgs revision (`flake.lock`): PostgreSQL minor, glibc, libraries
- Git/tag/git-ref extensions from `check-updates.ts`
- Companion images: compose pins (validate-enforced) and `deployments/`-only images
- Tool images run by scripts (Phase 2.5)
- Bun runtime in `.tool-versions`
- Bun package dependencies and `bun.lock`
- GitHub Actions SHA pins, reusable workflow refs, and stale prose comments
- Hardcoded test/doc version strings for every changed image-facing dependency
- Generated files and `CHANGELOG.md` when any image-facing source changed

After ALL other phases — including CHANGELOG, skill update commit, and every other commit — run
the full comprehensive test suite one final time:

```bash
bun run test:all
```

**This is a gate, not a formality.** Rules:

- ✅ **If it passes**: Update round is **COMPLETE**. Repository is in a known-good state.
- ❌ **If it fails**: DO NOT stop. DO NOT declare work done. Fix the issue, commit the fix,
  and re-run `bun run test:all` from the top of Phase 12. Repeat until clean.

**Why this matters**: `bun run build` succeeding is NOT sufficient — it only verifies the image
compiles. A broken image can build successfully if `set -e` is circumvented (e.g., the `|| true`
pattern). Only `test:all` starts PostgreSQL, loads all extensions, and runs functional tests —
verifying the image is actually correct at runtime.

**No exceptions. No "CI will catch it". No "close enough".** The only acceptable end state is
`bun run test:all` passing clean with zero failures on the committed code.

```
test:all → pass → DONE
test:all → fail → fix → commit fix → test:all (loop)
```

## Phase 13: Reclaim Test Artifacts (MANDATORY — after the gate passes)

`bun run build` removes the image it supersedes, and test containers keep PGDATA on tmpfs or remove
their volumes, so what remains is images left by a failed build or a pull by digest, and the
dedicated `aza-pg-builder` buildx cache. Reclaim them:

```bash
bun run cleanup:dry   # preview what would be removed (no changes)
bun run cleanup       # reclaim
```

**Safe on a shared host**: it removes ONLY artifacts positively attributed to aza-pg by aza-pg's own
identity markers — images by OCI label `org.opencontainers.image.title` ("aza-pg …"). It NEVER prunes by type
(`docker system/volume/image prune` would also delete other projects' orphans). Unattached aza-pg data volumes
are only listed: the marker in them proves the image made them, not a test, so one may be an operator's database.

## Recovery Procedure

### Before Push (Local Only)

If update breaks **before pushing to remote**:

```bash
# Inspect exact damage first
git status --short
git diff --stat

# Preferred for committed changes: revert with history
git revert HEAD

# Then regenerate/rebuild from the recovered state
bun run generate
bun run build
```

For uncommitted changes, use targeted `git restore -- <path>` only after verifying the diff belongs
entirely to the failed update attempt. Never discard unrelated user work.

### After User Pushes

Only push when the user explicitly requested upstream publication or the current task requires it.
Verify branch, remotes, CI status, and release invariants before and after pushing.

If update breaks after user already pushed:

```bash
# Create revert commit (keeps history)
git revert HEAD  # Or HEAD~N..HEAD for multiple

# Rebuild
bun run generate
bun run build
bun run test:all

# Agent stops here - user handles remote
```

---

# Reference Tables

## Non-Standard Tag Formats

| Extension | Tag Format | Example |
|-----------|------------|---------|
| **pg_repack** | `ver_X.Y.Z` | `ver_1.5.3` |
| **pgaudit** | `X.Y` (PG major) | `18.0` |
| **set_user** | `RELX_Y_Z` | `REL4_2_0` |
| **pgbackrest** | `release/X.Y.Z` | `release/2.57.0` |
| **wal2json** | `wal2json_X_Y` | `wal2json_2_6` |
| **pgflow** | `pgflow@X.Y.Z` | `pgflow@0.13.1` |

## Version Lookup Commands

| Source | Command |
|--------|---------|
| **GitHub latest release** | `gh release view --repo OWNER/REPO --json tagName --jq .tagName` |
| **GitHub all tags** | `git ls-remote --tags https://github.com/OWNER/REPO \| command grep -v '{}' \| tail -5` |
| **nixpkgs channel head** | `git ls-remote https://github.com/NixOS/nixpkgs refs/heads/nixos-unstable` |

## Parallel Execution Opportunities

Use parallelism where supported for:
- ✅ Pre-flight checks that do not share mutable state
- ✅ Upstream changelog review (per extension in parallel)
- ✅ Test creation (if multiple extensions updated)
- ✅ Version lookups from different sources (GitHub, nixpkgs)

**Agent prompts should**:
- Be specific about what information to return
- Include filtering criteria (e.g., "return only version numbers")
- Specify output format (e.g., "provide as JSON" or "list as Markdown table")

Do not trust delegated results blindly. Re-run decisive commands locally and verify every version,
URL, digest, release note claim, and file path before editing or committing.

---
