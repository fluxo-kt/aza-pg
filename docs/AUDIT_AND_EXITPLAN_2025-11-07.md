# aza-pg Full Audit and Exit Plan

Timestamp: 2025-11-07T12:05:55.539Z
Scope: docker/postgres image, auto-config entrypoint, extension build pipeline, stacks (primary/replica/single), PgBouncer bootstrap, monitoring exporters, and docs.

## Executive Summary (Problems → Actions)

1) PgBouncer healthcheck credential mismatch (client .pgpass entry does not match localhost:6432)
- Problem: pgbouncer-entrypoint.sh writes /tmp/.pgpass for host "postgres":5432, but healthcheck connects to localhost:6432; psql cannot read a matching entry → auth prompt → failure.
- Action: Write an additional .pgpass line for host=localhost port=6432 (and/or host=pgbouncer) with db=postgres user=pgbouncer_auth. Alternatively set PGPASSWORD inline in healthcheck. Validate with docker logs and successful SELECT 1 through PgBouncer.

2) Docs vs logs mismatch for auto-config grep
- Problem: PRODUCTION.md instructs grep "AUTO-CONFIG"; docker-auto-config-entrypoint.sh logs with prefix "[POSTGRES]" and no "AUTO-CONFIG" token → misleading doc.
- Action: Either add "AUTO-CONFIG" token to the entrypoint log line or update docs/tests to grep "[POSTGRES] RAM:". Prefer adding an explicit "AUTO-CONFIG" tag for stability.

3) Docs vs config mismatch on listen_addresses default
- Problem: PRODUCTION.md claims default is listen_addresses='*', but base config sets '127.0.0.1'. AGENTS.md states default localhost. Inconsistent and unsafe to trust docs.
- Action: Align docs to the actual default (127.0.0.1) and document how to expose (POSTGRES_BIND_IP=0.0.0.0 via compose). Add a prominent warning in PRODUCTION.md.

4) PRODUCTION.md references non-existent assets
- Problem: Mentions examples/backup/ and scripts/tools/generate-ssl-certs.sh, but those paths are absent in repo snapshot.
- Action: Either add those assets or remove/replace the references. If adding later, ensure samples cover retention, stanza setup, restore, and cert generation.

5) build-extensions.sh uses ad-hoc sed patches for pgrx and supautils
- Problem: Hidden patching increases maintenance risk and obscures upstream diffs.
- Action: Add manifest build.patches support and apply patches centrally in build-extensions.sh (git apply or sed with clear context). Keep current sed as fallback gated by feature flag and remove once upstream catches up.

6) PGDG pins hardcoded in Dockerfile
- Problem: Manual inline version bumps across multiple lines; error‑prone and noisy diffs.
- Action: Use ARGs for each PGDG package version (defaulted in Dockerfile) and reference in apt-get install. Document bump procedure in README/CHANGELOG.

7) PgBouncer password escaping comment vs implementation
- Problem: AGENTS.md claims wide char support; code escapes colon and backslash (correct for .pgpass) but does not escape whitespace or hash (not required), and healthcheck path ignores .pgpass (see issue #1).
- Action: Keep escaping as-is (colon, backslash are sufficient) but fix healthcheck and add a unit test to verify .pgpass matching for localhost:6432.

8) Missing explicit test for AUTO-CONFIG log pattern
- Problem: scripts/test/test-auto-config.sh does not assert on a stable tag; brittle greps possible.
- Action: Add assertion for "AUTO-CONFIG" once logs are updated; verify memory tiers (512MB/1GB/2GB/64GB) and connection caps.

9) Manifest vs PGDG availability drift (pgroonga)
- Problem: Docs indicate PGDG availability for pgroonga and suggest migration; manifest still compiles from source.
- Action: Decide and document: either keep source build (state rationale) or migrate to PGDG (reduce build time, multi-arch ease). Reflect in manifest and Dockerfile pins.

