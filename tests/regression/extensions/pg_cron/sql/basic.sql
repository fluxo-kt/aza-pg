--
-- pg_cron - Basic regression test
-- Tests extension creation and job scheduling (without actual execution)
--
-- Verify extension is preloaded
SELECT
  extname
FROM
  pg_extension
WHERE
  extname = 'pg_cron';


-- Verify cron schema exists
SELECT
  count(*)
FROM
  information_schema.schemata
WHERE
  schema_name = 'cron';


-- Verify cron tables exist
SELECT
  count(*)
FROM
  information_schema.tables
WHERE
  table_schema = 'cron'
  AND table_name IN ('job', 'job_run_details');


-- Clean up any leftover test jobs from previous runs
SELECT
  cron.unschedule (jobid)
FROM
  cron.job
WHERE
  jobname = 'regression-test-job';


-- Schedule a test job (check that ID > 0, not exact value)
SELECT
  cron.schedule ('regression-test-job', '0 0 * * *', 'SELECT 1') > 0 AS scheduled;


-- Verify job was created
SELECT
  jobname,
  schedule,
  command
FROM
  cron.job
WHERE
  jobname = 'regression-test-job';


-- Unschedule job
SELECT
  cron.unschedule (jobid)
FROM
  cron.job
WHERE
  jobname = 'regression-test-job';


-- Verify job was removed
SELECT
  count(*)
FROM
  cron.job
WHERE
  jobname = 'regression-test-job';