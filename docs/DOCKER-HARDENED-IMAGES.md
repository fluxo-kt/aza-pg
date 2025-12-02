# Docker Hardened Images (DHI) Assessment

**Assessment Date**: 2025-12-18
**DHI Status**: Free tier available (Apache 2.0), PG 18 not yet supported
**Decision**: Do not migrate at this time

---

## Executive Summary

Docker Hardened Images (DHI) offer distroless, near-zero-CVE PostgreSQL containers with SLSA L3 provenance. However, migration is **not recommended** due to:

1. PostgreSQL 18 unavailability (only PG 16/17 offered)
2. Massive rewrite effort (2-4 weeks) for marginal security gain
3. Strong existing security posture (SHA pinning, Cosign, SBOM, non-root)
4. High migration risk with 32+ extensions

---

## What Are Docker Hardened Images?

**Docker Hardened Images** are minimal, secure, production-ready container images maintained by Docker. Launched May 2025, made **free and open source** (Apache 2.0) on December 17, 2025.

### Key Features

- **Distroless runtime**: No shell, no package manager, 95% smaller attack surface
- **Near-zero CVEs**: Removes unnecessary packages that harbor vulnerabilities
- **SLSA Build Level 3**: Verifiable, tamper-resistant supply chain security
- **Signed SBOMs**: Complete Software Bill of Materials for every component
- **VEX statements**: Vulnerability Exploitability eXchange documentation
- **Non-root by default**: UID 70 (postgres user)

### Comparison: Standard vs DHI

| Aspect          | Standard postgres:18-trixie | DHI postgres:17-debian13 |
| --------------- | --------------------------- | ------------------------ |
| Shell           | ✓ bash/sh                   | ❌ None (distroless)     |
| Package manager | ✓ apt                       | ❌ None (distroless)     |
| Size            | ~412 MB (typical)           | ~35 MB (distroless)      |
| CVEs            | 100+ potential              | Near-zero                |
| SLSA provenance | ❌                          | ✓ Level 3                |
| Non-root        | ✓ (postgres)                | ✓ (postgres, UID 70)     |

---

## DHI PostgreSQL Availability

**As of December 2025:**

| Version   | Available            | Base OS Options                 |
| --------- | -------------------- | ------------------------------- |
| **PG 18** | ❌ **Not available** | N/A                             |
| PG 17     | ✓                    | Debian 13 (trixie), Alpine 3.22 |
| PG 16     | ✓                    | Debian 13 (trixie), Alpine 3.22 |

**Critical blocker**: aza-pg requires PostgreSQL 18.1 — DHI does not offer PG 18.

**Pull command** (for reference): `docker pull dhi.io/postgres:17-debian13`

---

## aza-pg Current Security Posture

Our current security measures are already robust:

| Measure                   | Implementation                               | Location                             |
| ------------------------- | -------------------------------------------- | ------------------------------------ |
| **SHA256 digest pinning** | Immutable base image reference               | `manifest-data.ts:23`                |
| **SHA validation**        | Script validates digest exists on Docker Hub | `scripts/validate-base-image-sha.ts` |
| **Cosign image signing**  | Keyless signing via Sigstore                 | `.github/workflows/publish.yml`      |
| **SBOM generation**       | Build provenance attestations                | `.github/workflows/publish.yml`      |
| **Non-root runtime**      | Final image runs as `postgres` user          | `Dockerfile:386`                     |
| **Supply chain delay**    | 1-day delay before installing new packages   | Bun config                           |
| **Frozen lockfile**       | Reproducible builds                          | `bun install --frozen-lockfile`      |

**Conclusion**: We already implement most DHI benefits without distroless constraints.

---

## Migration Effort Analysis

### Technical Constraints of DHI

#### 1. No Shell in Runtime

DHI runtime images are **distroless** — they contain NO shell (bash/sh). This impacts:

| Component                          | Lines   | Challenge                                           |
| ---------------------------------- | ------- | --------------------------------------------------- |
| `docker-auto-config-entrypoint.sh` | 514     | Complex bash with associative arrays, 15+ functions |
| `healthcheck.sh`                   | 129     | PostgreSQL queries via psql                         |
| Init scripts                       | 4 files | Heredoc SQL execution                               |
| Upstream PostgreSQL entrypoint     | ~600    | Official image's bash initialization                |

**Required work**: Rewrite all logic in Go/Rust compiled binaries.

#### 2. No Package Manager in Runtime

DHI runtime images have NO apt. Current extension installation:

| Method             | Count | DHI Compatibility            |
| ------------------ | ----- | ---------------------------- |
| PGDG apt           | 14    | Needs multi-stage extraction |
| Percona apt        | 2     | Needs multi-stage extraction |
| Timescale apt      | 2     | Needs multi-stage extraction |
| Source compile     | 13    | ✓ Already multi-stage        |
| GitHub release     | 1     | ✓ Already multi-stage        |
| PostgreSQL builtin | 7     | ✓ Part of base               |

**Required work**: Extract `.so` and `.control` files from apt packages in builder stages.

#### 3. Non-Standard Paths

DHI uses `/opt/postgresql/17/bin` vs standard Debian `/usr/lib/postgresql/18/bin`.

**Required work**: Update all path references throughout codebase.

### Estimated Migration Cost

