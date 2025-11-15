# Workflow Simplification Implementation Guide

**Status:** Phase 1-2 Complete (7 of 19 items) | **Progress:** 21% duplication eliminated

## Executive Summary

This guide documents the ongoing workflow simplification initiative to eliminate 96% code duplication (883 of 915 lines) across GitHub Actions workflows, improve local testability, and reduce workflow file sizes by 25-30%.

### Completed Work

**Phase 1: Foundation Scripts** ✅ (4/4 complete)

- `scripts/ci/parse-bun-version.ts` - Parse Bun version from .tool-versions
- `scripts/docker/pull-with-retry.ts` - Docker pull with exponential backoff retry
- `scripts/ci/monitor-cache-usage.ts` - GitHub Actions cache monitoring via API
- `scripts/ci/repository-health-check.ts` - Verify required files/directories exist

**Phase 2: Composite Actions** ✅ (3/3 complete)

- `.github/actions/setup-bun/action.yml` - Bun setup + dependency caching (saves 133 lines)
- `.github/actions/ghcr-login/action.yml` - GHCR authentication (saves 63 lines)
- `.github/actions/setup-buildx/action.yml` - Docker Buildx setup with network=host

**Impact:** 196 of 915 duplicated lines eliminated (21%), all items locally testable

---

## Remaining Work (Phases 3-9)

### Phase 3: Diagnostic Scripts (MEDIUM RISK)

#### 3.1 Capture PostgreSQL Diagnostics

**File:** `scripts/debug/capture-postgres-diagnostics.ts`
**Current usage:** 3 instances (build-postgres-image.yml, publish.yml test failures)
**Effort:** 45 minutes

**Inputs:**

- `--container <name>` - PostgreSQL container name
- `--output-dir <path>` - Directory for diagnostic files
- `--include-stack-logs` - Also capture docker compose logs (optional)

**Collects:**

- Container logs: `docker logs <container>`
- PostgreSQL config: `psql -c "SHOW ALL;"`
- Shared preload libraries: `psql -c "SHOW shared_preload_libraries;"`
- Extension list: `psql -c "SELECT * FROM pg_available_extensions ORDER BY name;"`
- Version info: `cat /etc/postgresql/version-info.txt`
- Stack logs: `docker compose logs --tail=200` (if --include-stack-logs)

**Reference bash (build-postgres-image.yml:895-928):**

```bash
mkdir -p ${{ runner.temp }}/diagnostics
docker logs pg-ext-test 2>&1 | tee ${{ runner.temp }}/diagnostics/pg-ext-test-logs.txt
docker exec pg-ext-test psql -U postgres -c "SHOW ALL;" 2>&1 | tee ...
# ... (more captures)
```

**Local test:**

```bash
# Start a test container first
docker run -d --name pg-test -e POSTGRES_PASSWORD=test postgres:18
bun scripts/debug/capture-postgres-diagnostics.ts \
  --container pg-test \
  --output-dir /tmp/pg-diagnostics
# Verify files created in /tmp/pg-diagnostics/
```

---

#### 3.2 Capture Security Scan Diagnostics

**File:** `scripts/debug/capture-scan-diagnostics.ts`
**Current usage:** 2 instances (build-postgres-image.yml:585-621, publish.yml:746-784)
**Effort:** 30 minutes

**Inputs:**

- `--image <ref>` - Image reference to scan
- `--output-dir <path>` - Directory for diagnostic files
- `--cache-dir <path>` - Trivy cache directory (default: .trivy-cache)

**Collects:**

- Trivy full scan (all severities): `trivy image --format table --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL`
- Trivy JSON output: `trivy image --format json`
- Image metadata: `docker buildx imagetools inspect <image>`
- Copy existing SARIF file if present

**Reference bash (build-postgres-image.yml:585-621):**

```bash
mkdir -p ${{ runner.temp }}/scan-diagnostics
docker run --rm -v .trivy-cache:/root/.cache/ aquasec/trivy:latest image \
  --format table --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
  "aza-pg-testing:scan" | tee ${{ runner.temp }}/scan-diagnostics/trivy-full.txt
# ... (more scans)
```

**Local test:**

```bash
bun scripts/debug/capture-scan-diagnostics.ts \
  --image postgres:18 \
  --output-dir /tmp/scan-diag \
  --cache-dir .trivy-cache
```