10) PgBouncer admin/monitoring separation
- Problem: pgbouncer-exporter connects to /pgbouncer; primary healthcheck uses regular DB through PgBouncer. No explicit admin user separation beyond postgres.
- Action: Consider a dedicated stats user with limited rights or keep as-is but document implications. Ensure pg_hba allows only needed CIDRs.

11) Replica bootstrap visibility
- Problem: compose references stacks/replica/scripts/00-setup-replica.sh; ensure it robustly handles re-runs and error cases (script content review pending if not present).
- Action: Verify script idempotency (creates recovery.conf equivalent via GUCs or standby.signal), networking, and slot usage; extend verification steps in PRODUCTION.md.

12) Rust toolchain installation via curl | sh
- Problem: Supply-chain and reproducibility concerns.
- Action: Pin rustup toolchain version (e.g., rustup default <hash>/stable-YYYY-MM-DD), or cache ~/.cargo and ~/.rustup; document rationale in Dockerfile comments.

13) Healthcheck semantics consistency
- Problem: Postgres healthchecks differ slightly across stacks (retries/timeouts); keep consistent unless justified.
- Action: Normalize intervals/timeouts across stacks; ensure start_period covers initdb + extension creation timings on cold start.

14) Monitoring queries duplication
- Problem: Queries file appears in docker/postgres/configs and referenced by stacks; ensure single source of truth.
- Action: Keep only docker/postgres/configs/postgres_exporter_queries.yaml and reference it everywhere. Remove per-stack duplicates if any.

15) Docs: upgrade path mentions UPGRADING.md
- Problem: UPGRADING.md absent.
- Action: Add UPGRADING.md or link to in-repo section with pg_upgrade guidance and extension update workflow.

---

## Detailed Findings

### Auto-config entrypoint (docker/postgres/docker-auto-config-entrypoint.sh)
- RAM detection order correct (POSTGRES_MEMORY > cgroup v2 > /proc/meminfo). CPU detection correctly uses cpu.max then nproc.
- Memory tiers: max_connections 80/120/200; work_mem cap 32MB; maintenance_work_mem cap 2GB; shared_buffers capped 32GB – consistent with AGENTS.md.
- Logging lacks the token the docs reference. Add a stable tag: e.g., "[AUTO-CONFIG] RAM=... CPU=..." and include all computed GUCs for grepping.
- Consider exporting computed values to /var/lib/postgresql/auto-config.env (optional) for operator introspection; defer unless needed to keep minimal.

### Base and stack configs
- postgresql-base.conf appropriately omits shared_preload_libraries (runtime -c flags win). listen_addresses='127.0.0.1' contradicts PRODUCTION.md; fix docs.
- postgresql-primary.conf includes cron and pgaudit GUCs; good separation from base. Keep base as single source of DRY settings.

### PgBouncer bootstrap and health
- .pgpass entry currently: postgres:5432:postgres:pgbouncer_auth:<pass>; healthcheck connects to localhost:6432 as pgbouncer_auth → mismatch; fix by adding localhost:6432 line.
- pgbouncer.ini.template uses auth_query and stats/admin users; transaction pooling configured. Document the limitations (no prepared statements, advisory locks) in README (already in AGENTS.md; link from README).

### Extensions build pipeline
- extensions.manifest.json mixes PGDG and source; build-extensions.sh skips PGDG; temporary sed patches for pgrx 0.16.1 alignment and supautils C fix – move to manifest patches.
- Dockerfile hard-pins PGDG packages; convert to ARGs for better bump flow; keep SHAs for base image.
- Consider enabling buildx mount caches for cargo registry and git to cut rebuild times further (already mounts /root/.cache). Optionally add CARGO_HOME cache mount.

### Monitoring/exporters
- Postgres exporter uses custom queries file; validate contents and ensure compatibility with PG18 views (`pg_stat_io`, `pg_stat_wal`).
- PgBouncer exporter uses dedicated connection string; ensure user grants documented.

