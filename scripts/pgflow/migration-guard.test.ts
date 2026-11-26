import { describe, expect, test } from "bun:test";
import { migrationTimeOptionalRefs } from "./migration-guard";

// Each case is a shape upstream pgflow migrations really contain.
describe("migrationTimeOptionalRefs", () => {
  test("finds upstream's migration-time pg_cron statements", () => {
    // 0.18.0's escalation mirroring, as upstream wrote it.
    const mirror = `SELECT cron.schedule_in_database(job_name => 'x', schedule => recovery.schedule)
FROM cron.job AS recovery WHERE recovery.jobname = 'pgflow_requeue_stalled_tasks';`;
    expect(migrationTimeOptionalRefs(mirror)).toEqual(["cron.schedule_in_database", "cron.job"]);
    expect(migrationTimeOptionalRefs(`CREATE EXTENSION IF NOT EXISTS "pg_cron";`)).toEqual([
      "pg_cron",
    ]);
  });

  test("ignores references the migration does not execute", () => {
    const sql = `-- runs cron.schedule later
DO $aza$ BEGIN IF to_regclass('cron.job') IS NOT NULL THEN PERFORM cron.schedule('a', 'b', 'c'); END IF; END $aza$;
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM vault.create_secret('s'); END $$;
COMMENT ON FUNCTION f IS 'follows the pg_cron pattern; it''s vault.decrypted_secrets based';`;
    expect(migrationTimeOptionalRefs(sql)).toEqual([]);
  });

  test("a tag closes only its own dollar quote", () => {
    // $$ inside $aza$ must not end the outer body early and expose what follows.
    const sql = `DO $aza$ BEGIN EXECUTE $$ SELECT 1 $$; PERFORM cron.schedule('a','b','c'); END $aza$;`;
    expect(migrationTimeOptionalRefs(sql)).toEqual([]);
  });
});