---

### Phase 4: Workflow Validation Scripts (MEDIUM RISK)

#### 4.1 Verify Manifest Sync

**File:** `scripts/ci/verify-manifest-sync.ts`
**Current usage:** ci.yml:64-76
**Effort:** 20 minutes

**Logic:**

1. Generate fresh manifest: `bun scripts/extensions/generate-manifest.ts`
2. Compare committed vs. generated (excluding `generatedAt` timestamp)
3. Exit 1 if diff found with helpful error message

**Reference bash (ci.yml:64-76):**

```bash
bun scripts/extensions/generate-manifest.ts
if ! diff -u \
  <(git show HEAD:docker/postgres/extensions.manifest.json | jq 'del(.generatedAt)') \
  <(jq 'del(.generatedAt)' docker/postgres/extensions.manifest.json); then
  echo "::error::extensions.manifest.json content is out of date"
  exit 1
fi
```

**Implementation notes:**

- Use Bun's built-in `Bun.spawn()` for git/jq commands
- Load both files, parse JSON, delete `.generatedAt` field, deep compare
- Provide actionable error message: "Run: bun scripts/extensions/generate-manifest.ts"

**Local test:**

```bash
# Should pass if manifest is current
bun scripts/ci/verify-manifest-sync.ts

# Test failure case: modify manifest-data.ts, don't regenerate
# Should fail with clear error
```

---

#### 4.2 Validate Dockerfile Paths

**File:** `scripts/build/validate-dockerfile-paths.ts`
**Current usage:** build-postgres-image.yml:198-205
**Effort:** 15 minutes

**Logic:**
Check that all COPY source paths referenced in Dockerfile exist:

- `docker/postgres/extensions.manifest.json`
- `docker/postgres/build-extensions.ts`
- `docker/postgres/docker-auto-config-entrypoint.sh`

**Reference bash (build-postgres-image.yml:198-205):**

```bash
echo "Validating Dockerfile COPY paths exist in build context..."
test -f docker/postgres/extensions.manifest.json || exit 1
test -f docker/postgres/build-extensions.ts || exit 1
test -f docker/postgres/docker-auto-config-entrypoint.sh || exit 1
echo "✅ All Dockerfile COPY paths validated"
```

**Local test:**

```bash
bun scripts/build/validate-dockerfile-paths.ts
# Should pass if all COPY paths exist
```

---

### Phase 5: Docker Utility Scripts (MEDIUM RISK)

#### 5.1 Verify Local Image

**File:** `scripts/docker/verify-local-image.ts`
**Current usage:** build-postgres-image.yml:376-388
**Effort:** 25 minutes

**Logic:**
Try to find and run local image (with or without registry prefix):

1. Try: `docker run <registry>/<image>:<tag> psql --version`
2. If fails: Find image via `docker images --format` grep
3. If found: Run verification command
4. Exit 0 if verified, 1 if not found

**Parameters:**

- `--image <name>` - Image name (without tag)
- `--tag <tag>` - Image tag
- `--registry <url>` - Registry URL (default: ghcr.io)
- `--verification-command <cmd>` - Command to run (default: psql --version)

**Reference bash (build-postgres-image.yml:376-388):**

```bash
if docker run --rm ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-${{ github.ref_name }} psql --version 2>/dev/null; then
  echo "✅ Local image verified (with registry prefix)"
elif docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'dev-${{ github.ref_name }}$' | head -1 | xargs -I {} docker run --rm {} psql --version; then
  echo "✅ Local image verified (local tag)"
else
  exit 1
fi
```

---

#### 5.2 Tag Local Image

**File:** `scripts/docker/tag-local-image.ts`
**Current usage:** build-postgres-image.yml:531-549
**Effort:** 20 minutes

**Logic:**
Find local image by pattern and tag it for scanning/testing:

1. Try to tag with registry prefix
2. If fails: Find image via `docker images` grep
3. Tag found image with target tag

**Parameters:**

- `--source-pattern <regex>` - Pattern to match source tag
- `--target <tag>` - Target tag name

**Reference bash (build-postgres-image.yml:531-549):**