| Task                                | Effort    | Risk   |
| ----------------------------------- | --------- | ------ |
| Rewrite entrypoints in Go/Rust      | 1-2 weeks | Medium |
| Port healthcheck to compiled binary | 3-5 days  | Low    |
| Multi-stage extension extraction    | 1 week    | Medium |
| Test all 32+ extensions             | 1 week    | High   |
| Handle upstream entrypoint          | 1 week    | High   |
| Path adjustments                    | 2 days    | Low    |

**Total estimated effort**: 2-4 weeks of focused engineering work.

### Ongoing Maintenance Burden

- Dual codebase (compiled for prod, shell for dev)
- No shell debugging in prod containers
- Extension compatibility monitoring in non-standard environment
- Binary rebuilds on any entrypoint logic changes

---

## Cost-Benefit Analysis

### Benefits of Migration

| Benefit            | Value for aza-pg                               |
| ------------------ | ---------------------------------------------- |
| Reduced CVEs       | **Marginal** — can scan/update current image   |
| SLSA L3 provenance | **Nice-to-have** — already have Cosign signing |
| Smaller image size | **Minor** — not a bottleneck                   |
| Compliance optics  | **Context-dependent** — may help with audits   |

### Costs of Migration

| Cost                  | Impact                                        |
| --------------------- | --------------------------------------------- |
| PG 18 unavailable     | **Blocker** — would require version downgrade |
| 2-4 weeks engineering | **High** — disproportionate effort            |
| Maintenance burden    | **Medium** — dual codebase complexity         |
| Debugging difficulty  | **Medium** — no shell in prod                 |
| Extension risk        | **High** — 32+ extensions untested            |
| Flexibility loss      | **Medium** — can't iterate on entrypoint      |

**Verdict**: Costs vastly outweigh benefits.

---

## Decision

### Do NOT Migrate to DHI at This Time

**Primary reasons:**

1. **PostgreSQL 18 not available** — Switching requires downgrading from PG 18 to PG 17
2. **Disproportionate effort** — 2-4 weeks engineering for marginal security gain
3. **Already secure** — SHA pinning, Cosign, SBOM, non-root all implemented
4. **High risk** — 32+ extensions in untested distroless environment
5. **Flexibility loss** — Distroless prevents shell debugging and runtime changes

### Alternative Actions (Recommended)

1. **Monitor DHI for PG 18 support**
   Check https://github.com/docker-hardened-images/catalog quarterly

2. **Scan current image for CVEs**
   Use Docker Scout or Trivy to identify actual vulnerabilities:

   ```bash
   docker scout cves postgres:18.1-trixie@sha256:38d5c9d522...
   ```

3. **Address specific CVEs as needed**
   Update base image SHA when PostgreSQL releases security patches

4. **Maintain existing security posture**
   Continue SHA pinning, Cosign signing, SBOM generation

### When to Reconsider

Revisit DHI migration if ANY of these occur:

- DHI adds PostgreSQL 18 support
- Compliance mandate explicitly requires distroless containers
- Planning to rewrite entrypoints for other reasons (performance, features)
- CVE count in current image becomes unmanageable (>50 critical/high)

---

## Technical Deep Dive

### DHI Variants

DHI offers two PostgreSQL variants:

1. **Runtime** (`dhi.io/postgres:17-debian13`)
   - Distroless: No shell, no apt
   - Use for production deployments
   - Cannot extend at runtime

2. **Dev** (`dhi.io/postgres:17-dev`)
   - Includes bash, apt, build tools (autoconf, clang, llvm, etc.)
   - Use in multi-stage builds for compiling extensions
   - NOT for production

### Migration Pattern (If Pursued)

```dockerfile
# Build stage with DHI dev variant
FROM dhi.io/postgres:17-dev AS builder
RUN apt-get update && apt-get install -y postgresql-17-pgvector
# Extract .so files to /opt/ext-out

# Runtime stage with DHI distroless
FROM dhi.io/postgres:17-debian13
COPY --from=builder /opt/ext-out /usr/lib/postgresql/17/lib
```

### DHI Pricing Tiers

| Tier               | Cost              | Features                                          |
| ------------------ | ----------------- | ------------------------------------------------- |
| **DHI Free**       | Free (Apache 2.0) | Near-zero CVEs, SBOMs, SLSA L3, non-root          |
| **DHI Enterprise** | Paid              | + 7-day CVE SLA, FIPS/STIG, customization service |
| **DHI ELS**        | Paid (add-on)     | + 5 years extended lifecycle support post-EOL     |

---

## References

### Official DHI Documentation

- Product page: https://www.docker.com/products/hardened-images/
- Documentation: https://docs.docker.com/dhi/
- GitHub catalog: https://github.com/docker-hardened-images/catalog
- Blog announcement: https://www.docker.com/blog/docker-hardened-images-for-every-developer/

### aza-pg Files Analyzed

- `scripts/extensions/manifest-data.ts` — Base image SHA definition
- `docker/postgres/Dockerfile.template` — Multi-stage build structure
- `docker/postgres/docker-auto-config-entrypoint.sh` — 514 lines of bash
- `docker/postgres/healthcheck.sh` — 129 lines of bash
- `.github/workflows/publish.yml` — Cosign signing, attestations

---

## Changelog

- **2025-12-18**: Initial assessment — DHI not recommended (PG 18 unavailable, high migration cost)
