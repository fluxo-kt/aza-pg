# scripts/: Bun TS tooling and test suites

Rules for writing scripts and Docker test checks here. Root `AGENTS.md` still binds.

**Bun APIs (ALWAYS prefer)**:

- `Bun.file()`, `Bun.write()` over fs/promises
- `Bun.$` or `Bun.spawn()` over child_process
- `Bun.env` over process.env
- Exception: `path` module (no Bun alternative), `stat()` from node:fs for directory checks (Bun.file.exists only works for files)

**`Bun.spawn()` pipe deadlock rule** — OS pipe buffer is ~64KB; exceeding it blocks the child writing, deadlocking `proc.exited`. **Three mandatory patterns**:

- **Exit-code only**: `stdout: "ignore", stderr: "ignore"` — no pipe, no risk
- **One stream needed**: unused stream → `"ignore"`, use `Promise.all([new Response(proc.stdout).text(), proc.exited])`
- **Both streams needed**: `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])`
- **NEVER**: `await proc.exited` THEN read streams — guaranteed deadlock for large output (docker info, docker logs, git ls-remote, etc.)
- **Bun `$` throws on non-zero exit**: an `if (result.exitCode !== 0)` branch needs `.nothrow()` before `.quiet()`/`.text()`, or it is dead code and the command's output is lost
- **Bun `$` starts only when awaited or `.then`-ed**: `` void $`docker rm …` `` in a timer or cleanup never runs; fire-and-forget uses `Bun.spawn([...], { stdout: "ignore", stderr: "ignore" })`
- **DRY**: use `isDockerDaemonRunning()` from `utils/docker.ts` — NEVER reimplement local `isDockerAvailable()` variants

## Tests

- ❌ Naming Docker-dependent tests `*.test.ts` → auto-discovered by unit test glob, runs without Docker, fails → ✅ Docker-dependent tests MUST use `test-*.ts` naming (NOT `*.test.ts`); add it to `SUITES` in `scripts/test-all.ts` with its group (`validate` fails until you do). All `*.test.ts` files are unconditionally unit-test safe.
- ❌ `$.env({ COMPOSE_PROJECT_NAME: name })` in test files — replaces the ENTIRE subprocess env (strips PATH, HOME, DOCKER_CONFIG), causing `docker-credential-osxkeychain: executable file not found` when Docker pulls uncached images → ✅ ALWAYS use `$.env({ ...Bun.env, COMPOSE_PROJECT_NAME: name })` to inherit the full process environment

**Bun Shell `rm -rf` Fails on Deep Directories**: Bun's shell `$` built-in `rm` fails with "Directory not empty" on deeply nested directories (e.g. pgroonga regression test trees with 7+ levels like `expected/full-text-search/text/single/compatibility/v2`). Do NOT use `$\`rm -rf dir\``for directories that may contain deep trees. Use`import { rm } from "node:fs/promises"; await rm(dir, { recursive: true, force: true })`instead — this is reliable on Linux.

**Tool checks**: `testToolsPresent` finds each enabled tool by its manifest entry's `binaryPath` (executable) or `soFileName` (library under `pg_config --pkglibdir`); `validate-manifest.ts` rejects a tool naming neither, so a new tool cannot ship unchecked. Paths containing the PG major come from the running server (`pg_config`, `SHOW server_version_num`) — NEVER hardcode `postgresql/18/`.

**Test Architecture**: `test-all.ts` runs `scripts/docker/test-image.ts`, whose checks are all defined in `scripts/docker/test-image-lib.ts` — one definition per check, so no copy can drift. Add an image check there, not in a new standalone script.

**Test Shared-Container Contamination**: All tests in `test-image.ts` share one container. Event trigger changes (`ALTER EVENT TRIGGER ... DISABLE`) MUST be wrapped in try/finally with `ENABLE` in the finally block — missed re-enable poisons all subsequent tests in the suite.

**INSERT Idempotency**: Tests using `CREATE TABLE IF NOT EXISTS` + unconditional `INSERT` produce wrong counts when a container is reused (`test-image.ts --container=<name>`). ALWAYS add `TRUNCATE tablename RESTART IDENTITY` before INSERTs when the test asserts exact row counts or id values.