```bash
if docker tag ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-${{ github.ref_name }} aza-pg-testing:scan 2>/dev/null; then
  echo "📦 Tagged image with registry prefix for scanning"
else
  LOCAL_IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'dev-${{ github.ref_name }}$' | head -1)
  if [ -n "$LOCAL_IMAGE" ]; then
    docker tag "$LOCAL_IMAGE" aza-pg-testing:scan
  else
    exit 1
  fi
fi
```

---

#### 5.3 Create Manifest

**File:** `scripts/docker/create-manifest.ts`
**Current usage:** build-postgres-image.yml:417-455, publish.yml:362-419
**Effort:** 60 minutes (complex)

**Logic:**
Create multi-arch manifest from digest files + apply OCI annotations:

1. Load digest files from directory (sha256:xxx format)
2. Construct imagetools create command with multiple `-t` tags
3. Add `--annotation "index:key=value"` for each OCI annotation
4. Execute command
5. Inspect created manifest, extract digest
6. Verify platform count (should be 2: amd64 + arm64)
7. Return manifest digest

**Parameters:**

- `--digests-dir <path>` - Directory containing digest files
- `--tags <tag1,tag2>` - Comma-separated list of tags
- `--annotations <json-file>` - JSON file with OCI annotations (optional)
- `--registry <url>` - Registry URL
- `--image <name>` - Image name

**Reference bash (build-postgres-image.yml:417-455):**

```bash
docker buildx imagetools create \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-${{ github.ref_name }} \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-${{ github.ref_name }}-${{ github.sha }} \
  $(printf '${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@sha256:%s ' *)

INSPECT_JSON=$(docker buildx imagetools inspect ... --format '{{json .}}')
MANIFEST_DIGEST=$(echo "$INSPECT_JSON" | jq -r '.manifest.digest // empty')
echo "digest=${MANIFEST_DIGEST}" >> $GITHUB_OUTPUT
```

**Notes:**

- Annotations format: `--annotation "index:org.opencontainers.image.title=..."`
- The `index:` prefix is critical for OCI Image Index v1 format
- Must verify platform count = 2 (amd64 + arm64)

---

### Phase 6: Release-Critical Scripts (HIGH RISK)

⚠️ **WARNING:** These scripts are used in `publish.yml` (production releases). Test thoroughly on staging before using in production.

#### 6.1 Extract PostgreSQL Version

**File:** `scripts/build/extract-pg-version.ts`
**Current usage:** publish.yml:80-121 (prep job)
**Effort:** 45 minutes

**Logic:**

1. Read Dockerfile, extract `PG_VERSION` and `PG_BASE_IMAGE_SHA` args
2. Pull base image: `docker pull postgres:${PG_MAJOR}-trixie@${SHA}` (with retry)
3. Run `docker run --rm postgres:${PG_MAJOR}-trixie@${SHA} psql --version`
4. Parse version from output: "psql (PostgreSQL) 18.1 (Debian ...)" → "18.1"
5. Extract base image digest: `docker inspect --format='{{index .RepoDigests 0}}'`
6. Output JSON: `{"major": "18", "minor": "1", "full": "18.1", "base_image_digest": "sha256:..."}`

**Reference bash (publish.yml:80-121):**

```bash
PG_MAJOR=$(grep -m1 '^ARG PG_VERSION=' docker/postgres/Dockerfile | cut -d'=' -f2)
PG_BASE_SHA=$(grep -m1 '^ARG PG_BASE_IMAGE_SHA=' docker/postgres/Dockerfile | cut -d'=' -f2)

for i in {1..3}; do
  if docker pull postgres:${PG_MAJOR}-trixie@${PG_BASE_SHA}; then
    break
  fi
done

PG_VERSION_OUTPUT=$(docker run --rm postgres:${PG_MAJOR}-trixie@${PG_BASE_SHA} psql --version)
PG_FULL=$(echo "${PG_VERSION_OUTPUT}" | grep -oP '\d+\.\d+' | head -1)
# ... (extract digest, output to GITHUB_OUTPUT)
```

**Critical:** Version must be extracted from ACTUAL base image (not hardcoded) to ensure correctness.

**Local test:**

```bash
bun scripts/build/extract-pg-version.ts
# Should output JSON with version info
```

---

#### 6.2 Generate OCI Annotations

**File:** `scripts/ci/generate-oci-annotations.ts`
**Current usage:** publish.yml (3 locations - DUPLICATED!)
**Effort:** 40 minutes