### Docs
- PRODUCTION.md inaccuracies: AUTO-CONFIG token, listen_addresses, missing examples/backup and generate-ssl-certs.sh, and UPGRADING.md link.
- Cross-link AGENTS.md critical patterns to README to reduce drift. Consolidate duplication between AGENTS.md and PRODUCTION.md where feasible.

### Testing
- Ensure scripts/test/test-auto-config.sh covers 512MB/1GB/2GB/64GB and checks computed caps. Add assertion on new [AUTO-CONFIG] tag.
- Add a PgBouncer healthcheck test that spins container and verifies SELECT 1 via 6432 using .pgpass.

---

## Action Plan (Minimal, high impact first)

P0 – Fix broken/incorrect behavior
1. PgBouncer healthcheck credential mismatch
   - Update pgbouncer-entrypoint.sh to append a line: "localhost:6432:postgres:pgbouncer_auth:<escaped>" (and optionally "pgbouncer:6432").
   - Keep umask 077; export PGPASSFILE; verify with docker compose up and healthcheck passing.

P1 – Eliminate doc/code inconsistencies
2. Auto-config log token
   - Add "AUTO-CONFIG" tag to the log line in docker-auto-config-entrypoint.sh, or update docs/tests to use the existing tag. Prefer code change (one line).
3. Network binding docs
   - Update PRODUCTION.md to reflect listen_addresses='127.0.0.1' default and how to expose safely. Add a warning and exact override example.
4. Dead references
   - Remove or add examples/backup and scripts/tools/generate-ssl-certs.sh; if removed, add pointers to external guides or future task in TODO.
5. UPGRADING.md link
   - Create UPGRADING.md with pg_upgrade steps and extension bump guidance or update PRODUCTION.md to inline the steps.

P2 – Maintenance ergonomics
6. Manifest patching support
   - Extend build-extensions.sh to apply optional patches declared in manifest (git apply or sed commands with expected context). Migrate hardcoded sed to manifest once in place.
7. PGDG pin ARGs
   - Introduce ARGs for PGDG package versions to the Dockerfile; default to current pins; document bump process in README/CHANGELOG.

P3 – Tests/observability
8. Tests
   - Extend test-auto-config.sh to assert new log token and validate computed values at each tier.
   - Add a PgBouncer test that validates .pgpass and successful auth flow at 6432.

---

## Risks and Mitigations
- Changing healthcheck/.pgpass: Low risk; container-specific; verify locally.
- Adding log token: No functional change; minimal.
- Docs updates: No runtime impact.
- Manifest patching: Medium; keep behind feature flag initially and test affected extensions.
- PGDG ARGs: Low; purely build-time ergonomics; verify apt pins resolve.

## Rollout Plan
1. Implement P0 and P1 changes in a single PR; run existing tests and manual local compose validation (primary/single stacks).
2. Tag a patch release and update CHANGELOG.
3. Schedule P2/P3 improvements in subsequent PRs; keep diffs minimal per change.

## Validation Checklist
- PgBouncer healthcheck passes without interactive password prompt.
- docker logs contain "AUTO-CONFIG" with computed values.
- Docs: PRODUCTION.md no longer references missing paths; network binding described accurately; UPGRADING.md present or link fixed.
- Builds succeed with current pins; no extension regressions; tests pass.

## Suggested File Changes (minimal)
- stacks/primary/scripts/pgbouncer-entrypoint.sh: add .pgpass entry for localhost:6432 (and optionally pgbouncer:6432).
- docker/postgres/docker-auto-config-entrypoint.sh: include "AUTO-CONFIG" in the summary log line.
- docs/PRODUCTION.md: fix bindings, grep token, remove/add missing assets references.
- docs/UPGRADING.md: add or fix link.
- build-extensions.sh + extensions.manifest.json: introduce optional build.patches (follow-up PR).

## Backlog (defer)
- Consider migrating pgroonga to PGDG (if acceptable) to reduce build time.
- Pin rust toolchain explicitly and cache cargo registry more aggressively.
- Add provenance/SBOM enablement flags in CI only; keep local builds fast.

