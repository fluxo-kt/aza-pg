# scripts/: Bun TS tooling and test suites

Rules for code under `scripts/`. Root `AGENTS.md` applies too.

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

- **A test that needs Docker MUST be named `test-*.ts`, never `*.test.ts`**: the unit-test glob runs every `*.test.ts` without Docker, so it fails there. Every `*.test.ts` must pass without Docker. Add each `test-*.ts` to `SUITES` in `scripts/test-all.ts` with its group (`validate` fails until you do).
- **`$.env()` REPLACES the whole subprocess env**: `$.env({ COMPOSE_PROJECT_NAME: name })` drops PATH, HOME and DOCKER_CONFIG, so pulling an uncached image fails with `docker-credential-osxkeychain: executable file not found`. ALWAYS spread it: `$.env({ ...Bun.env, COMPOSE_PROJECT_NAME: name })`.

**Bun shell `rm -rf` fails on deep trees** with "Directory not empty" (e.g. pgroonga regression trees 7+ levels deep, like `expected/full-text-search/text/single/compatibility/v2`). For any directory that may be deep, do NOT use `` $`rm -rf dir` ``; use `import { rm } from "node:fs/promises"; await rm(dir, { recursive: true, force: true })`.

**Tool checks**: `testToolsPresent` finds each enabled tool by its manifest entry's `binaryPath` (executable) or `soFileName` (library under `pg_config --pkglibdir`); `validate-manifest.ts` rejects a tool naming neither, so a new tool cannot ship unchecked. Paths containing the PG major come from the running server (`pg_config`, `SHOW server_version_num`) — NEVER hardcode `postgresql/18/`.

**Test Architecture**: `test-all.ts` runs `scripts/docker/test-image.ts`, whose checks are all defined in `scripts/docker/test-image-lib.ts` — one definition per check, so no copy can drift. Add an image check there, not in a new standalone script.

**All checks in `test-image.ts` share one container**: wrap `ALTER EVENT TRIGGER ... DISABLE` in try/finally with `ENABLE` in `finally`; a missed re-enable breaks every later check in the suite.

**INSERT Idempotency**: Tests using `CREATE TABLE IF NOT EXISTS` + unconditional `INSERT` produce wrong counts when a container is reused (`test-image.ts --container=<name>`). ALWAYS add `TRUNCATE tablename RESTART IDENTITY` before INSERTs when the test asserts exact row counts or id values.

**Custom index types with external storage (PGroonga keeps Groonga files)**: `TRUNCATE` does NOT reliably clear that storage. A check MUST: (1) `DROP INDEX IF EXISTS`, which purges it; (2) insert all rows; (3) then run `CREATE INDEX` without `IF NOT EXISTS`. `IF NOT EXISTS` skips the rebuild, so stale data piles up. DROP may come before or after TRUNCATE. RUM uses normal PostgreSQL pages (no external storage) but follows the same pattern for consistency.

**psql Session Isolation**: Each `psql()`/`sqlOk()` call (`test-image-lib.ts`) spawns a new `docker exec ... psql` process — `SET` statements do NOT persist between calls. `SET enable_seqscan = OFF` and the `SELECT` it affects MUST go in one call (one string, or an array: its `-c` statements share one session).

**Postgres Entrypoint Readiness**: `pg_isready` can pass during the official image's temporary initdb server, right before entrypoint shutdown/restart. Fresh-container smoke tests MUST wait for `PostgreSQL init process complete; ready for start up.` in logs, then re-check `pg_isready` + `SELECT 1` against the final server.

**`DROP TABLE x CASCADE` keeps functions**: it drops the table's triggers, indexes, constraints and sequences, but NOT the functions its triggers call (a function can serve many tables). Drop every function a check creates explicitly (as `testPlpgsqlCheck` does), or it stays until the container is removed.

**Proving auto-config set a GUC**: `SELECT name FROM pg_settings WHERE name IN (...) AND sourcefile IS DISTINCT FROM '/var/run/postgresql/aza-auto-config.conf'` — any row means auto-config did not set it (default, a config file, or an operator `-c`/`ALTER SYSTEM`, which outrank auto-config). Never use `SHOW`: it always returns a value (the default if nothing set it), so it cannot tell "configured" from "default".

**`enabled: false` ≠ `runtime.defaultEnable: false`**: `enabled: false` means the extension is not in the image, so CREATE EXTENSION fails; select entries with `enabled !== false` first (`enabledEntries()` in `test-image-lib.ts`). `defaultEnable: false` means installed but not precreated in `public`; CREATE EXTENSION works, so it needs no guard. Mixing them up either runs checks on absent extensions or guards installed ones for nothing.

**Precreated extensions**: `testPrecreatedExtensions` reads the expected list from the `v_expected_exts` array in `01-extensions.sql` (plus pg_cron, created by `01b-pg_cron.sh`); edit that file, never a copy in a test — the manifest cannot derive it (`runtime.defaultEnable` covers preload libraries only).

**Membership checks go both ways**: a check of "expected ⊆ actual" must also check "actual ⊆ allowable", or unexpected entries pass unseen. The reverse uses the **allowable** set, not the required one. Example: `testPreloadedExtensions` checks every `defaultEnable:true` lib is in `shared_preload_libraries`, and every lib there is `sharedPreload:true`; checking the reverse against the required set would flag legitimate optional preloads.

**Assert prerequisites first**: `testPostgresConfiguration` (the "Startup state" batch of `test-image.ts`) checks the settings later behaviour checks need, so a failure names the cause. Example: with `wal_level != logical`, `testWal2jsonReplication` fails only with "slot creation failed". Any GUC whose wrong value would make a later check fail obscurely belongs there.

**`cleanupTestData` MUST drop every resource ANY test can create**, even ones the test drops itself: a test that fails early skips its own cleanup, so its resources pile up across failed runs. Example: `testPgmqQueue` creates `test_queue`, so `cleanupTestData` drops it too.

**Proving a volume-leak fix**: get the name of the anonymous volume each container mounted (`docker inspect <c> --format '{{range .Mounts}}{{.Name}}{{end}}'`) and check that exact volume is gone. Never compare total volume counts: a step that leaks on purpose (to show the bug) changes the next step's starting count.