**Custom AM Index Contamination**: For custom index AMs (PGroonga), `TRUNCATE` alone does NOT reliably clear the AM's external storage (Groonga files). The non-negotiable requirements are: (1) `DROP INDEX IF EXISTS` must occur to purge external storage, (2) `CREATE INDEX` must be unconditional (no `IF NOT EXISTS`), (3) `CREATE INDEX` must happen AFTER all INSERTs. The ORDER of DROP INDEX relative to TRUNCATE is flexible — both `DROP → TRUNCATE → INSERT → CREATE` and `TRUNCATE → DROP → INSERT → CREATE` are correct; what breaks things is `CREATE INDEX IF NOT EXISTS` after TRUNCATE (skips rebuild, stale external data accumulates). RUM uses standard PostgreSQL AM pages (no external storage); the same pattern is applied for consistency.

**psql Session Isolation**: Each `psql()`/`sqlOk()` call (`test-image-lib.ts`) spawns a new `docker exec ... psql` process — `SET` statements do NOT persist between calls. `SET enable_seqscan = OFF` and the `SELECT` it affects MUST go in one call (one string, or an array: its `-c` statements share one session).

**Postgres Entrypoint Readiness**: `pg_isready` can pass during the official image's temporary initdb server, right before entrypoint shutdown/restart. Fresh-container smoke tests MUST wait for `PostgreSQL init process complete; ready for start up.` in logs, then re-check `pg_isready` + `SELECT 1` against the final server.

**DROP TABLE CASCADE ≠ DROP FUNCTION**: `DROP TABLE x CASCADE` removes the table's triggers, indexes, constraints, and sequences — but NOT the trigger functions they reference. Functions are standalone objects reusable across multiple tables. Any function a check creates must be explicitly dropped (as `testPlpgsqlCheck` does) or it persists until the container is removed.

**Auto-config Verification**: Testing that a GUC was written by auto-config uses `SELECT name FROM pg_settings WHERE name IN (...) AND sourcefile IS DISTINCT FROM '/var/run/postgresql/aza-auto-config.conf'` — any row returned means auto-config did not set it (default, a config file, or an operator `-c`/`ALTER SYSTEM`, which outrank auto-config). `SHOW setting` is useless for this: PostgreSQL always returns a value (the default), so SHOW cannot distinguish "configured" from "at default". A non-empty result from `SHOW shared_buffers` proves nothing.

**`enabled: false` vs `defaultEnable: false`**: `enabled: false` = extension absent from image (select from `MANIFEST_ENTRIES` with `enabled !== false`, as `enabledEntries()` in `test-image-lib.ts` does, before calling CREATE EXTENSION — it will fail). `runtime.defaultEnable: false` = extension installed but NOT precreated in public schema (no guard needed — CREATE EXTENSION works in tests fine). Conflating these either makes tests meaningless (no guard on absent ext) or adds useless guards on installed exts.

**Precreated extensions**: `testPrecreatedExtensions` reads the expected list from the `v_expected_exts` array in `01-extensions.sql` (plus pg_cron, created by `01b-pg_cron.sh`); edit that file, never a copy in a test — the manifest cannot derive it (`runtime.defaultEnable` covers preload libraries only).

**Bidirectional Membership Checks**: Any test that validates "expected ⊆ actual" must also validate the reverse — "actual ⊆ allowable" — or unexpected entries go undetected. IMPORTANT: the reverse check must use the **allowable** superset, not the **required** set. Example: `testPreloadedExtensions` checks (1) all `defaultEnable:true` libs ARE in `shared_preload_libraries` (forward) and (2) everything IN `shared_preload_libraries` IS a `sharedPreload:true` lib (reverse). Using `required` for the reverse would flag legitimate optional preloads as rogue entries.

**Fail-Fast for Behaviour Prerequisites**: `testPostgresConfiguration` (the "Startup state" batch of `test-image.ts`) asserts the settings later behaviour checks need. If `wal_level != logical`, `testWal2jsonReplication` fails with a cryptic "slot creation failed" error; the config assertion names the cause. Rule: any GUC whose wrong value would make a behaviour check fail obscurely belongs in `testPostgresConfiguration`.

**cleanupTestData Must Cover ALL Failure Paths**: The cleanup function is a safety net — it must drop every resource ANY test can create, regardless of whether tests clean up after themselves on the happy path. Tests that create resources only drop them on the success path (early failure returns skip cleanup). If `cleanupTestData` doesn't also drop them, they accumulate on failed runs. Example: `testPgmqQueue` creates `test_queue`, so `cleanupTestData` drops it too.

**Proving a volume-leak fix**: check the exact anonymous volume each container mounted (`docker inspect <c> --format '{{range .Mounts}}{{.Name}}{{end}}'`) still exists or not, never total volume counts: a step that leaks on purpose shifts the next step's baseline.