**Logic:**
Generate OCI annotation flags for `docker buildx imagetools create`:

- Accept version info, catalog stats, metadata as JSON input
- Output array of `--annotation "index:key=value"` strings
- Supports both manifest index and image annotations

**Parameters:**

- `--pg-version <version>` - PostgreSQL version (e.g., "18.1")
- `--catalog-enabled <n>` - Number of enabled extensions
- `--catalog-total <n>` - Total extensions
- `--build-type <type>` - Build type (e.g., "single-node")
- `--sha <commit>` - Git commit SHA
- `--timestamp <ts>` - Build timestamp
- `--base-image <name>` - Base image name
- `--base-digest <digest>` - Base image digest
- `--format <format>` - Output format: "flags" (default) or "json"

**Output (flags format):**

```
--annotation "index:org.opencontainers.image.title=aza-pg Single-Node PostgreSQL"
--annotation "index:org.opencontainers.image.description=PostgreSQL 18.1 with 34 production-ready extensions..."
--annotation "index:org.opencontainers.image.vendor=fluxo-kt"
--annotation "index:org.opencontainers.image.version=18.1-202511142330-single-node"
--annotation "index:org.opencontainers.image.created=2025-11-14T23:30:00Z"
--annotation "index:org.opencontainers.image.revision=abc123"
--annotation "index:org.opencontainers.image.source=https://github.com/fluxo-kt/aza-pg"
--annotation "index:org.opencontainers.image.licenses=MIT"
--annotation "index:org.opencontainers.image.base.name=docker.io/library/postgres:18-trixie"
--annotation "index:org.opencontainers.image.base.digest=sha256:..."
--annotation "index:io.fluxo-kt.aza-pg.postgres.version=18.1"
--annotation "index:io.fluxo-kt.aza-pg.build.type=single-node"
--annotation "index:io.fluxo-kt.aza-pg.extensions.enabled=34"
--annotation "index:io.fluxo-kt.aza-pg.extensions.total=38"
```

**Reference bash (publish.yml:386-403, 851-873):**

```bash
docker buildx imagetools create \
  -t ... \
  --annotation "index:org.opencontainers.image.title=aza-pg Single-Node PostgreSQL" \
  --annotation "index:org.opencontainers.image.description=..." \
  # ... (14 total annotations)
```

**Critical notes:**

- `index:` prefix is REQUIRED for annotations on multi-arch manifest
- Annotations must be reapplied when creating new tags (don't auto-propagate)
- Currently duplicated 3x in publish.yml (lines 386-403, 851-873, and implicitly in build job)

**Local test:**

```bash
bun scripts/ci/generate-oci-annotations.ts \
  --pg-version 18.1 \
  --catalog-enabled 34 \
  --catalog-total 38 \
  --build-type single-node \
  --sha abc123 \
  --format flags
# Should output annotation flags
```

---

#### 6.3 Validate Manifest

**File:** `scripts/docker/validate-manifest.ts`
**Current usage:** publish.yml:422-552 (merge job)
**Effort:** 50 minutes

**Logic:**
Comprehensive validation of multi-arch manifest:

1. Get manifest in raw format: `docker buildx imagetools inspect --raw`
2. Parse JSON, extract media type
3. Verify media type (prefer OCI Image Index v1)
4. Verify platform count = 2
5. Verify both linux/amd64 and linux/arm64 present
6. Extract annotations, verify critical ones exist
7. Check annotation count > 0
8. Verify specific annotations: description, vendor, license

**Parameters:**

- `--image <ref>` - Image reference (tag or digest)
- `--expected-platforms <platform1,platform2>` - Expected platforms (default: linux/amd64,linux/arm64)
- `--required-annotations <key1,key2>` - Required annotation keys (comma-separated)

**Exit codes:**

- 0: Validation passed
- 1: Validation failed (with detailed error message)

**Reference bash (publish.yml:422-552):**

```bash
MANIFEST_JSON=$(docker buildx imagetools inspect ... --raw)
MEDIA_TYPE=$(echo "$MANIFEST_JSON" | jq -r '.mediaType // empty')

if [[ "$MEDIA_TYPE" == "application/vnd.oci.image.index.v1+json" ]]; then
  echo "✅ OCI Image Index v1 format"
  ANNOTATION_COUNT=$(echo "$MANIFEST_JSON" | jq '.annotations // {} | length')
  # ... (verify annotations)
elif [[ "$MEDIA_TYPE" == "application/vnd.docker.distribution.manifest.list.v2+json" ]]; then
  echo "⚠️ Docker manifest list v2 format (annotations NOT supported)"
fi

PLATFORM_COUNT=$(echo "$MANIFEST_JSON" | jq '.manifests | length')
[ "${PLATFORM_COUNT}" -ne 2 ] && exit 1

PLATFORMS=$(echo "$MANIFEST_JSON" | jq -r '.manifests[] | "\(.platform.os)/\(.platform.architecture)"')
echo "$PLATFORMS" | grep -q "linux/amd64" || exit 1
echo "$PLATFORMS" | grep -q "linux/arm64" || exit 1
```

**Local test:**

```bash
# Build a multi-arch image first, then:
bun scripts/docker/validate-manifest.ts \
  --image ghcr.io/fluxo-kt/aza-pg-testing:testing-abc123 \
  --expected-platforms "linux/amd64,linux/arm64" \
  --required-annotations "org.opencontainers.image.description,org.opencontainers.image.vendor"
```

---

#### 6.4 Promote Image

**File:** `scripts/release/promote-image.ts`
**Current usage:** publish.yml:842-891 (release job)
**Effort:** 60 minutes

**Logic:**
Promote testing image to production tags (digest-based, immutable):

1. Construct imagetools create command with source digest
2. Add multiple `-t` tags (versioned + convenience tags)
3. Reapply OCI annotations (call generate-oci-annotations.ts internally)
4. Execute promotion
5. Verify promoted image has same digest as source
6. Exit 1 if digest mismatch

**Parameters:**

- `--source <image-ref>` - Source image (testing repo)
- `--target-registry <url>` - Target registry
- `--target-image <name>` - Target image name
- `--tags <tag1,tag2>` - Comma-separated list of production tags
- `--annotations <json-file>` - Annotations JSON file (or use generate-oci-annotations.ts)
- `--expected-digest <digest>` - Expected digest (for verification)
- `--dry-run` - Print commands without executing

**Reference bash (publish.yml:842-891):**

```bash
docker buildx imagetools create \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.tag_versioned }} \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.pg_version_full }}-single-node \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.pg_version_major }}-single-node \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.pg_version_full }} \
  -t ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.pg_version_major }} \
  --annotation "index:org.opencontainers.image.title=..." \
  # ... (14 annotations)
  ${{ env.REGISTRY }}/${{ env.IMAGE_NAME_TESTING }}:testing-${{ github.sha }}

PROMOTED_DIGEST=$(docker buildx imagetools inspect ... | jq -r '.manifest.digest // empty')
[ "$PROMOTED_DIGEST" != "${{ needs.merge.outputs.image_digest }}" ] && exit 1
```

**Critical:**

- MUST preserve exact digest (digest-based promotion, not re-build)
- Annotations must be reapplied (don't auto-propagate from source)
- Verify digest matches expected value

**Local test (dry-run):**

```bash
bun scripts/release/promote-image.ts \
  --source ghcr.io/fluxo-kt/aza-pg-testing:testing-abc123 \
  --target-registry ghcr.io \
  --target-image fluxo-kt/aza-pg \
  --tags "18.1-202511142330-single-node,18.1-single-node,18-single-node" \
  --expected-digest sha256:abc123... \
  --dry-run
```

---

#### 6.5 Cleanup Testing Tags

**File:** `scripts/release/cleanup-testing-tags.ts`
**Current usage:** publish.yml:1132-1197 (cleanup job)
**Effort:** 40 minutes

**Logic:**
Delete testing tag via GitHub Packages API (with retry):

1. Get package version ID by tag: `gh api repos/:owner/:repo/packages/container/:package/versions`
2. Filter for matching tag using jq
3. Delete version: `gh api -X DELETE repos/:owner/:repo/packages/container/:package/versions/:id` (with retry)
4. Verify deletion (query again, ensure tag not found)

**Parameters:**

- `--repository <owner/repo>` - Repository
- `--package <name>` - Package name (e.g., "aza-pg-testing")
- `--tag <tag>` - Tag to delete
- `--max-retries <n>` - Max retry attempts (default: 3)
- `--dry-run` - Show what would be deleted without deleting

**Reference bash (publish.yml:1132-1197):**

```bash
TESTING_TAG="testing-${{ github.sha }}"
PACKAGE_NAME="aza-pg-testing"

VERSION_ID=$(gh api "repos/${{ github.repository }}/packages/container/$PACKAGE_NAME/versions" \
  --jq ".[] | select(.metadata.container.tags[] == \"$TESTING_TAG\") | .id" 2>/dev/null || echo "")

if [ -n "$VERSION_ID" ]; then
  for attempt in $(seq 1 3); do
    if gh api -X DELETE "repos/${{ github.repository }}/packages/container/$PACKAGE_NAME/versions/$VERSION_ID" 2>&1; then
      echo "✅ Successfully deleted"
      break
    fi
    sleep $((5 * attempt))
  done

  sleep 3
  VERIFY_ID=$(gh api ... --jq "..." || echo "")
  [ -n "$VERIFY_ID" ] && exit 1
fi
```

**Requires:**

- GITHUB_TOKEN with `packages:delete` permission
- `gh` CLI

**Local test (dry-run):**

```bash
GITHUB_TOKEN=xxx bun scripts/release/cleanup-testing-tags.ts \
  --repository fluxo-kt/aza-pg \
  --package aza-pg-testing \
  --tag testing-abc123 \
  --dry-run
```

---

#### 6.6 Sign Tags

**File:** `scripts/release/sign-tags.ts`
**Current usage:** publish.yml:893-905 (release job)
**Effort:** 20 minutes

**Logic:**
Sign multiple image tags with Cosign (keyless OIDC):

1. Loop through tag array
2. Run `cosign sign --yes <registry>/<image>:<tag>` for each
3. Report success/failure for each tag

**Parameters:**

- `--registry <url>` - Registry URL
- `--image <name>` - Image name
- `--tags <tag1,tag2>` - Comma-separated tags to sign
- `--dry-run` - Print commands without executing

**Reference bash (publish.yml:893-905):**

```bash
cosign sign --yes "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.tag_versioned }}"
cosign sign --yes "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.prep.outputs.pg_version_full }}-single-node"
# ... (5 total tags)
```

**Requires:**

- Cosign installed
- OIDC token (GitHub Actions provides automatically)

**Local test (requires Cosign + OIDC token):**

```bash
bun scripts/release/sign-tags.ts \
  --registry ghcr.io \
  --image fluxo-kt/aza-pg \
  --tags "18.1-202511142330-single-node,18.1-single-node" \
  --dry-run
```

---

### Phase 7: Workflow Updates (HIGH RISK)

#### 7.1 Update ci.yml

**Effort:** 30 minutes

**Changes:**

```diff
- - name: Parse Bun version from .tool-versions
-   id: bun-version
-   run: |
-     BUN_VERSION=$(grep '^bun ' .tool-versions | awk '{print $2}' | head -1)
-     echo "version=${BUN_VERSION}" >> $GITHUB_OUTPUT
-
- - name: Set up Bun
-   uses: oven-sh/setup-bun@v2
-   with:
-     bun-version: ${{ steps.bun-version.outputs.version }}
-
- - name: Cache Bun dependencies
-   uses: actions/cache@v4
-   with:
-     path: ~/.bun/install/cache
-     key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
-     restore-keys: |
-       ${{ runner.os }}-bun-
-
- - name: Install dependencies
-   run: bun install --frozen-lockfile
-   env:
-     BUN_CONFIG_INSTALL_MINIMUM_RELEASE_AGE: 86400
+ - name: Setup Bun
+   uses: ./.github/actions/setup-bun

- - name: Verify manifest is up to date
-   run: |
-     bun scripts/extensions/generate-manifest.ts
-     if ! diff -u \
-       <(git show HEAD:docker/postgres/extensions.manifest.json | jq 'del(.generatedAt)') \
-       <(jq 'del(.generatedAt)' docker/postgres/extensions.manifest.json); then
-       echo "::error::extensions.manifest.json content is out of date"
-       exit 1
-     fi
+ - name: Verify manifest is up to date
+   run: bun scripts/ci/verify-manifest-sync.ts

- - name: Repository health check
-   run: |
-     echo "🔍 Running repository health checks..."
-     test -f docker/postgres/Dockerfile || { echo "::error::Missing..."; exit 1; }
-     # ... (12 more test commands)
+ - name: Repository health check
+   run: bun scripts/ci/repository-health-check.ts
```

**Test:** Create PR with these changes, verify CI passes

---

#### 7.2 Update build-postgres-image.yml

**Effort:** 90 minutes (largest workflow, most changes)

**Changes:**

- Replace 7 Bun setup blocks → `uses: ./.github/actions/setup-bun`
- Replace 6 GHCR login blocks → `uses: ./.github/actions/ghcr-login`
- Replace 5 buildx setup blocks → `uses: ./.github/actions/setup-buildx`
- Replace cache monitoring bash → `run: bun scripts/ci/monitor-cache-usage.ts --github-summary --platform "${{ matrix.platform }}"`
- Replace diagnostics captures → `run: bun scripts/debug/capture-postgres-diagnostics.ts --container pg-ext-test --output-dir ${{ runner.temp }}/diagnostics`
- Replace image pull retries → `run: bun scripts/docker/pull-with-retry.ts --image ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:dev-${{ github.ref_name }}`

**Example diff (lint job):**

```diff
- - name: Parse Bun version from .tool-versions
-   id: bun-version
-   run: |
-     BUN_VERSION=$(grep '^bun ' .tool-versions | awk '{print $2}' | head -1)
-     echo "version=${BUN_VERSION}" >> $GITHUB_OUTPUT
-
- - name: Set up Bun
-   uses: oven-sh/setup-bun@v2
-   with:
-     bun-version: ${{ steps.bun-version.outputs.version }}
- # ... (cache + install steps)
+ - name: Setup Bun
+   uses: ./.github/actions/setup-bun
```

**Test:** Trigger manually with `push_image=false`, verify local build completes

---

#### 7.3 Update publish.yml

**Effort:** 120 minutes (release-critical, must be perfect)

**Strategy:** Test on staging first

1. Create temporary `release-test` branch
2. Modify workflow to use `aza-pg-testing` repo only (not production)
3. Apply all script/action changes
4. Trigger workflow
5. Verify all jobs complete successfully
6. Compare final image digest/annotations with previous release
7. Delete test artifacts
8. Only after successful staging test → apply to main release workflow

**Changes:**

- Replace Bun setup (2x) → `uses: ./.github/actions/setup-bun`
- Replace GHCR login (5x) → `uses: ./.github/actions/ghcr-login`
- Replace buildx setup (2x) → `uses: ./.github/actions/setup-buildx`
- Replace version extraction → `run: bun scripts/build/extract-pg-version.ts > version-info.json`
- Replace annotation generation (3x!) → `run: bun scripts/ci/generate-oci-annotations.ts --pg-version ... > annotations.txt`
- Replace manifest validation → `run: bun scripts/docker/validate-manifest.ts --image ...`
- Replace image promotion → `run: bun scripts/release/promote-image.ts --source ... --tags ...`
- Replace tag cleanup → `run: bun scripts/release/cleanup-testing-tags.ts --tag testing-${{ github.sha }}`
- Replace signing → `run: bun scripts/release/sign-tags.ts --tags ...`

**Test:** Staging branch with testing repo only, then manual verification

---

### Phase 8: Testing & Validation (CRITICAL)

#### 8.1 Local Testing Checklist

- [ ] Run every script individually with realistic inputs
- [ ] Test help flags (`--help`) for all scripts
- [ ] Test error cases (missing arguments, invalid inputs)
- [ ] Verify exit codes are correct (0=success, 1=failure)
- [ ] Check output format matches workflow expectations
- [ ] Test dry-run modes for destructive operations

#### 8.2 CI Testing Strategy

1. **ci.yml** (lowest risk)
   - Create PR with changes
   - Verify CI passes
   - Test manifest validation catches out-of-sync
   - Test health check catches missing files

2. **build-postgres-image.yml** (medium risk)
   - Trigger manually with `push_image=false`
   - Verify local build completes
   - Trigger with `push_image=true` (to testing repo)
   - Verify multi-platform build works
   - Verify diagnostics collected on failure (manually trigger failure)

3. **publish.yml** (highest risk - staging first!)
   - Create `release-test` branch
   - Modify to use testing repo only
   - Trigger workflow
   - Verify version extraction accuracy
   - Verify annotations present on final image
   - Verify digest promotion correct
   - Delete test artifacts
   - Compare with previous release (digest, annotations, size)

#### 8.3 Regression Testing

- [ ] Compare workflow run times (before/after) - should be negligibly different
- [ ] Compare final image digests (should be identical for same inputs)
- [ ] Compare annotations (should be preserved exactly)
- [ ] Verify error messages are clearer/more actionable
- [ ] Check that all edge cases handled (retries, failures, timeouts)

---

### Phase 9: Documentation & Cleanup

#### 9.1 Update Documentation

**Files to update:**

- `scripts/README.md` - Add new scripts with descriptions
- `.github/actions/README.md` - Document composite actions (create if missing)
- `docs/BUILD.md` - Update workflow references, add local testing examples
- `CLAUDE.md` - Update CI/CD section with new architecture

#### 9.2 Script Documentation Requirements

Every script must have:

- [ ] `--help` flag with usage examples
- [ ] Clear parameter descriptions
- [ ] Error messages that are actionable
- [ ] Examples in file header comments
- [ ] Local testing instructions

#### 9.3 Cleanup Checklist

- [ ] Remove any commented-out old bash code from workflows
- [ ] Verify no orphaned files left behind
- [ ] Run full validation: `bun run validate:full`
- [ ] Check all scripts have execute permissions
- [ ] Verify `.gitignore` doesn't exclude new scripts

---

## Success Criteria (Final Validation)

Before considering this complete, verify:

✅ **All 12+ scripts extracted** and working locally
✅ **All 6 composite actions created** and functional
✅ **96% duplication eliminated** (883 of 915 duplicated lines removed)
✅ **Workflows reduced** from ~3200 to ~2400 total lines (25% reduction)
✅ **100% local testability** (every script runnable with `bun`)
✅ **Zero functionality lost** (verified via comprehensive testing)
✅ **All edge cases covered** (error handling, retries, timeouts)
✅ **CI passes** for all three workflows
✅ **Release workflow tested** on staging before production
✅ **Documentation updated** with new script usage
✅ **No regressions** (image digests, annotations, workflow times)

---

## Timeline Estimate

| Phase             | Effort  | Description                            |
| ----------------- | ------- | -------------------------------------- |
| 1-2 (✅ Complete) | 5h      | Foundation scripts + composite actions |
| 3                 | 1.5h    | Diagnostic scripts                     |
| 4                 | 0.5h    | Workflow validation scripts            |
| 5                 | 2h      | Docker utility scripts                 |
| 6                 | 4h      | Release-critical scripts               |
| 7                 | 4h      | Workflow updates                       |
| 8                 | 3h      | Comprehensive testing                  |
| 9                 | 1h      | Documentation + cleanup                |
| **Total**         | **21h** | **Full completion**                    |

**Completed:** 5 hours (24%)
**Remaining:** 16 hours (76%)

---

## Risk Management

### Low Risk (Phases 3-5)

- Scripts used in non-production workflows
- Can test locally before workflow integration
- Rollback: Revert workflow file, scripts stay for future use

### High Risk (Phase 6-7)

- Release-critical functionality (publish.yml)
- Test on staging branch first
- Rollback: Git revert entire commit, instant recovery

### Mitigation Strategies

1. **Phased rollout** - Complete low-risk first
2. **Staging testing** - Test publish.yml on non-production branch
3. **Preserve behavior** - Scripts exactly replicate bash logic
4. **Comprehensive validation** - Test every script locally + in CI
5. **Rollback plan** - Git history allows instant revert

---

## Next Steps

1. **Continue with Phase 3** - Create diagnostic scripts (low risk, high value)
2. **Then Phase 4** - Workflow validation scripts (quick wins)
3. **Then Phase 5** - Docker utility scripts
4. **Careful with Phase 6** - Release-critical scripts (test thoroughly)
5. **Staged Phase 7** - ci.yml first, then build, finally publish (staging)
6. **Rigorous Phase 8** - Comprehensive testing at every step
7. **Complete Phase 9** - Documentation for future maintainers

---

## Questions & Decisions Needed

**For User:**

- [ ] Approve staging test approach for publish.yml before touching production?
- [ ] Prefer to batch-create remaining scripts then test, or create+test one-by-one?
- [ ] Should dry-run modes be added to all destructive operations?
- [ ] Any specific error handling patterns to follow beyond current standards?
