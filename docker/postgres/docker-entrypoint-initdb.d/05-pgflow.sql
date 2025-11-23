-- ============================================================================
-- pgflow v0.7.2 - DAG-Based Workflow Orchestration (Built-in)
-- ============================================================================
--
-- WHAT IS THIS:
--   pgflow is a PostgreSQL-native workflow orchestration system that provides
--   DAG (Directed Acyclic Graph) execution, task queuing, retry logic with
--   exponential backoff, and worker tracking. This SQL schema is automatically
--   installed during database initialization.
--
-- VERSION: v0.7.2 (Complete - Phases 1-11)
--   Source: https://github.com/pgflow-dev/pgflow @ @pgflow/core@0.7.2
--
-- INSTALLATION:
--   This file is automatically executed during database initialization via
--   /docker-entrypoint-initdb.d/. No manual installation required.
--
-- DEPENDENCIES:
--   - pgmq extension (PostgreSQL Message Queue) - auto-enabled in aza-pg
--   - PostgreSQL 14+ (for gen_random_uuid, jsonb functions)
--
-- FEATURES INCLUDED:
--   ✓ DAG workflow definition and execution
--   ✓ Step dependencies and ordering
--   ✓ Task queuing via pgmq
--   ✓ Retry logic with exponential backoff
--   ✓ Worker registration and heartbeat tracking
--   ✓ Flow/step/task state management
--
-- LIMITATIONS (Known):
--   ✗ Real-time event broadcasting (Supabase-specific, stubbed as no-op)
--   ✗ Row Level Security / auth.users integration (Supabase-specific)
--   ℹ️ Phase 12 (pgmq 1.5.1 upgrade) not applicable for aza-pg pgmq version
--
-- SCHEMAS CREATED:
--   - pgflow: Core workflow tables and functions
--   - pgmq: Message queue (if not already exists)
--   - realtime: Stub schema for Supabase compatibility (no-op send function)
--
-- DOCUMENTATION:
--   See /docs/pgflow/INTEGRATION.md for comprehensive usage guide
--
-- ============================================================================
-- ============================================================================
-- SCHEMA CREATION
-- ============================================================================
-- Ensure pgflow schema exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgflow') THEN
    CREATE SCHEMA "pgflow";
  END IF;
END
$$;


-- Ensure pgmq schema exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgmq') THEN
    CREATE SCHEMA "pgmq";
  END IF;
END
$$;


-- Ensure pgmq extension exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pgmq'
  ) THEN
    -- Note: Version may vary - install latest available version
    CREATE EXTENSION "pgmq" WITH SCHEMA "pgmq";
  END IF;
END
$$;


-- ============================================================================
-- REALTIME STUB (Supabase Compatibility Layer)
-- ============================================================================
-- pgflow uses Supabase's realtime.send() for event broadcasting.
-- For standalone PostgreSQL, we create a no-op stub function.
-- You can replace this with your own event notification system (pg_notify, etc.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'realtime') THEN
    CREATE SCHEMA "realtime";
  END IF;
END
$$;


CREATE OR REPLACE FUNCTION realtime.send (payload JSONB, event TEXT, topic TEXT, private BOOLEAN DEFAULT FALSE) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Stub function for standalone PostgreSQL
  -- Original Supabase function broadcasts real-time events to clients
  --
  -- IMPLEMENTATION OPTIONS:
  -- 1. Use LISTEN/NOTIFY for async notifications:
  --    PERFORM pg_notify('pgflow_events', payload::text);
  -- 2. Log to a separate events table
  -- 3. Integrate with external message queue (Redis, RabbitMQ, etc.)
  -- 4. Leave as no-op (current implementation)

  -- No-op for now
  RETURN;
END;
$$;


COMMENT ON FUNCTION realtime.send IS 'Stub function replacing Supabase realtime.send(). Replace with your own event notification system.';


-- ============================================================================
-- PGFLOW CORE SCHEMA (v0.7.2)
-- ============================================================================
-- ----------------------------------------------------------------------------
-- INITIAL SCHEMA (20250429164909_pgflow_initial.sql)
-- ----------------------------------------------------------------------------
-- Create "read_with_poll" function
CREATE OR REPLACE FUNCTION "pgflow"."read_with_poll" (
  "queue_name" TEXT,
  "vt" INTEGER,
  "qty" INTEGER,
  "max_poll_seconds" INTEGER DEFAULT 5,
  "poll_interval_ms" INTEGER DEFAULT 100,
  "conditional" JSONB DEFAULT '{}'
) RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $$
DECLARE
    r pgmq.message_record;
    stop_at TIMESTAMP;
    sql TEXT;
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
BEGIN
    stop_at := clock_timestamp() + make_interval(secs => max_poll_seconds);
    LOOP
      IF (SELECT clock_timestamp() >= stop_at) THEN
        RETURN;
      END IF;

      sql := FORMAT(
          $QUERY$
          WITH cte AS
          (
              SELECT msg_id
              FROM pgmq.%I
              WHERE vt <= clock_timestamp() AND CASE
                  WHEN %L != '{}'::jsonb THEN (message @> %2$L)::integer
                  ELSE 1
              END = 1
              ORDER BY msg_id ASC
              LIMIT $1
              FOR UPDATE SKIP LOCKED
          )
          UPDATE pgmq.%I m
          SET
              vt = clock_timestamp() + %L,
              read_ct = read_ct + 1
          FROM cte
          WHERE m.msg_id = cte.msg_id
          RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message;
          $QUERY$,
          qtable, conditional, qtable, make_interval(secs => vt)
      );

      FOR r IN
        EXECUTE sql USING qty
      LOOP
        RETURN NEXT r;
      END LOOP;
      IF FOUND THEN
        RETURN;
      ELSE
        PERFORM pg_sleep(poll_interval_ms::numeric / 1000);
      END IF;
    END LOOP;
END;
$$;


-- Create composite type "step_task_record"
CREATE TYPE "pgflow"."step_task_record" AS (
  "flow_slug" TEXT,
  "run_id" UUID,
  "step_slug" TEXT,
  "input" JSONB,
  "msg_id" BIGINT
);


-- Create "is_valid_slug" function
CREATE OR REPLACE FUNCTION "pgflow"."is_valid_slug" ("slug" TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    RETURN
      slug IS NOT NULL
      AND slug <> ''
      AND length(slug) <= 128
      AND slug ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'
      AND slug NOT IN ('run'); -- reserved words
END;
$$;


-- Create "flows" table
CREATE TABLE IF NOT EXISTS "pgflow"."flows" (
  "flow_slug" TEXT NOT NULL,
  "opt_max_attempts" INTEGER NOT NULL DEFAULT 3,
  "opt_base_delay" INTEGER NOT NULL DEFAULT 1,
  "opt_timeout" INTEGER NOT NULL DEFAULT 60,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("flow_slug"),
  CONSTRAINT "opt_base_delay_is_nonnegative" CHECK (opt_base_delay >= 0),
  CONSTRAINT "opt_max_attempts_is_nonnegative" CHECK (opt_max_attempts >= 0),
  CONSTRAINT "opt_timeout_is_positive" CHECK (opt_timeout > 0),
  CONSTRAINT "slug_is_valid" CHECK (pgflow.is_valid_slug (flow_slug))
);


-- Create "steps" table
CREATE TABLE IF NOT EXISTS "pgflow"."steps" (
  "flow_slug" TEXT NOT NULL,
  "step_slug" TEXT NOT NULL,
  "step_type" TEXT NOT NULL DEFAULT 'single',
  "step_index" INTEGER NOT NULL DEFAULT 0,
  "deps_count" INTEGER NOT NULL DEFAULT 0,
  "opt_max_attempts" INTEGER NULL,
  "opt_base_delay" INTEGER NULL,
  "opt_timeout" INTEGER NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("flow_slug", "step_slug"),
  CONSTRAINT "steps_flow_slug_step_index_key" UNIQUE ("flow_slug", "step_index"),
  CONSTRAINT "steps_flow_slug_fkey" FOREIGN KEY ("flow_slug") REFERENCES "pgflow"."flows" ("flow_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "opt_base_delay_is_nonnegative" CHECK (
    (opt_base_delay IS NULL)
    OR (opt_base_delay >= 0)
  ),
  CONSTRAINT "opt_max_attempts_is_nonnegative" CHECK (
    (opt_max_attempts IS NULL)
    OR (opt_max_attempts >= 0)
  ),
  CONSTRAINT "opt_timeout_is_positive" CHECK (
    (opt_timeout IS NULL)
    OR (opt_timeout > 0)
  ),
  CONSTRAINT "steps_deps_count_check" CHECK (deps_count >= 0),
  CONSTRAINT "steps_step_slug_check" CHECK (pgflow.is_valid_slug (step_slug)),
  CONSTRAINT "steps_step_type_check" CHECK (step_type = 'single'::TEXT)
);


-- Create "deps" table
CREATE TABLE IF NOT EXISTS "pgflow"."deps" (
  "flow_slug" TEXT NOT NULL,
  "dep_slug" TEXT NOT NULL,
  "step_slug" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("flow_slug", "dep_slug", "step_slug"),
  CONSTRAINT "deps_flow_slug_dep_slug_fkey" FOREIGN KEY ("flow_slug", "dep_slug") REFERENCES "pgflow"."steps" ("flow_slug", "step_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "deps_flow_slug_fkey" FOREIGN KEY ("flow_slug") REFERENCES "pgflow"."flows" ("flow_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "deps_flow_slug_step_slug_fkey" FOREIGN KEY ("flow_slug", "step_slug") REFERENCES "pgflow"."steps" ("flow_slug", "step_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "deps_check" CHECK (dep_slug <> step_slug)
);


CREATE INDEX IF NOT EXISTS "idx_deps_by_flow_dep" ON "pgflow"."deps" ("flow_slug", "dep_slug");


CREATE INDEX IF NOT EXISTS "idx_deps_by_flow_step" ON "pgflow"."deps" ("flow_slug", "step_slug");


-- Create "runs" table
CREATE TABLE IF NOT EXISTS "pgflow"."runs" (
  "run_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "flow_slug" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'started',
  "input" JSONB NOT NULL,
  "output" JSONB NULL,
  "remaining_steps" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ NULL,
  "failed_at" TIMESTAMPTZ NULL,
  PRIMARY KEY ("run_id"),
  CONSTRAINT "runs_flow_slug_fkey" FOREIGN KEY ("flow_slug") REFERENCES "pgflow"."flows" ("flow_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "completed_at_is_after_started_at" CHECK (
    (completed_at IS NULL)
    OR (completed_at >= started_at)
  ),
  CONSTRAINT "completed_at_or_failed_at" CHECK (
    NOT (
      (completed_at IS NOT NULL)
      AND (failed_at IS NOT NULL)
    )
  ),
  CONSTRAINT "failed_at_is_after_started_at" CHECK (
    (failed_at IS NULL)
    OR (failed_at >= started_at)
  ),
  CONSTRAINT "runs_remaining_steps_check" CHECK (remaining_steps >= 0),
  CONSTRAINT "status_is_valid" CHECK (status = ANY (ARRAY['started'::TEXT, 'failed'::TEXT, 'completed'::TEXT]))
);


CREATE INDEX IF NOT EXISTS "idx_runs_flow_slug" ON "pgflow"."runs" ("flow_slug");


CREATE INDEX IF NOT EXISTS "idx_runs_status" ON "pgflow"."runs" ("status");


-- Create "step_states" table
CREATE TABLE IF NOT EXISTS "pgflow"."step_states" (
  "flow_slug" TEXT NOT NULL,
  "run_id" UUID NOT NULL,
  "step_slug" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'created',
  "remaining_tasks" INTEGER NOT NULL DEFAULT 1,
  "remaining_deps" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "started_at" TIMESTAMPTZ NULL,
  "completed_at" TIMESTAMPTZ NULL,
  "failed_at" TIMESTAMPTZ NULL,
  PRIMARY KEY ("run_id", "step_slug"),
  CONSTRAINT "step_states_flow_slug_fkey" FOREIGN KEY ("flow_slug") REFERENCES "pgflow"."flows" ("flow_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "step_states_flow_slug_step_slug_fkey" FOREIGN KEY ("flow_slug", "step_slug") REFERENCES "pgflow"."steps" ("flow_slug", "step_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "step_states_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pgflow"."runs" ("run_id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "completed_at_is_after_started_at" CHECK (
    (completed_at IS NULL)
    OR (completed_at >= started_at)
  ),
  CONSTRAINT "completed_at_or_failed_at" CHECK (
    NOT (
      (completed_at IS NOT NULL)
      AND (failed_at IS NOT NULL)
    )
  ),
  CONSTRAINT "failed_at_is_after_started_at" CHECK (
    (failed_at IS NULL)
    OR (failed_at >= started_at)
  ),
  CONSTRAINT "started_at_is_after_created_at" CHECK (
    (started_at IS NULL)
    OR (started_at >= created_at)
  ),
  CONSTRAINT "status_and_remaining_tasks_match" CHECK (
    (status <> 'completed'::TEXT)
    OR (remaining_tasks = 0)
  ),
  CONSTRAINT "status_is_valid" CHECK (
    status = ANY (ARRAY['created'::TEXT, 'started'::TEXT, 'completed'::TEXT, 'failed'::TEXT])
  ),
  CONSTRAINT "step_states_remaining_deps_check" CHECK (remaining_deps >= 0),
  CONSTRAINT "step_states_remaining_tasks_check" CHECK (remaining_tasks >= 0)
);


CREATE INDEX IF NOT EXISTS "idx_step_states_failed" ON "pgflow"."step_states" ("run_id", "step_slug")
WHERE
  (status = 'failed'::TEXT);


CREATE INDEX IF NOT EXISTS "idx_step_states_flow_slug" ON "pgflow"."step_states" ("flow_slug");


CREATE INDEX IF NOT EXISTS "idx_step_states_ready" ON "pgflow"."step_states" ("run_id", "status", "remaining_deps")
WHERE
  (
    (status = 'created'::TEXT)
    AND (remaining_deps = 0)
  );


-- Create "step_tasks" table
CREATE TABLE IF NOT EXISTS "pgflow"."step_tasks" (
  "flow_slug" TEXT NOT NULL,
  "run_id" UUID NOT NULL,
  "step_slug" TEXT NOT NULL,
  "message_id" BIGINT NULL,
  "task_index" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts_count" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT NULL,
  "output" JSONB NULL,
  "queued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ NULL,
  "failed_at" TIMESTAMPTZ NULL,
  PRIMARY KEY ("run_id", "step_slug", "task_index"),
  CONSTRAINT "step_tasks_flow_slug_fkey" FOREIGN KEY ("flow_slug") REFERENCES "pgflow"."flows" ("flow_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "step_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pgflow"."runs" ("run_id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "step_tasks_run_id_step_slug_fkey" FOREIGN KEY ("run_id", "step_slug") REFERENCES "pgflow"."step_states" ("run_id", "step_slug") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "attempts_count_nonnegative" CHECK (attempts_count >= 0),
  CONSTRAINT "completed_at_is_after_queued_at" CHECK (
    (completed_at IS NULL)
    OR (completed_at >= queued_at)
  ),
  CONSTRAINT "completed_at_or_failed_at" CHECK (
    NOT (
      (completed_at IS NOT NULL)
      AND (failed_at IS NOT NULL)
    )
  ),
  CONSTRAINT "failed_at_is_after_queued_at" CHECK (
    (failed_at IS NULL)
    OR (failed_at >= queued_at)
  ),
  CONSTRAINT "only_single_task_per_step" CHECK (task_index = 0),
  CONSTRAINT "output_valid_only_for_completed" CHECK (
    (output IS NULL)
    OR (status = 'completed'::TEXT)
  ),
  CONSTRAINT "valid_status" CHECK (status = ANY (ARRAY['queued'::TEXT, 'completed'::TEXT, 'failed'::TEXT]))
);


CREATE INDEX IF NOT EXISTS "idx_step_tasks_completed" ON "pgflow"."step_tasks" ("run_id", "step_slug")
WHERE
  (status = 'completed'::TEXT);


CREATE INDEX IF NOT EXISTS "idx_step_tasks_failed" ON "pgflow"."step_tasks" ("run_id", "step_slug")
WHERE
  (status = 'failed'::TEXT);


CREATE INDEX IF NOT EXISTS "idx_step_tasks_flow_run_step" ON "pgflow"."step_tasks" ("flow_slug", "run_id", "step_slug");


CREATE INDEX IF NOT EXISTS "idx_step_tasks_message_id" ON "pgflow"."step_tasks" ("message_id");


CREATE INDEX IF NOT EXISTS "idx_step_tasks_queued" ON "pgflow"."step_tasks" ("run_id", "step_slug")
WHERE
  (status = 'queued'::TEXT);


-- Create "poll_for_tasks" function (will be deprecated later)
CREATE OR REPLACE FUNCTION "pgflow"."poll_for_tasks" (
  "queue_name" TEXT,
  "vt" INTEGER,
  "qty" INTEGER,
  "max_poll_seconds" INTEGER DEFAULT 5,
  "poll_interval_ms" INTEGER DEFAULT 100
) RETURNS SETOF "pgflow"."step_task_record" LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH read_messages AS (
  SELECT *
  FROM pgflow.read_with_poll(
    queue_name,
    vt,
    qty,
    max_poll_seconds,
    poll_interval_ms
  )
),
tasks AS (
  SELECT
    task.flow_slug,
    task.run_id,
    task.step_slug,
    task.task_index,
    task.message_id
  FROM pgflow.step_tasks AS task
  JOIN read_messages AS message ON message.msg_id = task.message_id
  WHERE task.message_id = message.msg_id
    AND task.status = 'queued'
),
increment_attempts AS (
  UPDATE pgflow.step_tasks
  SET attempts_count = attempts_count + 1
  FROM tasks
  WHERE step_tasks.message_id = tasks.message_id
  AND status = 'queued'
),
runs AS (
  SELECT
    r.run_id,
    r.input
  FROM pgflow.runs r
  WHERE r.run_id IN (SELECT run_id FROM tasks)
),
deps AS (
  SELECT
    st.run_id,
    st.step_slug,
    dep.dep_slug,
    dep_task.output AS dep_output
  FROM tasks st
  JOIN pgflow.deps dep ON dep.flow_slug = st.flow_slug AND dep.step_slug = st.step_slug
  JOIN pgflow.step_tasks dep_task ON
    dep_task.run_id = st.run_id AND
    dep_task.step_slug = dep.dep_slug AND
    dep_task.status = 'completed'
),
deps_outputs AS (
  SELECT
    d.run_id,
    d.step_slug,
    jsonb_object_agg(d.dep_slug, d.dep_output) AS deps_output
  FROM deps d
  GROUP BY d.run_id, d.step_slug
),
timeouts AS (
  SELECT
    task.message_id,
    coalesce(step.opt_timeout, flow.opt_timeout) + 2 AS vt_delay
  FROM tasks task
  JOIN pgflow.flows flow ON flow.flow_slug = task.flow_slug
  JOIN pgflow.steps step ON step.flow_slug = task.flow_slug AND step.step_slug = task.step_slug
)

SELECT
  st.flow_slug,
  st.run_id,
  st.step_slug,
  jsonb_build_object('run', r.input) ||
  coalesce(dep_out.deps_output, '{}'::jsonb) AS input,
  st.message_id AS msg_id
FROM tasks st
JOIN runs r ON st.run_id = r.run_id
LEFT JOIN deps_outputs dep_out ON
  dep_out.run_id = st.run_id AND
  dep_out.step_slug = st.step_slug
CROSS JOIN LATERAL (
  SELECT pgmq.set_vt(queue_name, st.message_id,
    (SELECT t.vt_delay FROM timeouts t WHERE t.message_id = st.message_id)
  )
) set_vt;
$$;


-- Create "add_step" function (multiple overloads)
CREATE OR REPLACE FUNCTION "pgflow"."add_step" (
  "flow_slug" TEXT,
  "step_slug" TEXT,
  "deps_slugs" TEXT[],
  "max_attempts" INTEGER DEFAULT NULL::INTEGER,
  "base_delay" INTEGER DEFAULT NULL::INTEGER,
  "timeout" INTEGER DEFAULT NULL::INTEGER
) RETURNS "pgflow"."steps" LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH
  next_index AS (
    SELECT COALESCE(MAX(step_index) + 1, 0) AS idx
    FROM pgflow.steps
    WHERE flow_slug = add_step.flow_slug
  ),
  create_step AS (
    INSERT INTO pgflow.steps (flow_slug, step_slug, step_index, deps_count, opt_max_attempts, opt_base_delay, opt_timeout)
    SELECT add_step.flow_slug, add_step.step_slug, idx, COALESCE(array_length(deps_slugs, 1), 0), max_attempts, base_delay, timeout
    FROM next_index
    ON CONFLICT (flow_slug, step_slug)
    DO UPDATE SET step_slug = pgflow.steps.step_slug
    RETURNING *
  ),
  insert_deps AS (
    INSERT INTO pgflow.deps (flow_slug, dep_slug, step_slug)
    SELECT add_step.flow_slug, d.dep_slug, add_step.step_slug
    FROM unnest(deps_slugs) AS d(dep_slug)
    ON CONFLICT (flow_slug, dep_slug, step_slug) DO NOTHING
    RETURNING 1
  )
SELECT * FROM create_step;
$$;


CREATE OR REPLACE FUNCTION "pgflow"."add_step" (
  "flow_slug" TEXT,
  "step_slug" TEXT,
  "max_attempts" INTEGER DEFAULT NULL::INTEGER,
  "base_delay" INTEGER DEFAULT NULL::INTEGER,
  "timeout" INTEGER DEFAULT NULL::INTEGER
) RETURNS "pgflow"."steps" LANGUAGE sql
SET
  "search_path" = '' AS $$
SELECT * FROM pgflow.add_step(flow_slug, step_slug, ARRAY[]::text[], max_attempts, base_delay, timeout);
$$;


-- Create "calculate_retry_delay" function
CREATE OR REPLACE FUNCTION "pgflow"."calculate_retry_delay" ("base_delay" NUMERIC, "attempts_count" INTEGER) RETURNS INTEGER LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT floor(base_delay * power(2, attempts_count))::int
$$;


-- Create "maybe_complete_run" function
CREATE OR REPLACE FUNCTION "pgflow"."maybe_complete_run" ("run_id" UUID) RETURNS void LANGUAGE sql
SET
  "search_path" = '' AS $$
UPDATE pgflow.runs
SET
  status = 'completed',
  completed_at = now(),
  output = (
    SELECT jsonb_object_agg(st.step_slug, st.output)
    FROM pgflow.step_tasks st
    JOIN pgflow.step_states ss ON ss.run_id = st.run_id AND ss.step_slug = st.step_slug
    JOIN pgflow.runs r ON r.run_id = ss.run_id AND r.flow_slug = ss.flow_slug
    WHERE st.run_id = maybe_complete_run.run_id
      AND st.status = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM pgflow.deps d
        WHERE d.flow_slug = ss.flow_slug
          AND d.dep_slug = ss.step_slug
      )
  )
WHERE pgflow.runs.run_id = maybe_complete_run.run_id
  AND pgflow.runs.remaining_steps = 0
  AND pgflow.runs.status != 'completed';
$$;


-- Create "start_ready_steps" function
CREATE OR REPLACE FUNCTION "pgflow"."start_ready_steps" ("run_id" UUID) RETURNS void LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH ready_steps AS (
  SELECT *
  FROM pgflow.step_states AS step_state
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
  ORDER BY step_state.step_slug
  FOR UPDATE
),
started_step_states AS (
  UPDATE pgflow.step_states
  SET status = 'started',
      started_at = now()
  FROM ready_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = ready_steps.step_slug
  RETURNING pgflow.step_states.*
),
sent_messages AS (
  SELECT
    started_step.flow_slug,
    started_step.run_id,
    started_step.step_slug,
    pgmq.send(started_step.flow_slug, jsonb_build_object(
      'flow_slug', started_step.flow_slug,
      'run_id', started_step.run_id,
      'step_slug', started_step.step_slug,
      'task_index', 0
    )) AS msg_id
  FROM started_step_states AS started_step
)
INSERT INTO pgflow.step_tasks (flow_slug, run_id, step_slug, message_id)
SELECT
  sent_messages.flow_slug,
  sent_messages.run_id,
  sent_messages.step_slug,
  sent_messages.msg_id
FROM sent_messages;
$$;


-- Create "complete_task" function
CREATE OR REPLACE FUNCTION "pgflow"."complete_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "output" JSONB) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
BEGIN

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = complete_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  FOR UPDATE
),
task AS (
  UPDATE pgflow.step_tasks
  SET
    status = 'completed',
    completed_at = now(),
    output = complete_task.output
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index
  RETURNING *
),
step_state AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN 'completed'
    ELSE 'started'
    END,
    completed_at = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN now()
    ELSE NULL
    END,
    remaining_tasks = pgflow.step_states.remaining_tasks - 1
  FROM task
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  RETURNING pgflow.step_states.*
),
dependent_steps AS (
  SELECT d.step_slug AS dependent_step_slug
  FROM pgflow.deps d
  JOIN step_state s ON s.status = 'completed' AND d.flow_slug = s.flow_slug
  WHERE d.dep_slug = complete_task.step_slug
  ORDER BY d.step_slug
),
dependent_steps_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug IN (SELECT dependent_step_slug FROM dependent_steps)
  FOR UPDATE
),
dependent_steps_update AS (
  UPDATE pgflow.step_states
  SET remaining_deps = pgflow.step_states.remaining_deps - 1
  FROM dependent_steps
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = dependent_steps.dependent_step_slug
)
UPDATE pgflow.runs
SET remaining_steps = pgflow.runs.remaining_steps - 1
FROM step_state
WHERE pgflow.runs.run_id = complete_task.run_id
  AND step_state.status = 'completed';

PERFORM pgmq.archive(
  queue_name => (SELECT run.flow_slug FROM pgflow.runs AS run WHERE run.run_id = complete_task.run_id),
  msg_id => (SELECT message_id FROM pgflow.step_tasks AS step_task
             WHERE step_task.run_id = complete_task.run_id
             AND step_task.step_slug = complete_task.step_slug
             AND step_task.task_index = complete_task.task_index)
);

PERFORM pgflow.start_ready_steps(complete_task.run_id);

PERFORM pgflow.maybe_complete_run(complete_task.run_id);

RETURN QUERY SELECT *
FROM pgflow.step_tasks AS step_task
WHERE step_task.run_id = complete_task.run_id
  AND step_task.step_slug = complete_task.step_slug
  AND step_task.task_index = complete_task.task_index;

END;
$$;


-- Create "create_flow" function
CREATE OR REPLACE FUNCTION "pgflow"."create_flow" (
  "flow_slug" TEXT,
  "max_attempts" INTEGER DEFAULT 3,
  "base_delay" INTEGER DEFAULT 5,
  "timeout" INTEGER DEFAULT 60
) RETURNS "pgflow"."flows" LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH
  flow_upsert AS (
    INSERT INTO pgflow.flows (flow_slug, opt_max_attempts, opt_base_delay, opt_timeout)
    VALUES (flow_slug, max_attempts, base_delay, timeout)
    ON CONFLICT (flow_slug) DO UPDATE
    SET flow_slug = pgflow.flows.flow_slug
    RETURNING *
  ),
  ensure_queue AS (
    SELECT pgmq.create(flow_slug)
    WHERE NOT EXISTS (
      SELECT 1 FROM pgmq.list_queues() WHERE queue_name = flow_slug
    )
  )
SELECT f.*
FROM flow_upsert f
LEFT JOIN (SELECT 1 FROM ensure_queue) _dummy ON true;
$$;


-- Create "fail_task" function
CREATE OR REPLACE FUNCTION "pgflow"."fail_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "error_message" TEXT) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
BEGIN

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = fail_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  FOR UPDATE
),
flow_info AS (
  SELECT r.flow_slug
  FROM pgflow.runs r
  WHERE r.run_id = fail_task.run_id
),
config AS (
  SELECT
    COALESCE(s.opt_max_attempts, f.opt_max_attempts) AS opt_max_attempts,
    COALESCE(s.opt_base_delay, f.opt_base_delay) AS opt_base_delay
  FROM pgflow.steps s
  JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
  JOIN flow_info fi ON fi.flow_slug = s.flow_slug
  WHERE s.flow_slug = fi.flow_slug AND s.step_slug = fail_task.step_slug
),

fail_or_retry_task AS (
  UPDATE pgflow.step_tasks AS task
  SET
    status = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN 'queued'
      ELSE 'failed'
    END,
    failed_at = CASE
      WHEN task.attempts_count >= (SELECT opt_max_attempts FROM config) THEN now()
      ELSE NULL
    END,
    error_message = fail_task.error_message
  WHERE task.run_id = fail_task.run_id
    AND task.step_slug = fail_task.step_slug
    AND task.task_index = fail_task.task_index
    AND task.status = 'queued'
  RETURNING *
),
maybe_fail_step AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
             WHEN (SELECT fail_or_retry_task.status FROM fail_or_retry_task) = 'failed' THEN 'failed'
             ELSE pgflow.step_states.status
             END,
    failed_at = CASE
                WHEN (SELECT fail_or_retry_task.status FROM fail_or_retry_task) = 'failed' THEN now()
                ELSE NULL
                END
  FROM fail_or_retry_task
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  RETURNING pgflow.step_states.*
)
UPDATE pgflow.runs
SET status = CASE
              WHEN (SELECT status FROM maybe_fail_step) = 'failed' THEN 'failed'
              ELSE status
              END,
    failed_at = CASE
                WHEN (SELECT status FROM maybe_fail_step) = 'failed' THEN now()
                ELSE NULL
                END
WHERE pgflow.runs.run_id = fail_task.run_id;

-- For queued tasks: delay the message for retry with exponential backoff
PERFORM (
  WITH retry_config AS (
    SELECT
      COALESCE(s.opt_base_delay, f.opt_base_delay) AS base_delay
    FROM pgflow.steps s
    JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
    JOIN pgflow.runs r ON r.flow_slug = f.flow_slug
    WHERE r.run_id = fail_task.run_id
      AND s.step_slug = fail_task.step_slug
  ),
  queued_tasks AS (
    SELECT
      r.flow_slug,
      st.message_id,
      pgflow.calculate_retry_delay((SELECT base_delay FROM retry_config), st.attempts_count) AS calculated_delay
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'queued'
  )
  SELECT pgmq.set_vt(qt.flow_slug, qt.message_id, qt.calculated_delay)
  FROM queued_tasks qt
  WHERE EXISTS (SELECT 1 FROM queued_tasks)
);

-- For failed tasks: archive the message
PERFORM (
  WITH failed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'failed'
  )
  SELECT pgmq.archive(ft.flow_slug, ft.message_id)
  FROM failed_tasks ft
  WHERE EXISTS (SELECT 1 FROM failed_tasks)
);

RETURN QUERY SELECT *
FROM pgflow.step_tasks st
WHERE st.run_id = fail_task.run_id
  AND st.step_slug = fail_task.step_slug
  AND st.task_index = fail_task.task_index;

END;
$$;


-- Create "start_flow" function (initial version, will be replaced)
CREATE OR REPLACE FUNCTION "pgflow"."start_flow" ("flow_slug" TEXT, "input" JSONB) RETURNS SETOF "pgflow"."runs" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
DECLARE
  v_created_run pgflow.runs%ROWTYPE;
BEGIN

WITH
  flow_steps AS (
    SELECT steps.flow_slug, steps.step_slug, steps.deps_count
    FROM pgflow.steps
    WHERE steps.flow_slug = start_flow.flow_slug
  ),
  created_run AS (
    INSERT INTO pgflow.runs (flow_slug, input, remaining_steps)
    VALUES (
      start_flow.flow_slug,
      start_flow.input,
      (SELECT count(*) FROM flow_steps)
    )
    RETURNING *
  ),
  created_step_states AS (
    INSERT INTO pgflow.step_states (flow_slug, run_id, step_slug, remaining_deps)
    SELECT
      fs.flow_slug,
      (SELECT run_id FROM created_run),
      fs.step_slug,
      fs.deps_count
    FROM flow_steps fs
  )
SELECT * FROM created_run INTO v_created_run;

PERFORM pgflow.start_ready_steps(v_created_run.run_id);

RETURN QUERY SELECT * FROM pgflow.runs WHERE run_id = v_created_run.run_id;

END;
$$;


-- Create "workers" table
CREATE TABLE IF NOT EXISTS "pgflow"."workers" (
  "worker_id" UUID NOT NULL,
  "queue_name" TEXT NOT NULL,
  "function_name" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "stopped_at" TIMESTAMPTZ NULL,
  "last_heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("worker_id")
);


CREATE INDEX IF NOT EXISTS "idx_workers_queue_name" ON "pgflow"."workers" ("queue_name");


-- ----------------------------------------------------------------------------
-- PHASE 2: Fix poll_for_tasks to use separate statement for polling
-- ============================================================================
-- MIGRATION SECTION: Schema Upgrade from v0.7.1 → v0.7.2
-- ============================================================================
-- This section is ONLY for upgrading existing pgflow installations.
-- Fresh installations skip this - tables are created correctly from the start.
--
-- (20250517125006_20250517072017_pgflow_fix_poll_for_tasks_to_use_separate_statement_for_polling.sql)
-- ----------------------------------------------------------------------------
-- NOTE: The following ALTER statements have Squawk warnings that are false positives
-- for init scripts. They apply to live database migrations, not fresh installs.
-- Modify "poll_for_tasks" function
CREATE OR REPLACE FUNCTION "pgflow"."poll_for_tasks" (
  "queue_name" TEXT,
  "vt" INTEGER,
  "qty" INTEGER,
  "max_poll_seconds" INTEGER DEFAULT 5,
  "poll_interval_ms" INTEGER DEFAULT 100
) RETURNS SETOF "pgflow"."step_task_record" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
DECLARE
  msg_ids bigint[];
BEGIN
  SELECT array_agg(msg_id)
  INTO msg_ids
  FROM pgflow.read_with_poll(
    queue_name,
    vt,
    qty,
    max_poll_seconds,
    poll_interval_ms
  );

  IF msg_ids IS NULL OR array_length(msg_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH tasks AS (
    SELECT
      task.flow_slug,
      task.run_id,
      task.step_slug,
      task.task_index,
      task.message_id
    FROM pgflow.step_tasks AS task
    WHERE task.message_id = ANY(msg_ids)
      AND task.status = 'queued'
  ),
  increment_attempts AS (
    UPDATE pgflow.step_tasks
    SET attempts_count = attempts_count + 1
    FROM tasks
    WHERE step_tasks.message_id = tasks.message_id
    AND status = 'queued'
  ),
  runs AS (
    SELECT
      r.run_id,
      r.input
    FROM pgflow.runs r
    WHERE r.run_id IN (SELECT run_id FROM tasks)
  ),
  deps AS (
    SELECT
      st.run_id,
      st.step_slug,
      dep.dep_slug,
      dep_task.output AS dep_output
    FROM tasks st
    JOIN pgflow.deps dep ON dep.flow_slug = st.flow_slug AND dep.step_slug = st.step_slug
    JOIN pgflow.step_tasks dep_task ON
      dep_task.run_id = st.run_id AND
      dep_task.step_slug = dep.dep_slug AND
      dep_task.status = 'completed'
  ),
  deps_outputs AS (
    SELECT
      d.run_id,
      d.step_slug,
      jsonb_object_agg(d.dep_slug, d.dep_output) AS deps_output
    FROM deps d
    GROUP BY d.run_id, d.step_slug
  ),
  timeouts AS (
    SELECT
      task.message_id,
      coalesce(step.opt_timeout, flow.opt_timeout) + 2 AS vt_delay
    FROM tasks task
    JOIN pgflow.flows flow ON flow.flow_slug = task.flow_slug
    JOIN pgflow.steps step ON step.flow_slug = task.flow_slug AND step.step_slug = task.step_slug
  )
  SELECT
    st.flow_slug,
    st.run_id,
    st.step_slug,
    jsonb_build_object('run', r.input) ||
    coalesce(dep_out.deps_output, '{}'::jsonb) AS input,
    st.message_id AS msg_id
  FROM tasks st
  JOIN runs r ON st.run_id = r.run_id
  LEFT JOIN deps_outputs dep_out ON
    dep_out.run_id = st.run_id AND
    dep_out.step_slug = st.step_slug
  CROSS JOIN LATERAL (
    SELECT pgmq.set_vt(queue_name, st.message_id,
      (SELECT t.vt_delay FROM timeouts t WHERE t.message_id = st.message_id)
    )
  ) set_vt;
END;
$$;


-- ----------------------------------------------------------------------------
-- PHASE 3: Add start_tasks and started status
-- ============================================================================
-- MIGRATION SECTION: Schema Upgrade for Started Status
-- ============================================================================
-- This section is ONLY for upgrading existing pgflow installations.
-- Fresh installations skip this - tables are created correctly from the start.
--
-- (20250610080624_20250609105135_pgflow_add_start_tasks_and_started_status.sql)
-- ----------------------------------------------------------------------------
-- NOTE: The following ALTER statements have Squawk warnings that are false positives
-- for init scripts. They apply to live database migrations, not fresh installs.
-- Add heartbeat index to workers
CREATE INDEX IF NOT EXISTS "idx_workers_heartbeat" ON "pgflow"."workers" ("last_heartbeat_at");


-- Modify "step_tasks" table to add started status and worker tracking
ALTER TABLE "pgflow"."step_tasks"
DROP CONSTRAINT "valid_status",
ADD CONSTRAINT "valid_status" CHECK (
  status = ANY (ARRAY['queued'::TEXT, 'started'::TEXT, 'completed'::TEXT, 'failed'::TEXT])
),
ADD CONSTRAINT "completed_at_is_after_started_at" CHECK (
  (completed_at IS NULL)
  OR (started_at IS NULL)
  OR (completed_at >= started_at)
),
ADD CONSTRAINT "failed_at_is_after_started_at" CHECK (
  (failed_at IS NULL)
  OR (started_at IS NULL)
  OR (failed_at >= started_at)
),
ADD CONSTRAINT "started_at_is_after_queued_at" CHECK (
  (started_at IS NULL)
  OR (started_at >= queued_at)
),
ADD COLUMN "started_at" TIMESTAMPTZ NULL,
ADD COLUMN "last_worker_id" UUID NULL,
ADD CONSTRAINT "step_tasks_last_worker_id_fkey" FOREIGN KEY ("last_worker_id") REFERENCES "pgflow"."workers" ("worker_id") ON UPDATE NO ACTION ON DELETE SET NULL;


CREATE INDEX IF NOT EXISTS "idx_step_tasks_last_worker" ON "pgflow"."step_tasks" ("last_worker_id")
WHERE
  (status = 'started'::TEXT);


CREATE INDEX IF NOT EXISTS "idx_step_tasks_queued_msg" ON "pgflow"."step_tasks" ("message_id")
WHERE
  (status = 'queued'::TEXT);


CREATE INDEX IF NOT EXISTS "idx_step_tasks_started" ON "pgflow"."step_tasks" ("started_at")
WHERE
  (status = 'started'::TEXT);


-- Update complete_task to handle 'started' status
CREATE OR REPLACE FUNCTION "pgflow"."complete_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "output" JSONB) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
BEGIN

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = complete_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  FOR UPDATE
),
task AS (
  UPDATE pgflow.step_tasks
  SET
    status = 'completed',
    completed_at = now(),
    output = complete_task.output
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index
    AND pgflow.step_tasks.status = 'started'
  RETURNING *
),
step_state AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN 'completed'
    ELSE 'started'
    END,
    completed_at = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN now()
    ELSE NULL
    END,
    remaining_tasks = pgflow.step_states.remaining_tasks - 1
  FROM task
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  RETURNING pgflow.step_states.*
),
dependent_steps AS (
  SELECT d.step_slug AS dependent_step_slug
  FROM pgflow.deps d
  JOIN step_state s ON s.status = 'completed' AND d.flow_slug = s.flow_slug
  WHERE d.dep_slug = complete_task.step_slug
  ORDER BY d.step_slug
),
dependent_steps_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug IN (SELECT dependent_step_slug FROM dependent_steps)
  FOR UPDATE
),
dependent_steps_update AS (
  UPDATE pgflow.step_states
  SET remaining_deps = pgflow.step_states.remaining_deps - 1
  FROM dependent_steps
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = dependent_steps.dependent_step_slug
)
UPDATE pgflow.runs
SET remaining_steps = pgflow.runs.remaining_steps - 1
FROM step_state
WHERE pgflow.runs.run_id = complete_task.run_id
  AND step_state.status = 'completed';

-- Archive completed task
PERFORM (
  WITH completed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = complete_task.run_id
      AND st.step_slug = complete_task.step_slug
      AND st.task_index = complete_task.task_index
      AND st.status = 'completed'
  )
  SELECT pgmq.archive(ct.flow_slug, ct.message_id)
  FROM completed_tasks ct
  WHERE EXISTS (SELECT 1 FROM completed_tasks)
);

PERFORM pgflow.start_ready_steps(complete_task.run_id);
PERFORM pgflow.maybe_complete_run(complete_task.run_id);

RETURN QUERY SELECT *
FROM pgflow.step_tasks AS step_task
WHERE step_task.run_id = complete_task.run_id
  AND step_task.step_slug = complete_task.step_slug
  AND step_task.task_index = complete_task.task_index;

END;
$$;


-- Update fail_task to handle 'started' status
CREATE OR REPLACE FUNCTION "pgflow"."fail_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "error_message" TEXT) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
BEGIN

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = fail_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  FOR UPDATE
),
flow_info AS (
  SELECT r.flow_slug
  FROM pgflow.runs r
  WHERE r.run_id = fail_task.run_id
),
config AS (
  SELECT
    COALESCE(s.opt_max_attempts, f.opt_max_attempts) AS opt_max_attempts,
    COALESCE(s.opt_base_delay, f.opt_base_delay) AS opt_base_delay
  FROM pgflow.steps s
  JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
  JOIN flow_info fi ON fi.flow_slug = s.flow_slug
  WHERE s.flow_slug = fi.flow_slug AND s.step_slug = fail_task.step_slug
),
fail_or_retry_task AS (
  UPDATE pgflow.step_tasks AS task
  SET
    status = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN 'queued'
      ELSE 'failed'
    END,
    failed_at = CASE
      WHEN task.attempts_count >= (SELECT opt_max_attempts FROM config) THEN now()
      ELSE NULL
    END,
    started_at = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN NULL
      ELSE task.started_at
    END,
    error_message = fail_task.error_message
  WHERE task.run_id = fail_task.run_id
    AND task.step_slug = fail_task.step_slug
    AND task.task_index = fail_task.task_index
    AND task.status = 'started'
  RETURNING *
),
maybe_fail_step AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
             WHEN (SELECT fail_or_retry_task.status FROM fail_or_retry_task) = 'failed' THEN 'failed'
             ELSE pgflow.step_states.status
             END,
    failed_at = CASE
                WHEN (SELECT fail_or_retry_task.status FROM fail_or_retry_task) = 'failed' THEN now()
                ELSE NULL
                END
  FROM fail_or_retry_task
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  RETURNING pgflow.step_states.*
)
UPDATE pgflow.runs
SET status = CASE
              WHEN (SELECT status FROM maybe_fail_step) = 'failed' THEN 'failed'
              ELSE status
              END,
    failed_at = CASE
                WHEN (SELECT status FROM maybe_fail_step) = 'failed' THEN now()
                ELSE NULL
                END
WHERE pgflow.runs.run_id = fail_task.run_id;

-- For queued tasks: delay the message for retry
PERFORM (
  WITH retry_config AS (
    SELECT
      COALESCE(s.opt_base_delay, f.opt_base_delay) AS base_delay
    FROM pgflow.steps s
    JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
    JOIN pgflow.runs r ON r.flow_slug = f.flow_slug
    WHERE r.run_id = fail_task.run_id
      AND s.step_slug = fail_task.step_slug
  ),
  queued_tasks AS (
    SELECT
      r.flow_slug,
      st.message_id,
      pgflow.calculate_retry_delay((SELECT base_delay FROM retry_config), st.attempts_count) AS calculated_delay
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'queued'
  )
  SELECT pgmq.set_vt(qt.flow_slug, qt.message_id, qt.calculated_delay)
  FROM queued_tasks qt
  WHERE EXISTS (SELECT 1 FROM queued_tasks)
);

-- For failed tasks: archive the message
PERFORM (
  WITH failed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'failed'
  )
  SELECT pgmq.archive(ft.flow_slug, ft.message_id)
  FROM failed_tasks ft
  WHERE EXISTS (SELECT 1 FROM failed_tasks)
);

RETURN QUERY SELECT *
FROM pgflow.step_tasks st
WHERE st.run_id = fail_task.run_id
  AND st.step_slug = fail_task.step_slug
  AND st.task_index = fail_task.task_index;

END;
$$;


-- Deprecate poll_for_tasks (replaced by two-phase polling)
CREATE OR REPLACE FUNCTION "pgflow"."poll_for_tasks" (
  "queue_name" TEXT,
  "vt" INTEGER,
  "qty" INTEGER,
  "max_poll_seconds" INTEGER DEFAULT 5,
  "poll_interval_ms" INTEGER DEFAULT 100
) RETURNS SETOF "pgflow"."step_task_record" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
BEGIN
  RAISE NOTICE 'DEPRECATED: poll_for_tasks is deprecated and will be removed. Please update pgflow via "npx pgflow install".';
  RETURN;
END;
$$;


-- Create "start_tasks" function (new two-phase polling approach)
CREATE OR REPLACE FUNCTION "pgflow"."start_tasks" ("flow_slug" TEXT, "msg_ids" BIGINT[], "worker_id" UUID) RETURNS SETOF "pgflow"."step_task_record" LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH tasks AS (
    SELECT
      task.flow_slug,
      task.run_id,
      task.step_slug,
      task.task_index,
      task.message_id
    FROM pgflow.step_tasks AS task
    WHERE task.flow_slug = start_tasks.flow_slug
      AND task.message_id = ANY(msg_ids)
      AND task.status = 'queued'
  ),
  start_tasks_update AS (
    UPDATE pgflow.step_tasks
    SET
      attempts_count = attempts_count + 1,
      status = 'started',
      started_at = now(),
      last_worker_id = worker_id
    FROM tasks
    WHERE step_tasks.message_id = tasks.message_id
      AND step_tasks.flow_slug = tasks.flow_slug
      AND step_tasks.status = 'queued'
  ),
  runs AS (
    SELECT
      r.run_id,
      r.input
    FROM pgflow.runs r
    WHERE r.run_id IN (SELECT run_id FROM tasks)
  ),
  deps AS (
    SELECT
      st.run_id,
      st.step_slug,
      dep.dep_slug,
      dep_task.output AS dep_output
    FROM tasks st
    JOIN pgflow.deps dep ON dep.flow_slug = st.flow_slug AND dep.step_slug = st.step_slug
    JOIN pgflow.step_tasks dep_task ON
      dep_task.run_id = st.run_id AND
      dep_task.step_slug = dep.dep_slug AND
      dep_task.status = 'completed'
  ),
  deps_outputs AS (
    SELECT
      d.run_id,
      d.step_slug,
      jsonb_object_agg(d.dep_slug, d.dep_output) AS deps_output
    FROM deps d
    GROUP BY d.run_id, d.step_slug
  ),
  timeouts AS (
    SELECT
      task.message_id,
      task.flow_slug,
      coalesce(step.opt_timeout, flow.opt_timeout) + 2 AS vt_delay
    FROM tasks task
    JOIN pgflow.flows flow ON flow.flow_slug = task.flow_slug
    JOIN pgflow.steps step ON step.flow_slug = task.flow_slug AND step.step_slug = task.step_slug
  )
  SELECT
    st.flow_slug,
    st.run_id,
    st.step_slug,
    jsonb_build_object('run', r.input) ||
    coalesce(dep_out.deps_output, '{}'::jsonb) AS input,
    st.message_id AS msg_id
  FROM tasks st
  JOIN runs r ON st.run_id = r.run_id
  LEFT JOIN deps_outputs dep_out ON
    dep_out.run_id = st.run_id AND
    dep_out.step_slug = st.step_slug
  CROSS JOIN LATERAL (
    SELECT pgmq.set_vt(t.flow_slug, st.message_id, t.vt_delay)
    FROM timeouts t
    WHERE t.message_id = st.message_id
      AND t.flow_slug = st.flow_slug
  ) set_vt
$$;


-- ============================================================================
-- PHASE 4-11: Additional pgflow v0.7.2 Enhancements
-- ============================================================================
--
-- The following phases complete the pgflow v0.7.2 schema with:
--   ✓ Phase 4: set_vt_batch optimization for batch message visibility timeout
--   ✓ Phase 5: Real-time event broadcasting (step/run lifecycle events)
--   ✓ Phase 6: Missing realtime event in fail_task (step:failed, run:failed)
--   ✓ Phase 7: Function search_path security fixes
--   ✓ Phase 8: opt_start_delay parameter for delayed step execution
--   ✓ Phase 9: Worker deprecation (stopped_at → deprecated_at column rename)
--   ✓ Phase 10: Map step type for parallel array processing
--   ✓ Phase 11: Broadcast ordering fixes and timestamp handling
--
-- Note: Phase 12 (pgmq 1.5.1+ upgrade) is not included as aza-pg may use
-- different pgmq version. Verify pgmq compatibility if issues arise.
--
-- ============================================================================
-- Create "set_vt_batch" function
CREATE FUNCTION "pgflow"."set_vt_batch" ("queue_name" TEXT, "msg_ids" BIGINT[], "vt_offsets" INTEGER[]) RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $$
DECLARE
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
    sql    TEXT;
BEGIN
    /* ---------- safety checks ---------------------------------------------------- */
    IF msg_ids IS NULL OR vt_offsets IS NULL OR array_length(msg_ids, 1) = 0 THEN
        RETURN;                    -- nothing to do, return empty set
    END IF;

    IF array_length(msg_ids, 1) IS DISTINCT FROM array_length(vt_offsets, 1) THEN
        RAISE EXCEPTION
          'msg_ids length (%) must equal vt_offsets length (%)',
          array_length(msg_ids, 1), array_length(vt_offsets, 1);
    END IF;

    /* ---------- dynamic statement ------------------------------------------------ */
    /* One UPDATE joins with the unnested arrays */
    sql := format(
        $FMT$
        WITH input (msg_id, vt_offset) AS (
            SELECT  unnest($1)::bigint
                 ,  unnest($2)::int
        )
        UPDATE pgmq.%I q
        SET    vt      = clock_timestamp() + make_interval(secs => input.vt_offset),
               read_ct = read_ct     -- no change, but keeps RETURNING list aligned
        FROM   input
        WHERE  q.msg_id = input.msg_id
        RETURNING q.msg_id,
                  q.read_ct,
                  q.enqueued_at,
                  q.vt,
                  q.message
        $FMT$,
        qtable
    );

    RETURN QUERY EXECUTE sql USING msg_ids, vt_offsets;
END;
$$;


-- Modify "start_tasks" function
CREATE OR REPLACE FUNCTION "pgflow"."start_tasks" ("flow_slug" TEXT, "msg_ids" BIGINT[], "worker_id" UUID) RETURNS SETOF "pgflow"."step_task_record" LANGUAGE sql
SET
  "search_path" = '' AS $$
with tasks as (
    select
      task.flow_slug,
      task.run_id,
      task.step_slug,
      task.task_index,
      task.message_id
    from pgflow.step_tasks as task
    where task.flow_slug = start_tasks.flow_slug
      and task.message_id = any(msg_ids)
      and task.status = 'queued'
  ),
  start_tasks_update as (
    update pgflow.step_tasks
    set 
      attempts_count = attempts_count + 1,
      status = 'started',
      started_at = now(),
      last_worker_id = worker_id
    from tasks
    where step_tasks.message_id = tasks.message_id
      and step_tasks.flow_slug = tasks.flow_slug
      and step_tasks.status = 'queued'
  ),
  runs as (
    select
      r.run_id,
      r.input
    from pgflow.runs r
    where r.run_id in (select run_id from tasks)
  ),
  deps as (
    select
      st.run_id,
      st.step_slug,
      dep.dep_slug,
      dep_task.output as dep_output
    from tasks st
    join pgflow.deps dep on dep.flow_slug = st.flow_slug and dep.step_slug = st.step_slug
    join pgflow.step_tasks dep_task on
      dep_task.run_id = st.run_id and
      dep_task.step_slug = dep.dep_slug and
      dep_task.status = 'completed'
  ),
  deps_outputs as (
    select
      d.run_id,
      d.step_slug,
      jsonb_object_agg(d.dep_slug, d.dep_output) as deps_output
    from deps d
    group by d.run_id, d.step_slug
  ),
  timeouts as (
    select
      task.message_id,
      task.flow_slug,
      coalesce(step.opt_timeout, flow.opt_timeout) + 2 as vt_delay
    from tasks task
    join pgflow.flows flow on flow.flow_slug = task.flow_slug
    join pgflow.steps step on step.flow_slug = task.flow_slug and step.step_slug = task.step_slug
  ),
  -- Batch update visibility timeouts for all messages
  set_vt_batch as (
    select pgflow.set_vt_batch(
      start_tasks.flow_slug,
      array_agg(t.message_id order by t.message_id),
      array_agg(t.vt_delay order by t.message_id)
    )
    from timeouts t
  )
  select
    st.flow_slug,
    st.run_id,
    st.step_slug,
    jsonb_build_object('run', r.input) ||
    coalesce(dep_out.deps_output, '{}'::jsonb) as input,
    st.message_id as msg_id
  from tasks st
  join runs r on st.run_id = r.run_id
  left join deps_outputs dep_out on
    dep_out.run_id = st.run_id and
    dep_out.step_slug = st.step_slug
$$;


-- Modify "step_states" table
ALTER TABLE "pgflow"."step_states"
ADD COLUMN "error_message" TEXT NULL;


-- Create index "idx_step_states_run_id" to table: "step_states"
CREATE INDEX "idx_step_states_run_id" ON "pgflow"."step_states" ("run_id");


-- Modify "maybe_complete_run" function
CREATE OR REPLACE FUNCTION "pgflow"."maybe_complete_run" ("run_id" UUID) RETURNS void LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_completed_run pgflow.runs%ROWTYPE;
begin
  -- Update run status to completed and set output when there are no remaining steps
  WITH run_output AS (
    -- Get outputs from final steps (steps that are not dependencies for other steps)
    SELECT jsonb_object_agg(st.step_slug, st.output) as final_output
    FROM pgflow.step_tasks st
    JOIN pgflow.step_states ss ON ss.run_id = st.run_id AND ss.step_slug = st.step_slug
    JOIN pgflow.runs r ON r.run_id = ss.run_id AND r.flow_slug = ss.flow_slug
    WHERE st.run_id = maybe_complete_run.run_id
      AND st.status = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM pgflow.deps d
        WHERE d.flow_slug = ss.flow_slug
          AND d.dep_slug = ss.step_slug
      )
  )
  UPDATE pgflow.runs
  SET
    status = 'completed',
    completed_at = now(),
    output = (SELECT final_output FROM run_output)
  WHERE pgflow.runs.run_id = maybe_complete_run.run_id
    AND pgflow.runs.remaining_steps = 0
    AND pgflow.runs.status != 'completed'
  RETURNING * INTO v_completed_run;

  -- Only send broadcast if run was completed
  IF v_completed_run.run_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'event_type', 'run:completed',
        'run_id', v_completed_run.run_id,
        'flow_slug', v_completed_run.flow_slug,
        'status', 'completed',
        'output', v_completed_run.output,
        'completed_at', v_completed_run.completed_at
      ),
      'run:completed',
      concat('pgflow:run:', v_completed_run.run_id),
      false
    );
  END IF;
end;
$$;


-- Modify "start_ready_steps" function
CREATE OR REPLACE FUNCTION "pgflow"."start_ready_steps" ("run_id" UUID) RETURNS void LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH ready_steps AS (
  SELECT *
  FROM pgflow.step_states AS step_state
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
  ORDER BY step_state.step_slug
  FOR UPDATE
),
started_step_states AS (
  UPDATE pgflow.step_states
  SET status = 'started',
      started_at = now()
  FROM ready_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = ready_steps.step_slug
  RETURNING pgflow.step_states.*
),
sent_messages AS (
  SELECT
    started_step.flow_slug,
    started_step.run_id,
    started_step.step_slug,
    pgmq.send(started_step.flow_slug, jsonb_build_object(
      'flow_slug', started_step.flow_slug,
      'run_id', started_step.run_id,
      'step_slug', started_step.step_slug,
      'task_index', 0
    )) AS msg_id
  FROM started_step_states AS started_step
),
broadcast_events AS (
  SELECT 
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:started',
        'run_id', started_step.run_id,
        'step_slug', started_step.step_slug,
        'status', 'started',
        'started_at', started_step.started_at,
        'remaining_tasks', 1,
        'remaining_deps', started_step.remaining_deps
      ),
      concat('step:', started_step.step_slug, ':started'),
      concat('pgflow:run:', started_step.run_id),
      false
    )
  FROM started_step_states AS started_step
)
INSERT INTO pgflow.step_tasks (flow_slug, run_id, step_slug, message_id)
SELECT
  sent_messages.flow_slug,
  sent_messages.run_id,
  sent_messages.step_slug,
  sent_messages.msg_id
FROM sent_messages;
$$;


-- Modify "complete_task" function
CREATE OR REPLACE FUNCTION "pgflow"."complete_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "output" JSONB) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_step_state pgflow.step_states%ROWTYPE;
begin

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = complete_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  FOR UPDATE
),
task AS (
  UPDATE pgflow.step_tasks
  SET
    status = 'completed',
    completed_at = now(),
    output = complete_task.output
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index
    AND pgflow.step_tasks.status = 'started'
  RETURNING *
),
step_state AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN 'completed'  -- Will be 0 after decrement
    ELSE 'started'
    END,
    completed_at = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN now()  -- Will be 0 after decrement
    ELSE NULL
    END,
    remaining_tasks = pgflow.step_states.remaining_tasks - 1
  FROM task
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  RETURNING pgflow.step_states.*
),
-- Find all dependent steps if the current step was completed
dependent_steps AS (
  SELECT d.step_slug AS dependent_step_slug
  FROM pgflow.deps d
  JOIN step_state s ON s.status = 'completed' AND d.flow_slug = s.flow_slug
  WHERE d.dep_slug = complete_task.step_slug
  ORDER BY d.step_slug  -- Ensure consistent ordering
),
-- Lock dependent steps before updating
dependent_steps_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug IN (SELECT dependent_step_slug FROM dependent_steps)
  FOR UPDATE
),
-- Update all dependent steps
dependent_steps_update AS (
  UPDATE pgflow.step_states
  SET remaining_deps = pgflow.step_states.remaining_deps - 1
  FROM dependent_steps
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = dependent_steps.dependent_step_slug
)
-- Only decrement remaining_steps, don't update status
UPDATE pgflow.runs
SET remaining_steps = pgflow.runs.remaining_steps - 1
FROM step_state
WHERE pgflow.runs.run_id = complete_task.run_id
  AND step_state.status = 'completed';

-- Get the updated step state for broadcasting
SELECT * INTO v_step_state FROM pgflow.step_states
WHERE pgflow.step_states.run_id = complete_task.run_id AND pgflow.step_states.step_slug = complete_task.step_slug;

-- Send broadcast event for step completed if the step is completed
IF v_step_state.status = 'completed' THEN
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'step:completed',
      'run_id', complete_task.run_id,
      'step_slug', complete_task.step_slug,
      'status', 'completed',
      'output', complete_task.output,
      'completed_at', v_step_state.completed_at
    ),
    concat('step:', complete_task.step_slug, ':completed'),
    concat('pgflow:run:', complete_task.run_id),
    false
  );
END IF;

-- For completed tasks: archive the message
PERFORM (
  WITH completed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = complete_task.run_id
      AND st.step_slug = complete_task.step_slug
      AND st.task_index = complete_task.task_index
      AND st.status = 'completed'
  )
  SELECT pgmq.archive(ct.flow_slug, ct.message_id)
  FROM completed_tasks ct
  WHERE EXISTS (SELECT 1 FROM completed_tasks)
);

PERFORM pgflow.start_ready_steps(complete_task.run_id);

PERFORM pgflow.maybe_complete_run(complete_task.run_id);

RETURN QUERY SELECT *
FROM pgflow.step_tasks AS step_task
WHERE step_task.run_id = complete_task.run_id
  AND step_task.step_slug = complete_task.step_slug
  AND step_task.task_index = complete_task.task_index;

end;
$$;


-- Modify "fail_task" function
CREATE OR REPLACE FUNCTION "pgflow"."fail_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "error_message" TEXT) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
DECLARE
  v_run_failed boolean;
begin

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = fail_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  FOR UPDATE
),
flow_info AS (
  SELECT r.flow_slug
  FROM pgflow.runs r
  WHERE r.run_id = fail_task.run_id
),
config AS (
  SELECT
    COALESCE(s.opt_max_attempts, f.opt_max_attempts) AS opt_max_attempts,
    COALESCE(s.opt_base_delay, f.opt_base_delay) AS opt_base_delay
  FROM pgflow.steps s
  JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
  JOIN flow_info fi ON fi.flow_slug = s.flow_slug
  WHERE s.flow_slug = fi.flow_slug AND s.step_slug = fail_task.step_slug
),
fail_or_retry_task as (
  UPDATE pgflow.step_tasks as task
  SET
    status = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN 'queued'
      ELSE 'failed'
    END,
    failed_at = CASE
      WHEN task.attempts_count >= (SELECT opt_max_attempts FROM config) THEN now()
      ELSE NULL
    END,
    started_at = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN NULL
      ELSE task.started_at
    END,
    error_message = fail_task.error_message
  WHERE task.run_id = fail_task.run_id
    AND task.step_slug = fail_task.step_slug
    AND task.task_index = fail_task.task_index
    AND task.status = 'started'
  RETURNING *
),
maybe_fail_step AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
             WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN 'failed'
             ELSE pgflow.step_states.status
             END,
    failed_at = CASE
                WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN now()
                ELSE NULL
                END,
    error_message = CASE
                    WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN fail_task.error_message
                    ELSE NULL
                    END
  FROM fail_or_retry_task
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  RETURNING pgflow.step_states.*
),
-- Send broadcast event for step failed if necessary
broadcast_step_failed AS (
  SELECT
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:failed',
        'run_id', fail_task.run_id,
        'step_slug', fail_task.step_slug,
        'status', 'failed',
        'error_message', fail_task.error_message,
        'failed_at', now()
      ),
      concat('step:', fail_task.step_slug, ':failed'),
      concat('pgflow:run:', fail_task.run_id),
      false
    )
  FROM maybe_fail_step
  WHERE maybe_fail_step.status = 'failed'
)
-- Only decrement remaining_steps, don't update status
UPDATE pgflow.runs
SET status = CASE
              WHEN (select status from maybe_fail_step) = 'failed' THEN 'failed'
              ELSE status
              END,
    failed_at = CASE
                WHEN (select status from maybe_fail_step) = 'failed' THEN now()
                ELSE NULL
                END
WHERE pgflow.runs.run_id = fail_task.run_id
RETURNING (status = 'failed') INTO v_run_failed;

-- Send broadcast event for run failure if the run was failed
IF v_run_failed THEN
  DECLARE
    v_flow_slug text;
  BEGIN
    SELECT flow_slug INTO v_flow_slug FROM pgflow.runs WHERE pgflow.runs.run_id = fail_task.run_id;

    PERFORM realtime.send(
      jsonb_build_object(
        'event_type', 'run:failed',
        'run_id', fail_task.run_id,
        'flow_slug', v_flow_slug,
        'status', 'failed',
        'error_message', fail_task.error_message,
        'failed_at', now()
      ),
      'run:failed',
      concat('pgflow:run:', fail_task.run_id),
      false
    );
  END;
END IF;

-- For queued tasks: delay the message for retry with exponential backoff
PERFORM (
  WITH retry_config AS (
    SELECT
      COALESCE(s.opt_base_delay, f.opt_base_delay) AS base_delay
    FROM pgflow.steps s
    JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
    JOIN pgflow.runs r ON r.flow_slug = f.flow_slug
    WHERE r.run_id = fail_task.run_id
      AND s.step_slug = fail_task.step_slug
  ),
  queued_tasks AS (
    SELECT
      r.flow_slug,
      st.message_id,
      pgflow.calculate_retry_delay((SELECT base_delay FROM retry_config), st.attempts_count) AS calculated_delay
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'queued'
  )
  SELECT pgmq.set_vt(qt.flow_slug, qt.message_id, qt.calculated_delay)
  FROM queued_tasks qt
  WHERE EXISTS (SELECT 1 FROM queued_tasks)
);

-- For failed tasks: archive the message
PERFORM (
  WITH failed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'failed'
  )
  SELECT pgmq.archive(ft.flow_slug, ft.message_id)
  FROM failed_tasks ft
  WHERE EXISTS (SELECT 1 FROM failed_tasks)
);

return query select *
from pgflow.step_tasks st
where st.run_id = fail_task.run_id
  and st.step_slug = fail_task.step_slug
  and st.task_index = fail_task.task_index;

end;
$$;


-- Create "get_run_with_states" function
CREATE FUNCTION "pgflow"."get_run_with_states" ("run_id" UUID) RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$
SELECT jsonb_build_object(
    'run', to_jsonb(r),
    'steps', COALESCE(jsonb_agg(to_jsonb(s)) FILTER (WHERE s.run_id IS NOT NULL), '[]'::jsonb)
  )
  FROM pgflow.runs r
  LEFT JOIN pgflow.step_states s ON s.run_id = r.run_id
  WHERE r.run_id = get_run_with_states.run_id
  GROUP BY r.run_id;
$$;


-- Create "start_flow" function
CREATE FUNCTION "pgflow"."start_flow" ("flow_slug" TEXT, "input" JSONB, "run_id" UUID DEFAULT NULL::UUID) RETURNS SETOF "pgflow"."runs" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_created_run pgflow.runs%ROWTYPE;
begin

WITH
  flow_steps AS (
    SELECT steps.flow_slug, steps.step_slug, steps.deps_count
    FROM pgflow.steps
    WHERE steps.flow_slug = start_flow.flow_slug
  ),
  created_run AS (
    INSERT INTO pgflow.runs (run_id, flow_slug, input, remaining_steps)
    VALUES (
      COALESCE(start_flow.run_id, gen_random_uuid()),
      start_flow.flow_slug,
      start_flow.input,
      (SELECT count(*) FROM flow_steps)
    )
    RETURNING *
  ),
  created_step_states AS (
    INSERT INTO pgflow.step_states (flow_slug, run_id, step_slug, remaining_deps)
    SELECT
      fs.flow_slug,
      (SELECT created_run.run_id FROM created_run),
      fs.step_slug,
      fs.deps_count
    FROM flow_steps fs
  )
SELECT * FROM created_run INTO v_created_run;

-- Send broadcast event for run started
PERFORM realtime.send(
  jsonb_build_object(
    'event_type', 'run:started',
    'run_id', v_created_run.run_id,
    'flow_slug', v_created_run.flow_slug,
    'input', v_created_run.input,
    'status', 'started',
    'remaining_steps', v_created_run.remaining_steps,
    'started_at', v_created_run.started_at
  ),
  'run:started',
  concat('pgflow:run:', v_created_run.run_id),
  false
);

PERFORM pgflow.start_ready_steps(v_created_run.run_id);

RETURN QUERY SELECT * FROM pgflow.runs where pgflow.runs.run_id = v_created_run.run_id;

end;
$$;


-- Create "start_flow_with_states" function
CREATE FUNCTION "pgflow"."start_flow_with_states" ("flow_slug" TEXT, "input" JSONB, "run_id" UUID DEFAULT NULL::UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_run_id UUID;
BEGIN
  -- Start the flow using existing function
  SELECT r.run_id INTO v_run_id FROM pgflow.start_flow(
    start_flow_with_states.flow_slug,
    start_flow_with_states.input,
    start_flow_with_states.run_id
  ) AS r LIMIT 1;

  -- Use get_run_with_states to return the complete state
  RETURN pgflow.get_run_with_states(v_run_id);
END;
$$;


-- Drop "start_flow" function
DROP FUNCTION "pgflow"."start_flow" (TEXT, JSONB);


-- Modify "fail_task" function
CREATE OR REPLACE FUNCTION "pgflow"."fail_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "error_message" TEXT) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
DECLARE
  v_run_failed boolean;
  v_step_failed boolean;
begin

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = fail_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  FOR UPDATE
),
flow_info AS (
  SELECT r.flow_slug
  FROM pgflow.runs r
  WHERE r.run_id = fail_task.run_id
),
config AS (
  SELECT
    COALESCE(s.opt_max_attempts, f.opt_max_attempts) AS opt_max_attempts,
    COALESCE(s.opt_base_delay, f.opt_base_delay) AS opt_base_delay
  FROM pgflow.steps s
  JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
  JOIN flow_info fi ON fi.flow_slug = s.flow_slug
  WHERE s.flow_slug = fi.flow_slug AND s.step_slug = fail_task.step_slug
),
fail_or_retry_task as (
  UPDATE pgflow.step_tasks as task
  SET
    status = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN 'queued'
      ELSE 'failed'
    END,
    failed_at = CASE
      WHEN task.attempts_count >= (SELECT opt_max_attempts FROM config) THEN now()
      ELSE NULL
    END,
    started_at = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN NULL
      ELSE task.started_at
    END,
    error_message = fail_task.error_message
  WHERE task.run_id = fail_task.run_id
    AND task.step_slug = fail_task.step_slug
    AND task.task_index = fail_task.task_index
    AND task.status = 'started'
  RETURNING *
),
maybe_fail_step AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
             WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN 'failed'
             ELSE pgflow.step_states.status
             END,
    failed_at = CASE
                WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN now()
                ELSE NULL
                END,
    error_message = CASE
                    WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN fail_task.error_message
                    ELSE NULL
                    END
  FROM fail_or_retry_task
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  RETURNING pgflow.step_states.*
)
-- Update run status
UPDATE pgflow.runs
SET status = CASE
              WHEN (select status from maybe_fail_step) = 'failed' THEN 'failed'
              ELSE status
              END,
    failed_at = CASE
                WHEN (select status from maybe_fail_step) = 'failed' THEN now()
                ELSE NULL
                END
WHERE pgflow.runs.run_id = fail_task.run_id
RETURNING (status = 'failed') INTO v_run_failed;

-- Check if step failed by querying the step_states table
SELECT (status = 'failed') INTO v_step_failed 
FROM pgflow.step_states 
WHERE pgflow.step_states.run_id = fail_task.run_id 
  AND pgflow.step_states.step_slug = fail_task.step_slug;

-- Send broadcast event for step failure if the step was failed
IF v_step_failed THEN
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'step:failed',
      'run_id', fail_task.run_id,
      'step_slug', fail_task.step_slug,
      'status', 'failed',
      'error_message', fail_task.error_message,
      'failed_at', now()
    ),
    concat('step:', fail_task.step_slug, ':failed'),
    concat('pgflow:run:', fail_task.run_id),
    false
  );
END IF;

-- Send broadcast event for run failure if the run was failed
IF v_run_failed THEN
  DECLARE
    v_flow_slug text;
  BEGIN
    SELECT flow_slug INTO v_flow_slug FROM pgflow.runs WHERE pgflow.runs.run_id = fail_task.run_id;

    PERFORM realtime.send(
      jsonb_build_object(
        'event_type', 'run:failed',
        'run_id', fail_task.run_id,
        'flow_slug', v_flow_slug,
        'status', 'failed',
        'error_message', fail_task.error_message,
        'failed_at', now()
      ),
      'run:failed',
      concat('pgflow:run:', fail_task.run_id),
      false
    );
  END;
END IF;

-- For queued tasks: delay the message for retry with exponential backoff
PERFORM (
  WITH retry_config AS (
    SELECT
      COALESCE(s.opt_base_delay, f.opt_base_delay) AS base_delay
    FROM pgflow.steps s
    JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
    JOIN pgflow.runs r ON r.flow_slug = f.flow_slug
    WHERE r.run_id = fail_task.run_id
      AND s.step_slug = fail_task.step_slug
  ),
  queued_tasks AS (
    SELECT
      r.flow_slug,
      st.message_id,
      pgflow.calculate_retry_delay((SELECT base_delay FROM retry_config), st.attempts_count) AS calculated_delay
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'queued'
  )
  SELECT pgmq.set_vt(qt.flow_slug, qt.message_id, qt.calculated_delay)
  FROM queued_tasks qt
  WHERE EXISTS (SELECT 1 FROM queued_tasks)
);

-- For failed tasks: archive the message
PERFORM (
  WITH failed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'failed'
  )
  SELECT pgmq.archive(ft.flow_slug, ft.message_id)
  FROM failed_tasks ft
  WHERE EXISTS (SELECT 1 FROM failed_tasks)
);

return query select *
from pgflow.step_tasks st
where st.run_id = fail_task.run_id
  and st.step_slug = fail_task.step_slug
  and st.task_index = fail_task.task_index;

end;
$$;


-- Add "calculate_retry_delay" function configuration parameter
ALTER FUNCTION "pgflow"."calculate_retry_delay"
SET
  "search_path" = '';


-- Add "is_valid_slug" function configuration parameter
ALTER FUNCTION "pgflow"."is_valid_slug"
SET
  "search_path" = '';


-- Add "read_with_poll" function configuration parameter
ALTER FUNCTION "pgflow"."read_with_poll"
SET
  "search_path" = '';


-- Modify "steps" table
ALTER TABLE "pgflow"."steps"
ADD CONSTRAINT "opt_start_delay_is_nonnegative" CHECK (
  (opt_start_delay IS NULL)
  OR (opt_start_delay >= 0)
),
ADD COLUMN "opt_start_delay" INTEGER NULL;


-- Modify "start_ready_steps" function
CREATE OR REPLACE FUNCTION "pgflow"."start_ready_steps" ("run_id" UUID) RETURNS void LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH ready_steps AS (
  SELECT *
  FROM pgflow.step_states AS step_state
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
  ORDER BY step_state.step_slug
  FOR UPDATE
),
started_step_states AS (
  UPDATE pgflow.step_states
  SET status = 'started',
      started_at = now()
  FROM ready_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = ready_steps.step_slug
  RETURNING pgflow.step_states.*
),
sent_messages AS (
  SELECT
    started_step.flow_slug,
    started_step.run_id,
    started_step.step_slug,
    pgmq.send(
      started_step.flow_slug, 
      jsonb_build_object(
        'flow_slug', started_step.flow_slug,
        'run_id', started_step.run_id,
        'step_slug', started_step.step_slug,
        'task_index', 0
      ),
      COALESCE(step.opt_start_delay, 0)
    ) AS msg_id
  FROM started_step_states AS started_step
  JOIN pgflow.steps AS step 
    ON step.flow_slug = started_step.flow_slug 
    AND step.step_slug = started_step.step_slug
),
broadcast_events AS (
  SELECT 
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:started',
        'run_id', started_step.run_id,
        'step_slug', started_step.step_slug,
        'status', 'started',
        'started_at', started_step.started_at,
        'remaining_tasks', 1,
        'remaining_deps', started_step.remaining_deps
      ),
      concat('step:', started_step.step_slug, ':started'),
      concat('pgflow:run:', started_step.run_id),
      false
    )
  FROM started_step_states AS started_step
)
INSERT INTO pgflow.step_tasks (flow_slug, run_id, step_slug, message_id)
SELECT
  sent_messages.flow_slug,
  sent_messages.run_id,
  sent_messages.step_slug,
  sent_messages.msg_id
FROM sent_messages;
$$;


-- Create "add_step" function
CREATE FUNCTION "pgflow"."add_step" (
  "flow_slug" TEXT,
  "step_slug" TEXT,
  "deps_slugs" TEXT[],
  "max_attempts" INTEGER DEFAULT NULL::INTEGER,
  "base_delay" INTEGER DEFAULT NULL::INTEGER,
  "timeout" INTEGER DEFAULT NULL::INTEGER,
  "start_delay" INTEGER DEFAULT NULL::INTEGER
) RETURNS "pgflow"."steps" LANGUAGE sql
SET
  "search_path" = '' AS $$
WITH
  next_index AS (
    SELECT COALESCE(MAX(step_index) + 1, 0) as idx
    FROM pgflow.steps
    WHERE flow_slug = add_step.flow_slug
  ),
  create_step AS (
    INSERT INTO pgflow.steps (flow_slug, step_slug, step_index, deps_count, opt_max_attempts, opt_base_delay, opt_timeout, opt_start_delay)
    SELECT add_step.flow_slug, add_step.step_slug, idx, COALESCE(array_length(deps_slugs, 1), 0), max_attempts, base_delay, timeout, start_delay
    FROM next_index
    ON CONFLICT (flow_slug, step_slug)
    DO UPDATE SET step_slug = pgflow.steps.step_slug
    RETURNING *
  ),
  insert_deps AS (
    INSERT INTO pgflow.deps (flow_slug, dep_slug, step_slug)
    SELECT add_step.flow_slug, d.dep_slug, add_step.step_slug
    FROM unnest(deps_slugs) AS d(dep_slug)
    ON CONFLICT (flow_slug, dep_slug, step_slug) DO NOTHING
    RETURNING 1
  )
-- Return the created step
SELECT * FROM create_step;
$$;


-- Drop "add_step" function
DROP FUNCTION "pgflow"."add_step" (TEXT, TEXT, INTEGER, INTEGER, INTEGER);


-- Drop "add_step" function
DROP FUNCTION "pgflow"."add_step" (TEXT, TEXT, TEXT[], INTEGER, INTEGER, INTEGER);


-- Create "add_step" function
CREATE FUNCTION "pgflow"."add_step" (
  "flow_slug" TEXT,
  "step_slug" TEXT,
  "max_attempts" INTEGER DEFAULT NULL::INTEGER,
  "base_delay" INTEGER DEFAULT NULL::INTEGER,
  "timeout" INTEGER DEFAULT NULL::INTEGER,
  "start_delay" INTEGER DEFAULT NULL::INTEGER
) RETURNS "pgflow"."steps" LANGUAGE sql
SET
  "search_path" = '' AS $$
-- Call the original function with an empty array
    SELECT * FROM pgflow.add_step(flow_slug, step_slug, ARRAY[]::text[], max_attempts, base_delay, timeout, start_delay);
$$;


-- Rename a column from "stopped_at" to "deprecated_at"
ALTER TABLE "pgflow"."workers"
RENAME COLUMN "stopped_at" TO "deprecated_at";


-- Modify "step_task_record" composite type
ALTER TYPE "pgflow"."step_task_record"
ADD ATTRIBUTE "task_index" INTEGER;


-- Modify "step_states" table - Step 1: Drop old constraint and NOT NULL
ALTER TABLE "pgflow"."step_states"
DROP CONSTRAINT "step_states_remaining_tasks_check",
ALTER COLUMN "remaining_tasks"
DROP NOT NULL,
ALTER COLUMN "remaining_tasks"
DROP DEFAULT,
ADD COLUMN "initial_tasks" INTEGER NULL;


-- AUTOMATIC DATA MIGRATION: Prepare existing data for new constraints
-- This runs AFTER dropping NOT NULL but BEFORE adding new constraints
-- All old steps had exactly 1 task (enforced by old only_single_task_per_step constraint)
-- Backfill initial_tasks = 1 for all existing steps
-- (Old schema enforced exactly 1 task per step, so all steps had initial_tasks=1)
UPDATE "pgflow"."step_states"
SET
  "initial_tasks" = 1
WHERE
  "initial_tasks" IS NULL;


-- Set remaining_tasks to NULL for 'created' status
-- (New semantics: NULL = not started, old semantics: 1 = not started)
UPDATE "pgflow"."step_states"
SET
  "remaining_tasks" = NULL
WHERE
  "status" = 'created'
  AND "remaining_tasks" IS NOT NULL;


-- Modify "step_states" table - Step 2: Add new constraints
ALTER TABLE "pgflow"."step_states"
ADD CONSTRAINT "initial_tasks_known_when_started" CHECK (
  (status <> 'started'::TEXT)
  OR (initial_tasks IS NOT NULL)
),
ADD CONSTRAINT "remaining_tasks_state_consistency" CHECK (
  (remaining_tasks IS NULL)
  OR (status <> 'created'::TEXT)
),
ADD CONSTRAINT "step_states_initial_tasks_check" CHECK (
  (initial_tasks IS NULL)
  OR (initial_tasks >= 0)
);


-- Modify "step_tasks" table
ALTER TABLE "pgflow"."step_tasks"
DROP CONSTRAINT "only_single_task_per_step",
DROP CONSTRAINT "output_valid_only_for_completed",
ADD CONSTRAINT "output_valid_only_for_completed" CHECK (
  (output IS NULL)
  OR (status = ANY (ARRAY['completed'::TEXT, 'failed'::TEXT]))
);


-- Modify "steps" table
ALTER TABLE "pgflow"."steps"
DROP CONSTRAINT "steps_step_type_check",
ADD CONSTRAINT "steps_step_type_check" CHECK (step_type = ANY (ARRAY['single'::TEXT, 'map'::TEXT]));


-- Modify "maybe_complete_run" function
CREATE OR REPLACE FUNCTION "pgflow"."maybe_complete_run" ("run_id" UUID) RETURNS void LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_completed_run pgflow.runs%ROWTYPE;
begin
  -- ==========================================
  -- CHECK AND COMPLETE RUN IF FINISHED
  -- ==========================================
  -- ---------- Complete run if all steps done ----------
  UPDATE pgflow.runs
  SET
    status = 'completed',
    completed_at = now(),
    -- Only compute expensive aggregation when actually completing the run
    output = (
      -- ---------- Gather outputs from leaf steps ----------
      -- Leaf steps = steps with no dependents
      -- For map steps: aggregate all task outputs into array
      -- For single steps: use the single task output
      SELECT jsonb_object_agg(
        step_slug,
        CASE
          WHEN step_type = 'map' THEN aggregated_output
          ELSE single_output
        END
      )
      FROM (
        SELECT DISTINCT
          leaf_state.step_slug,
          leaf_step.step_type,
          -- For map steps: aggregate all task outputs
          CASE WHEN leaf_step.step_type = 'map' THEN
            (SELECT COALESCE(jsonb_agg(leaf_task.output ORDER BY leaf_task.task_index), '[]'::jsonb)
             FROM pgflow.step_tasks leaf_task
             WHERE leaf_task.run_id = leaf_state.run_id
               AND leaf_task.step_slug = leaf_state.step_slug
               AND leaf_task.status = 'completed')
          END as aggregated_output,
          -- For single steps: get the single output
          CASE WHEN leaf_step.step_type = 'single' THEN
            (SELECT leaf_task.output
             FROM pgflow.step_tasks leaf_task
             WHERE leaf_task.run_id = leaf_state.run_id
               AND leaf_task.step_slug = leaf_state.step_slug
               AND leaf_task.status = 'completed'
             LIMIT 1)
          END as single_output
        FROM pgflow.step_states leaf_state
        JOIN pgflow.steps leaf_step ON leaf_step.flow_slug = leaf_state.flow_slug AND leaf_step.step_slug = leaf_state.step_slug
        WHERE leaf_state.run_id = maybe_complete_run.run_id
          AND leaf_state.status = 'completed'
          AND NOT EXISTS (
            SELECT 1
            FROM pgflow.deps dep
            WHERE dep.flow_slug = leaf_state.flow_slug
              AND dep.dep_slug = leaf_state.step_slug
          )
      ) leaf_outputs
    )
  WHERE pgflow.runs.run_id = maybe_complete_run.run_id
    AND pgflow.runs.remaining_steps = 0
    AND pgflow.runs.status != 'completed'
  RETURNING * INTO v_completed_run;

  -- ==========================================
  -- BROADCAST COMPLETION EVENT
  -- ==========================================
  IF v_completed_run.run_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'event_type', 'run:completed',
        'run_id', v_completed_run.run_id,
        'flow_slug', v_completed_run.flow_slug,
        'status', 'completed',
        'output', v_completed_run.output,
        'completed_at', v_completed_run.completed_at
      ),
      'run:completed',
      concat('pgflow:run:', v_completed_run.run_id),
      false
    );
  END IF;
end;
$$;


-- Modify "start_ready_steps" function
CREATE OR REPLACE FUNCTION "pgflow"."start_ready_steps" ("run_id" UUID) RETURNS void LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
begin
-- ==========================================
-- GUARD: No mutations on failed runs
-- ==========================================
IF EXISTS (SELECT 1 FROM pgflow.runs WHERE pgflow.runs.run_id = start_ready_steps.run_id AND pgflow.runs.status = 'failed') THEN
  RETURN;
END IF;

-- ==========================================
-- HANDLE EMPTY ARRAY MAPS (initial_tasks = 0)
-- ==========================================
-- These complete immediately without spawning tasks
WITH empty_map_steps AS (
  SELECT step_state.*
  FROM pgflow.step_states AS step_state
  JOIN pgflow.steps AS step 
    ON step.flow_slug = step_state.flow_slug 
    AND step.step_slug = step_state.step_slug
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
    AND step.step_type = 'map'
    AND step_state.initial_tasks = 0
  ORDER BY step_state.step_slug
  FOR UPDATE OF step_state
),
-- ---------- Complete empty map steps ----------
completed_empty_steps AS (
  UPDATE pgflow.step_states
  SET status = 'completed',
      started_at = now(),
      completed_at = now(),
      remaining_tasks = 0
  FROM empty_map_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = empty_map_steps.step_slug
  RETURNING pgflow.step_states.*
),
-- ---------- Broadcast completion events ----------
broadcast_empty_completed AS (
  SELECT 
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:completed',
        'run_id', completed_step.run_id,
        'step_slug', completed_step.step_slug,
        'status', 'completed',
        'started_at', completed_step.started_at,
        'completed_at', completed_step.completed_at,
        'remaining_tasks', 0,
        'remaining_deps', 0,
        'output', '[]'::jsonb
      ),
      concat('step:', completed_step.step_slug, ':completed'),
      concat('pgflow:run:', completed_step.run_id),
      false
    )
  FROM completed_empty_steps AS completed_step
),

-- ==========================================
-- HANDLE NORMAL STEPS (initial_tasks > 0)
-- ==========================================
-- ---------- Find ready steps ----------
-- Steps with no remaining deps and known task count
ready_steps AS (
  SELECT *
  FROM pgflow.step_states AS step_state
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
    AND step_state.initial_tasks IS NOT NULL  -- NEW: Cannot start with unknown count
    AND step_state.initial_tasks > 0  -- Don't start taskless steps
    -- Exclude empty map steps already handled
    AND NOT EXISTS (
      SELECT 1 FROM empty_map_steps
      WHERE empty_map_steps.run_id = step_state.run_id
        AND empty_map_steps.step_slug = step_state.step_slug
    )
  ORDER BY step_state.step_slug
  FOR UPDATE
),
-- ---------- Mark steps as started ----------
started_step_states AS (
  UPDATE pgflow.step_states
  SET status = 'started',
      started_at = now(),
      remaining_tasks = ready_steps.initial_tasks  -- Copy initial_tasks to remaining_tasks when starting
  FROM ready_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = ready_steps.step_slug
  RETURNING pgflow.step_states.*
),

-- ==========================================
-- TASK GENERATION AND QUEUE MESSAGES
-- ==========================================
-- ---------- Generate tasks and batch messages ----------
-- Single steps: 1 task (index 0)
-- Map steps: N tasks (indices 0..N-1)
message_batches AS (
  SELECT
    started_step.flow_slug,
    started_step.run_id,
    started_step.step_slug,
    COALESCE(step.opt_start_delay, 0) as delay,
    array_agg(
      jsonb_build_object(
        'flow_slug', started_step.flow_slug,
        'run_id', started_step.run_id,
        'step_slug', started_step.step_slug,
        'task_index', task_idx.task_index
      ) ORDER BY task_idx.task_index
    ) AS messages,
    array_agg(task_idx.task_index ORDER BY task_idx.task_index) AS task_indices
  FROM started_step_states AS started_step
  JOIN pgflow.steps AS step 
    ON step.flow_slug = started_step.flow_slug 
    AND step.step_slug = started_step.step_slug
  -- Generate task indices from 0 to initial_tasks-1
  CROSS JOIN LATERAL generate_series(0, started_step.initial_tasks - 1) AS task_idx(task_index)
  GROUP BY started_step.flow_slug, started_step.run_id, started_step.step_slug, step.opt_start_delay
),
-- ---------- Send messages to queue ----------
-- Uses batch sending for performance with large arrays
sent_messages AS (
  SELECT
    mb.flow_slug,
    mb.run_id,
    mb.step_slug,
    task_indices.task_index,
    msg_ids.msg_id
  FROM message_batches mb
  CROSS JOIN LATERAL unnest(mb.task_indices) WITH ORDINALITY AS task_indices(task_index, idx_ord)
  CROSS JOIN LATERAL pgmq.send_batch(mb.flow_slug, mb.messages, mb.delay) WITH ORDINALITY AS msg_ids(msg_id, msg_ord)
  WHERE task_indices.idx_ord = msg_ids.msg_ord
),

-- ---------- Broadcast step:started events ----------
broadcast_events AS (
  SELECT 
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:started',
        'run_id', started_step.run_id,
        'step_slug', started_step.step_slug,
        'status', 'started',
        'started_at', started_step.started_at,
        'remaining_tasks', started_step.remaining_tasks,
        'remaining_deps', started_step.remaining_deps
      ),
      concat('step:', started_step.step_slug, ':started'),
      concat('pgflow:run:', started_step.run_id),
      false
    )
  FROM started_step_states AS started_step
)

-- ==========================================
-- RECORD TASKS IN DATABASE
-- ==========================================
INSERT INTO pgflow.step_tasks (flow_slug, run_id, step_slug, task_index, message_id)
SELECT
  sent_messages.flow_slug,
  sent_messages.run_id,
  sent_messages.step_slug,
  sent_messages.task_index,
  sent_messages.msg_id
FROM sent_messages;

end;
$$;


-- Create "cascade_complete_taskless_steps" function
CREATE FUNCTION "pgflow"."cascade_complete_taskless_steps" ("run_id" UUID) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_total_completed int := 0;
  v_iteration_completed int;
  v_iterations int := 0;
  v_max_iterations int := 50;
BEGIN
  -- ==========================================
  -- ITERATIVE CASCADE COMPLETION
  -- ==========================================
  -- Completes taskless steps in waves until none remain
  LOOP
    -- ---------- Safety check ----------
    v_iterations := v_iterations + 1;
    IF v_iterations > v_max_iterations THEN
      RAISE EXCEPTION 'Cascade loop exceeded safety limit of % iterations', v_max_iterations;
    END IF;

    -- ==========================================
    -- COMPLETE READY TASKLESS STEPS
    -- ==========================================
    WITH completed AS (
      -- ---------- Complete taskless steps ----------
      -- Steps with initial_tasks=0 and no remaining deps
      UPDATE pgflow.step_states ss
      SET status = 'completed',
          started_at = now(),
          completed_at = now(),
          remaining_tasks = 0
      FROM pgflow.steps s
      WHERE ss.run_id = cascade_complete_taskless_steps.run_id
        AND ss.flow_slug = s.flow_slug
        AND ss.step_slug = s.step_slug
        AND ss.status = 'created'
        AND ss.remaining_deps = 0
        AND ss.initial_tasks = 0
      -- Process in topological order to ensure proper cascade
      RETURNING ss.*
    ),
    -- ---------- Update dependent steps ----------
    -- Propagate completion and empty arrays to dependents
    dep_updates AS (
      UPDATE pgflow.step_states ss
      SET remaining_deps = ss.remaining_deps - dep_count.count,
          -- If the dependent is a map step and its dependency completed with 0 tasks,
          -- set its initial_tasks to 0 as well
          initial_tasks = CASE
            WHEN s.step_type = 'map' AND dep_count.has_zero_tasks
            THEN 0  -- Empty array propagation
            ELSE ss.initial_tasks  -- Keep existing value (including NULL)
          END
      FROM (
        -- Aggregate dependency updates per dependent step
        SELECT
          d.flow_slug,
          d.step_slug as dependent_slug,
          COUNT(*) as count,
          BOOL_OR(c.initial_tasks = 0) as has_zero_tasks
        FROM completed c
        JOIN pgflow.deps d ON d.flow_slug = c.flow_slug
                           AND d.dep_slug = c.step_slug
        GROUP BY d.flow_slug, d.step_slug
      ) dep_count,
      pgflow.steps s
      WHERE ss.run_id = cascade_complete_taskless_steps.run_id
        AND ss.flow_slug = dep_count.flow_slug
        AND ss.step_slug = dep_count.dependent_slug
        AND s.flow_slug = ss.flow_slug
        AND s.step_slug = ss.step_slug
    ),
    -- ---------- Update run counters ----------
    -- Only decrement remaining_steps; let maybe_complete_run handle finalization
    run_updates AS (
      UPDATE pgflow.runs r
      SET remaining_steps = r.remaining_steps - c.completed_count
      FROM (SELECT COUNT(*) AS completed_count FROM completed) c
      WHERE r.run_id = cascade_complete_taskless_steps.run_id
        AND c.completed_count > 0
    )
    -- ---------- Check iteration results ----------
    SELECT COUNT(*) INTO v_iteration_completed FROM completed;

    EXIT WHEN v_iteration_completed = 0;  -- No more steps to complete
    v_total_completed := v_total_completed + v_iteration_completed;
  END LOOP;

  RETURN v_total_completed;
END;
$$;


-- Modify "complete_task" function
CREATE OR REPLACE FUNCTION "pgflow"."complete_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "output" JSONB) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_step_state pgflow.step_states%ROWTYPE;
  v_dependent_map_slug text;
  v_run_record pgflow.runs%ROWTYPE;
  v_step_record pgflow.step_states%ROWTYPE;
begin

-- ==========================================
-- GUARD: No mutations on failed runs
-- ==========================================
IF EXISTS (SELECT 1 FROM pgflow.runs WHERE pgflow.runs.run_id = complete_task.run_id AND pgflow.runs.status = 'failed') THEN
  RETURN QUERY SELECT * FROM pgflow.step_tasks
    WHERE pgflow.step_tasks.run_id = complete_task.run_id
      AND pgflow.step_tasks.step_slug = complete_task.step_slug
      AND pgflow.step_tasks.task_index = complete_task.task_index;
  RETURN;
END IF;

-- ==========================================
-- LOCK ACQUISITION AND TYPE VALIDATION
-- ==========================================
-- Acquire locks first to prevent race conditions
SELECT * INTO v_run_record FROM pgflow.runs
WHERE pgflow.runs.run_id = complete_task.run_id
FOR UPDATE;

SELECT * INTO v_step_record FROM pgflow.step_states
WHERE pgflow.step_states.run_id = complete_task.run_id
  AND pgflow.step_states.step_slug = complete_task.step_slug
FOR UPDATE;

-- Check for type violations AFTER acquiring locks
SELECT child_step.step_slug INTO v_dependent_map_slug
FROM pgflow.deps dependency
JOIN pgflow.steps child_step ON child_step.flow_slug = dependency.flow_slug
                             AND child_step.step_slug = dependency.step_slug
JOIN pgflow.steps parent_step ON parent_step.flow_slug = dependency.flow_slug
                              AND parent_step.step_slug = dependency.dep_slug
JOIN pgflow.step_states child_state ON child_state.flow_slug = child_step.flow_slug
                                    AND child_state.step_slug = child_step.step_slug
WHERE dependency.dep_slug = complete_task.step_slug  -- parent is the completing step
  AND dependency.flow_slug = v_run_record.flow_slug
  AND parent_step.step_type = 'single'  -- Only validate single steps
  AND child_step.step_type = 'map'
  AND child_state.run_id = complete_task.run_id
  AND child_state.initial_tasks IS NULL
  AND (complete_task.output IS NULL OR jsonb_typeof(complete_task.output) != 'array')
LIMIT 1;

-- Handle type violation if detected
IF v_dependent_map_slug IS NOT NULL THEN
  -- Mark run as failed immediately
  UPDATE pgflow.runs
  SET status = 'failed',
      failed_at = now()
  WHERE pgflow.runs.run_id = complete_task.run_id;

  -- Archive all active messages (both queued and started) to prevent orphaned messages
  PERFORM pgmq.archive(
    v_run_record.flow_slug,
    array_agg(st.message_id)
  )
  FROM pgflow.step_tasks st
  WHERE st.run_id = complete_task.run_id
    AND st.status IN ('queued', 'started')
    AND st.message_id IS NOT NULL
  HAVING count(*) > 0;  -- Only call archive if there are messages to archive

  -- Mark current task as failed and store the output
  UPDATE pgflow.step_tasks
  SET status = 'failed',
      failed_at = now(),
      output = complete_task.output,  -- Store the output that caused the violation
      error_message = '[TYPE_VIOLATION] Produced ' ||
                     CASE WHEN complete_task.output IS NULL THEN 'null'
                          ELSE jsonb_typeof(complete_task.output) END ||
                     ' instead of array'
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index;

  -- Mark step state as failed
  UPDATE pgflow.step_states
  SET status = 'failed',
      failed_at = now(),
      error_message = '[TYPE_VIOLATION] Map step ' || v_dependent_map_slug ||
                     ' expects array input but dependency ' || complete_task.step_slug ||
                     ' produced ' || CASE WHEN complete_task.output IS NULL THEN 'null'
                                         ELSE jsonb_typeof(complete_task.output) END
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug;

  -- Archive the current task's message (it was started, now failed)
  PERFORM pgmq.archive(
    v_run_record.flow_slug,
    st.message_id  -- Single message, use scalar form
  )
  FROM pgflow.step_tasks st
  WHERE st.run_id = complete_task.run_id
    AND st.step_slug = complete_task.step_slug
    AND st.task_index = complete_task.task_index
    AND st.message_id IS NOT NULL;

  -- Return empty result
  RETURN QUERY SELECT * FROM pgflow.step_tasks WHERE false;
  RETURN;
END IF;

-- ==========================================
-- MAIN CTE CHAIN: Update task and propagate changes
-- ==========================================
WITH
-- ---------- Task completion ----------
-- Update the task record with completion status and output
task AS (
  UPDATE pgflow.step_tasks
  SET
    status = 'completed',
    completed_at = now(),
    output = complete_task.output
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index
    AND pgflow.step_tasks.status = 'started'
  RETURNING *
),
-- ---------- Step state update ----------
-- Decrement remaining_tasks and potentially mark step as completed
step_state AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN 'completed'  -- Will be 0 after decrement
    ELSE 'started'
    END,
    completed_at = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN now()  -- Will be 0 after decrement
    ELSE NULL
    END,
    remaining_tasks = pgflow.step_states.remaining_tasks - 1
  FROM task
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  RETURNING pgflow.step_states.*
),
-- ---------- Dependency resolution ----------
-- Find all child steps that depend on the completed parent step (only if parent completed)
child_steps AS (
  SELECT deps.step_slug AS child_step_slug
  FROM pgflow.deps deps
  JOIN step_state parent_state ON parent_state.status = 'completed' AND deps.flow_slug = parent_state.flow_slug
  WHERE deps.dep_slug = complete_task.step_slug  -- dep_slug is the parent, step_slug is the child
  ORDER BY deps.step_slug  -- Ensure consistent ordering
),
-- ---------- Lock child steps ----------
-- Acquire locks on all child steps before updating them
child_steps_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug IN (SELECT child_step_slug FROM child_steps)
  FOR UPDATE
),
-- ---------- Update child steps ----------
-- Decrement remaining_deps and resolve NULL initial_tasks for map steps
child_steps_update AS (
  UPDATE pgflow.step_states child_state
  SET remaining_deps = child_state.remaining_deps - 1,
      -- Resolve NULL initial_tasks for child map steps
      -- This is where child maps learn their array size from the parent
      -- This CTE only runs when the parent step is complete (see child_steps JOIN)
      initial_tasks = CASE
        WHEN child_step.step_type = 'map' AND child_state.initial_tasks IS NULL THEN
          CASE
            WHEN parent_step.step_type = 'map' THEN
              -- Map->map: Count all completed tasks from parent map
              -- We add 1 because the current task is being completed in this transaction
              -- but isn't yet visible as 'completed' in the step_tasks table
              -- TODO: Refactor to use future column step_states.total_tasks
              -- Would eliminate the COUNT query and just use parent_state.total_tasks
              (SELECT COUNT(*)::int + 1
               FROM pgflow.step_tasks parent_tasks
               WHERE parent_tasks.run_id = complete_task.run_id
                 AND parent_tasks.step_slug = complete_task.step_slug
                 AND parent_tasks.status = 'completed'
                 AND parent_tasks.task_index != complete_task.task_index)
            ELSE
              -- Single->map: Use output array length (single steps complete immediately)
              CASE
                WHEN complete_task.output IS NOT NULL
                     AND jsonb_typeof(complete_task.output) = 'array' THEN
                  jsonb_array_length(complete_task.output)
                ELSE NULL  -- Keep NULL if not an array
              END
          END
        ELSE child_state.initial_tasks  -- Keep existing value (including NULL)
      END
  FROM child_steps children
  JOIN pgflow.steps child_step ON child_step.flow_slug = (SELECT r.flow_slug FROM pgflow.runs r WHERE r.run_id = complete_task.run_id)
                               AND child_step.step_slug = children.child_step_slug
  JOIN pgflow.steps parent_step ON parent_step.flow_slug = (SELECT r.flow_slug FROM pgflow.runs r WHERE r.run_id = complete_task.run_id)
                                AND parent_step.step_slug = complete_task.step_slug
  WHERE child_state.run_id = complete_task.run_id
    AND child_state.step_slug = children.child_step_slug
)
-- ---------- Update run remaining_steps ----------
-- Decrement the run's remaining_steps counter if step completed
UPDATE pgflow.runs
SET remaining_steps = pgflow.runs.remaining_steps - 1
FROM step_state
WHERE pgflow.runs.run_id = complete_task.run_id
  AND step_state.status = 'completed';

-- ==========================================
-- POST-COMPLETION ACTIONS
-- ==========================================

-- ---------- Get updated state for broadcasting ----------
SELECT * INTO v_step_state FROM pgflow.step_states
WHERE pgflow.step_states.run_id = complete_task.run_id AND pgflow.step_states.step_slug = complete_task.step_slug;

-- ---------- Handle step completion ----------
IF v_step_state.status = 'completed' THEN
  -- Cascade complete any taskless steps that are now ready
  PERFORM pgflow.cascade_complete_taskless_steps(complete_task.run_id);

  -- Broadcast step:completed event
  -- For map steps, aggregate all task outputs; for single steps, use the task output
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'step:completed',
      'run_id', complete_task.run_id,
      'step_slug', complete_task.step_slug,
      'status', 'completed',
      'output', CASE
        WHEN (SELECT s.step_type FROM pgflow.steps s
              WHERE s.flow_slug = v_step_state.flow_slug
                AND s.step_slug = complete_task.step_slug) = 'map' THEN
          -- Aggregate all task outputs for map steps
          (SELECT COALESCE(jsonb_agg(st.output ORDER BY st.task_index), '[]'::jsonb)
           FROM pgflow.step_tasks st
           WHERE st.run_id = complete_task.run_id
             AND st.step_slug = complete_task.step_slug
             AND st.status = 'completed')
        ELSE
          -- Single step: use the individual task output
          complete_task.output
      END,
      'completed_at', v_step_state.completed_at
    ),
    concat('step:', complete_task.step_slug, ':completed'),
    concat('pgflow:run:', complete_task.run_id),
    false
  );
END IF;

-- ---------- Archive completed task message ----------
-- Move message from active queue to archive table
PERFORM (
  WITH completed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = complete_task.run_id
      AND st.step_slug = complete_task.step_slug
      AND st.task_index = complete_task.task_index
      AND st.status = 'completed'
  )
  SELECT pgmq.archive(ct.flow_slug, ct.message_id)
  FROM completed_tasks ct
  WHERE EXISTS (SELECT 1 FROM completed_tasks)
);

-- ---------- Trigger next steps ----------
-- Start any steps that are now ready (deps satisfied)
PERFORM pgflow.start_ready_steps(complete_task.run_id);

-- Check if the entire run is complete
PERFORM pgflow.maybe_complete_run(complete_task.run_id);

-- ---------- Return completed task ----------
RETURN QUERY SELECT *
FROM pgflow.step_tasks AS step_task
WHERE step_task.run_id = complete_task.run_id
  AND step_task.step_slug = complete_task.step_slug
  AND step_task.task_index = complete_task.task_index;

end;
$$;


-- Modify "fail_task" function
CREATE OR REPLACE FUNCTION "pgflow"."fail_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "error_message" TEXT) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
DECLARE
  v_run_failed boolean;
  v_step_failed boolean;
begin

-- If run is already failed, no retries allowed
IF EXISTS (SELECT 1 FROM pgflow.runs WHERE pgflow.runs.run_id = fail_task.run_id AND pgflow.runs.status = 'failed') THEN
  UPDATE pgflow.step_tasks
  SET status = 'failed',
      failed_at = now(),
      error_message = fail_task.error_message
  WHERE pgflow.step_tasks.run_id = fail_task.run_id
    AND pgflow.step_tasks.step_slug = fail_task.step_slug
    AND pgflow.step_tasks.task_index = fail_task.task_index
    AND pgflow.step_tasks.status = 'started';

  -- Archive the task's message
  PERFORM pgmq.archive(r.flow_slug, ARRAY_AGG(st.message_id))
  FROM pgflow.step_tasks st
  JOIN pgflow.runs r ON st.run_id = r.run_id
  WHERE st.run_id = fail_task.run_id
    AND st.step_slug = fail_task.step_slug
    AND st.task_index = fail_task.task_index
    AND st.message_id IS NOT NULL
  GROUP BY r.flow_slug
  HAVING COUNT(st.message_id) > 0;

  RETURN QUERY SELECT * FROM pgflow.step_tasks
  WHERE pgflow.step_tasks.run_id = fail_task.run_id
    AND pgflow.step_tasks.step_slug = fail_task.step_slug
    AND pgflow.step_tasks.task_index = fail_task.task_index;
  RETURN;
END IF;

WITH run_lock AS (
  SELECT * FROM pgflow.runs
  WHERE pgflow.runs.run_id = fail_task.run_id
  FOR UPDATE
),
step_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  FOR UPDATE
),
flow_info AS (
  SELECT r.flow_slug
  FROM pgflow.runs r
  WHERE r.run_id = fail_task.run_id
),
config AS (
  SELECT
    COALESCE(s.opt_max_attempts, f.opt_max_attempts) AS opt_max_attempts,
    COALESCE(s.opt_base_delay, f.opt_base_delay) AS opt_base_delay
  FROM pgflow.steps s
  JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
  JOIN flow_info fi ON fi.flow_slug = s.flow_slug
  WHERE s.flow_slug = fi.flow_slug AND s.step_slug = fail_task.step_slug
),
fail_or_retry_task as (
  UPDATE pgflow.step_tasks as task
  SET
    status = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN 'queued'
      ELSE 'failed'
    END,
    failed_at = CASE
      WHEN task.attempts_count >= (SELECT opt_max_attempts FROM config) THEN now()
      ELSE NULL
    END,
    started_at = CASE
      WHEN task.attempts_count < (SELECT opt_max_attempts FROM config) THEN NULL
      ELSE task.started_at
    END,
    error_message = fail_task.error_message
  WHERE task.run_id = fail_task.run_id
    AND task.step_slug = fail_task.step_slug
    AND task.task_index = fail_task.task_index
    AND task.status = 'started'
  RETURNING *
),
maybe_fail_step AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
             WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN 'failed'
             ELSE pgflow.step_states.status
             END,
    failed_at = CASE
                WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN now()
                ELSE NULL
                END,
    error_message = CASE
                    WHEN (select fail_or_retry_task.status from fail_or_retry_task) = 'failed' THEN fail_task.error_message
                    ELSE NULL
                    END
  FROM fail_or_retry_task
  WHERE pgflow.step_states.run_id = fail_task.run_id
    AND pgflow.step_states.step_slug = fail_task.step_slug
  RETURNING pgflow.step_states.*
)
-- Update run status
UPDATE pgflow.runs
SET status = CASE
              WHEN (select status from maybe_fail_step) = 'failed' THEN 'failed'
              ELSE status
              END,
    failed_at = CASE
                WHEN (select status from maybe_fail_step) = 'failed' THEN now()
                ELSE NULL
                END
WHERE pgflow.runs.run_id = fail_task.run_id
RETURNING (status = 'failed') INTO v_run_failed;

-- Check if step failed by querying the step_states table
SELECT (status = 'failed') INTO v_step_failed 
FROM pgflow.step_states 
WHERE pgflow.step_states.run_id = fail_task.run_id 
  AND pgflow.step_states.step_slug = fail_task.step_slug;

-- Send broadcast event for step failure if the step was failed
IF v_step_failed THEN
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'step:failed',
      'run_id', fail_task.run_id,
      'step_slug', fail_task.step_slug,
      'status', 'failed',
      'error_message', fail_task.error_message,
      'failed_at', now()
    ),
    concat('step:', fail_task.step_slug, ':failed'),
    concat('pgflow:run:', fail_task.run_id),
    false
  );
END IF;

-- Send broadcast event for run failure if the run was failed
IF v_run_failed THEN
  DECLARE
    v_flow_slug text;
  BEGIN
    SELECT flow_slug INTO v_flow_slug FROM pgflow.runs WHERE pgflow.runs.run_id = fail_task.run_id;

    PERFORM realtime.send(
      jsonb_build_object(
        'event_type', 'run:failed',
        'run_id', fail_task.run_id,
        'flow_slug', v_flow_slug,
        'status', 'failed',
        'error_message', fail_task.error_message,
        'failed_at', now()
      ),
      'run:failed',
      concat('pgflow:run:', fail_task.run_id),
      false
    );
  END;
END IF;

-- Archive all active messages (both queued and started) when run fails
IF v_run_failed THEN
  PERFORM pgmq.archive(r.flow_slug, ARRAY_AGG(st.message_id))
  FROM pgflow.step_tasks st
  JOIN pgflow.runs r ON st.run_id = r.run_id
  WHERE st.run_id = fail_task.run_id
    AND st.status IN ('queued', 'started')
    AND st.message_id IS NOT NULL
  GROUP BY r.flow_slug
  HAVING COUNT(st.message_id) > 0;
END IF;

-- For queued tasks: delay the message for retry with exponential backoff
PERFORM (
  WITH retry_config AS (
    SELECT
      COALESCE(s.opt_base_delay, f.opt_base_delay) AS base_delay
    FROM pgflow.steps s
    JOIN pgflow.flows f ON f.flow_slug = s.flow_slug
    JOIN pgflow.runs r ON r.flow_slug = f.flow_slug
    WHERE r.run_id = fail_task.run_id
      AND s.step_slug = fail_task.step_slug
  ),
  queued_tasks AS (
    SELECT
      r.flow_slug,
      st.message_id,
      pgflow.calculate_retry_delay((SELECT base_delay FROM retry_config), st.attempts_count) AS calculated_delay
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = fail_task.run_id
      AND st.step_slug = fail_task.step_slug
      AND st.task_index = fail_task.task_index
      AND st.status = 'queued'
  )
  SELECT pgmq.set_vt(qt.flow_slug, qt.message_id, qt.calculated_delay)
  FROM queued_tasks qt
  WHERE EXISTS (SELECT 1 FROM queued_tasks)
);

-- For failed tasks: archive the message
PERFORM pgmq.archive(r.flow_slug, ARRAY_AGG(st.message_id))
FROM pgflow.step_tasks st
JOIN pgflow.runs r ON st.run_id = r.run_id
WHERE st.run_id = fail_task.run_id
  AND st.step_slug = fail_task.step_slug
  AND st.task_index = fail_task.task_index
  AND st.status = 'failed'
  AND st.message_id IS NOT NULL
GROUP BY r.flow_slug
HAVING COUNT(st.message_id) > 0;

return query select *
from pgflow.step_tasks st
where st.run_id = fail_task.run_id
  and st.step_slug = fail_task.step_slug
  and st.task_index = fail_task.task_index;

end;
$$;


-- Modify "start_flow" function
CREATE OR REPLACE FUNCTION "pgflow"."start_flow" ("flow_slug" TEXT, "input" JSONB, "run_id" UUID DEFAULT NULL::UUID) RETURNS SETOF "pgflow"."runs" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_created_run pgflow.runs%ROWTYPE;
  v_root_map_count int;
begin

-- ==========================================
-- VALIDATION: Root map array input
-- ==========================================
WITH root_maps AS (
  SELECT step_slug
  FROM pgflow.steps
  WHERE steps.flow_slug = start_flow.flow_slug
    AND steps.step_type = 'map'
    AND steps.deps_count = 0
)
SELECT COUNT(*) INTO v_root_map_count FROM root_maps;

-- If we have root map steps, validate that input is an array
IF v_root_map_count > 0 THEN
  -- First check for NULL (should be caught by NOT NULL constraint, but be defensive)
  IF start_flow.input IS NULL THEN
    RAISE EXCEPTION 'Flow % has root map steps but input is NULL', start_flow.flow_slug;
  END IF;
  
  -- Then check if it's not an array
  IF jsonb_typeof(start_flow.input) != 'array' THEN
    RAISE EXCEPTION 'Flow % has root map steps but input is not an array (got %)', 
      start_flow.flow_slug, jsonb_typeof(start_flow.input);
  END IF;
END IF;

-- ==========================================
-- MAIN CTE CHAIN: Create run and step states
-- ==========================================
WITH
  -- ---------- Gather flow metadata ----------
  flow_steps AS (
    SELECT steps.flow_slug, steps.step_slug, steps.step_type, steps.deps_count
    FROM pgflow.steps
    WHERE steps.flow_slug = start_flow.flow_slug
  ),
  -- ---------- Create run record ----------
  created_run AS (
    INSERT INTO pgflow.runs (run_id, flow_slug, input, remaining_steps)
    VALUES (
      COALESCE(start_flow.run_id, gen_random_uuid()),
      start_flow.flow_slug,
      start_flow.input,
      (SELECT count(*) FROM flow_steps)
    )
    RETURNING *
  ),
  -- ---------- Create step states ----------
  -- Sets initial_tasks: known for root maps, NULL for dependent maps
  created_step_states AS (
    INSERT INTO pgflow.step_states (flow_slug, run_id, step_slug, remaining_deps, initial_tasks)
    SELECT
      fs.flow_slug,
      (SELECT created_run.run_id FROM created_run),
      fs.step_slug,
      fs.deps_count,
      -- Updated logic for initial_tasks:
      CASE
        WHEN fs.step_type = 'map' AND fs.deps_count = 0 THEN
          -- Root map: get array length from input
          CASE
            WHEN jsonb_typeof(start_flow.input) = 'array' THEN
              jsonb_array_length(start_flow.input)
            ELSE
              1
          END
        WHEN fs.step_type = 'map' AND fs.deps_count > 0 THEN
          -- Dependent map: unknown until dependencies complete
          NULL
        ELSE
          -- Single steps: always 1 task
          1
      END
    FROM flow_steps fs
  )
SELECT * FROM created_run INTO v_created_run;

-- ==========================================
-- POST-CREATION ACTIONS
-- ==========================================

-- ---------- Broadcast run:started event ----------
PERFORM realtime.send(
  jsonb_build_object(
    'event_type', 'run:started',
    'run_id', v_created_run.run_id,
    'flow_slug', v_created_run.flow_slug,
    'input', v_created_run.input,
    'status', 'started',
    'remaining_steps', v_created_run.remaining_steps,
    'started_at', v_created_run.started_at
  ),
  'run:started',
  concat('pgflow:run:', v_created_run.run_id),
  false
);

-- ---------- Complete taskless steps ----------
-- Handle empty array maps that should auto-complete
PERFORM pgflow.cascade_complete_taskless_steps(v_created_run.run_id);

-- ---------- Start initial steps ----------
-- Start root steps (those with no dependencies)
PERFORM pgflow.start_ready_steps(v_created_run.run_id);

-- ---------- Check for run completion ----------
-- If cascade completed all steps (zero-task flows), finalize the run
PERFORM pgflow.maybe_complete_run(v_created_run.run_id);

RETURN QUERY SELECT * FROM pgflow.runs where pgflow.runs.run_id = v_created_run.run_id;

end;
$$;


-- Modify "start_tasks" function
CREATE OR REPLACE FUNCTION "pgflow"."start_tasks" ("flow_slug" TEXT, "msg_ids" BIGINT[], "worker_id" UUID) RETURNS SETOF "pgflow"."step_task_record" LANGUAGE sql
SET
  "search_path" = '' AS $$
with tasks as (
    select
      task.flow_slug,
      task.run_id,
      task.step_slug,
      task.task_index,
      task.message_id
    from pgflow.step_tasks as task
    join pgflow.runs r on r.run_id = task.run_id
    where task.flow_slug = start_tasks.flow_slug
      and task.message_id = any(msg_ids)
      and task.status = 'queued'
      -- MVP: Don't start tasks on failed runs
      and r.status != 'failed'
  ),
  start_tasks_update as (
    update pgflow.step_tasks
    set
      attempts_count = attempts_count + 1,
      status = 'started',
      started_at = now(),
      last_worker_id = worker_id
    from tasks
    where step_tasks.message_id = tasks.message_id
      and step_tasks.flow_slug = tasks.flow_slug
      and step_tasks.status = 'queued'
  ),
  runs as (
    select
      r.run_id,
      r.input
    from pgflow.runs r
    where r.run_id in (select run_id from tasks)
  ),
  deps as (
    select
      st.run_id,
      st.step_slug,
      dep.dep_slug,
      -- Aggregate map outputs or use single output
      CASE
        WHEN dep_step.step_type = 'map' THEN
          -- Aggregate all task outputs ordered by task_index
          -- Use COALESCE to return empty array if no tasks
          (SELECT COALESCE(jsonb_agg(dt.output ORDER BY dt.task_index), '[]'::jsonb)
           FROM pgflow.step_tasks dt
           WHERE dt.run_id = st.run_id
             AND dt.step_slug = dep.dep_slug
             AND dt.status = 'completed')
        ELSE
          -- Single step: use the single task output
          dep_task.output
      END as dep_output
    from tasks st
    join pgflow.deps dep on dep.flow_slug = st.flow_slug and dep.step_slug = st.step_slug
    join pgflow.steps dep_step on dep_step.flow_slug = dep.flow_slug and dep_step.step_slug = dep.dep_slug
    left join pgflow.step_tasks dep_task on
      dep_task.run_id = st.run_id and
      dep_task.step_slug = dep.dep_slug and
      dep_task.status = 'completed'
      and dep_step.step_type = 'single'  -- Only join for single steps
  ),
  deps_outputs as (
    select
      d.run_id,
      d.step_slug,
      jsonb_object_agg(d.dep_slug, d.dep_output) as deps_output,
      count(*) as dep_count
    from deps d
    group by d.run_id, d.step_slug
  ),
  timeouts as (
    select
      task.message_id,
      task.flow_slug,
      coalesce(step.opt_timeout, flow.opt_timeout) + 2 as vt_delay
    from tasks task
    join pgflow.flows flow on flow.flow_slug = task.flow_slug
    join pgflow.steps step on step.flow_slug = task.flow_slug and step.step_slug = task.step_slug
  ),
  -- Batch update visibility timeouts for all messages
  set_vt_batch as (
    select pgflow.set_vt_batch(
      start_tasks.flow_slug,
      array_agg(t.message_id order by t.message_id),
      array_agg(t.vt_delay order by t.message_id)
    )
    from timeouts t
  )
  select
    st.flow_slug,
    st.run_id,
    st.step_slug,
    -- ==========================================
    -- INPUT CONSTRUCTION LOGIC
    -- ==========================================
    -- This nested CASE statement determines how to construct the input
    -- for each task based on the step type (map vs non-map).
    --
    -- The fundamental difference:
    -- - Map steps: Receive RAW array elements (e.g., just 42 or "hello")
    -- - Non-map steps: Receive structured objects with named keys
    --                  (e.g., {"run": {...}, "dependency1": {...}})
    -- ==========================================
    CASE
      -- -------------------- MAP STEPS --------------------
      -- Map steps process arrays element-by-element.
      -- Each task receives ONE element from the array at its task_index position.
      WHEN step.step_type = 'map' THEN
        -- Map steps get raw array elements without any wrapper object
        CASE
          -- ROOT MAP: Gets array from run input
          -- Example: run input = [1, 2, 3]
          --          task 0 gets: 1
          --          task 1 gets: 2
          --          task 2 gets: 3
          WHEN step.deps_count = 0 THEN
            -- Root map (deps_count = 0): no dependencies, reads from run input.
            -- Extract the element at task_index from the run's input array.
            -- Note: If run input is not an array, this will return NULL
            -- and the flow will fail (validated in start_flow).
            jsonb_array_element(r.input, st.task_index)

          -- DEPENDENT MAP: Gets array from its single dependency
          -- Example: dependency output = ["a", "b", "c"]
          --          task 0 gets: "a"
          --          task 1 gets: "b"
          --          task 2 gets: "c"
          ELSE
            -- Has dependencies (should be exactly 1 for map steps).
            -- Extract the element at task_index from the dependency's output array.
            --
            -- Why the subquery with jsonb_each?
            -- - The dependency outputs a raw array: [1, 2, 3]
            -- - deps_outputs aggregates it into: {"dep_name": [1, 2, 3]}
            -- - We need to unwrap and get just the array value
            -- - Map steps have exactly 1 dependency (enforced by add_step)
            -- - So jsonb_each will return exactly 1 row
            -- - We extract the 'value' which is the raw array [1, 2, 3]
            -- - Then get the element at task_index from that array
            (SELECT jsonb_array_element(value, st.task_index)
            FROM jsonb_each(dep_out.deps_output)
            LIMIT 1)
        END

      -- -------------------- NON-MAP STEPS --------------------
      -- Regular (non-map) steps receive ALL inputs as a structured object.
      -- This includes the original run input plus all dependency outputs.
      ELSE
        -- Non-map steps get structured input with named keys
        -- Example output: {
        --   "run": {"original": "input"},
        --   "step1": {"output": "from_step1"},
        --   "step2": {"output": "from_step2"}
        -- }
        --
        -- Build object with 'run' key containing original input
        jsonb_build_object('run', r.input) ||
        -- Merge with deps_output which already has dependency outputs
        -- deps_output format: {"dep1": output1, "dep2": output2, ...}
        -- If no dependencies, defaults to empty object
        coalesce(dep_out.deps_output, '{}'::jsonb)
    END as input,
    st.message_id as msg_id,
    st.task_index as task_index
  from tasks st
  join runs r on st.run_id = r.run_id
  join pgflow.steps step on
    step.flow_slug = st.flow_slug and
    step.step_slug = st.step_slug
  left join deps_outputs dep_out on
    dep_out.run_id = st.run_id and
    dep_out.step_slug = st.step_slug
$$;


-- Create "add_step" function
CREATE FUNCTION "pgflow"."add_step" (
  "flow_slug" TEXT,
  "step_slug" TEXT,
  "deps_slugs" TEXT[] DEFAULT '{}',
  "max_attempts" INTEGER DEFAULT NULL::INTEGER,
  "base_delay" INTEGER DEFAULT NULL::INTEGER,
  "timeout" INTEGER DEFAULT NULL::INTEGER,
  "start_delay" INTEGER DEFAULT NULL::INTEGER,
  "step_type" TEXT DEFAULT 'single'
) RETURNS "pgflow"."steps" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
DECLARE
  result_step pgflow.steps;
  next_idx int;
BEGIN
  -- Validate map step constraints
  -- Map steps can have either:
  --   0 dependencies (root map - maps over flow input array)
  --   1 dependency (dependent map - maps over dependency output array)
  IF COALESCE(add_step.step_type, 'single') = 'map' AND COALESCE(array_length(add_step.deps_slugs, 1), 0) > 1 THEN
    RAISE EXCEPTION 'Map step "%" can have at most one dependency, but % were provided: %', 
      add_step.step_slug,
      COALESCE(array_length(add_step.deps_slugs, 1), 0),
      array_to_string(add_step.deps_slugs, ', ');
  END IF;

  -- Get next step index
  SELECT COALESCE(MAX(s.step_index) + 1, 0) INTO next_idx
  FROM pgflow.steps s
  WHERE s.flow_slug = add_step.flow_slug;

  -- Create the step
  INSERT INTO pgflow.steps (
    flow_slug, step_slug, step_type, step_index, deps_count,
    opt_max_attempts, opt_base_delay, opt_timeout, opt_start_delay
  )
  VALUES (
    add_step.flow_slug,
    add_step.step_slug,
    COALESCE(add_step.step_type, 'single'),
    next_idx, 
    COALESCE(array_length(add_step.deps_slugs, 1), 0),
    add_step.max_attempts,
    add_step.base_delay,
    add_step.timeout,
    add_step.start_delay
  )
  ON CONFLICT ON CONSTRAINT steps_pkey
  DO UPDATE SET step_slug = EXCLUDED.step_slug
  RETURNING * INTO result_step;

  -- Insert dependencies
  INSERT INTO pgflow.deps (flow_slug, dep_slug, step_slug)
  SELECT add_step.flow_slug, d.dep_slug, add_step.step_slug
  FROM unnest(COALESCE(add_step.deps_slugs, '{}')) AS d(dep_slug)
  WHERE add_step.deps_slugs IS NOT NULL AND array_length(add_step.deps_slugs, 1) > 0
  ON CONFLICT ON CONSTRAINT deps_pkey DO NOTHING;
  
  RETURN result_step;
END;
$$;


-- Drop "add_step" function
DROP FUNCTION "pgflow"."add_step" (TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER);


-- Drop "add_step" function
DROP FUNCTION "pgflow"."add_step" (TEXT, TEXT, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER);


-- Modify "cascade_complete_taskless_steps" function
CREATE OR REPLACE FUNCTION "pgflow"."cascade_complete_taskless_steps" ("run_id" UUID) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_total_completed int := 0;
  v_iteration_completed int;
  v_iterations int := 0;
  v_max_iterations int := 50;
BEGIN
  -- ==========================================
  -- ITERATIVE CASCADE COMPLETION
  -- ==========================================
  -- Completes taskless steps in waves until none remain
  LOOP
    -- ---------- Safety check ----------
    v_iterations := v_iterations + 1;
    IF v_iterations > v_max_iterations THEN
      RAISE EXCEPTION 'Cascade loop exceeded safety limit of % iterations', v_max_iterations;
    END IF;

    -- ==========================================
    -- COMPLETE READY TASKLESS STEPS
    -- ==========================================
    WITH
    -- ---------- Find steps to complete in topological order ----------
    steps_to_complete AS (
      SELECT ss.run_id, ss.step_slug
      FROM pgflow.step_states ss
      JOIN pgflow.steps s ON s.flow_slug = ss.flow_slug AND s.step_slug = ss.step_slug
      WHERE ss.run_id = cascade_complete_taskless_steps.run_id
        AND ss.status = 'created'
        AND ss.remaining_deps = 0
        AND ss.initial_tasks = 0
      -- Process in topological order to ensure proper cascade
      ORDER BY s.step_index
    ),
    completed AS (
      -- ---------- Complete taskless steps ----------
      -- Steps with initial_tasks=0 and no remaining deps
      UPDATE pgflow.step_states ss
      SET status = 'completed',
          started_at = now(),
          completed_at = now(),
          remaining_tasks = 0
      FROM steps_to_complete stc
      WHERE ss.run_id = stc.run_id
        AND ss.step_slug = stc.step_slug
      RETURNING
        ss.*,
        -- Broadcast step:completed event atomically with the UPDATE
        -- Using RETURNING ensures this executes during row processing
        -- and cannot be optimized away by the query planner
        realtime.send(
          jsonb_build_object(
            'event_type', 'step:completed',
            'run_id', ss.run_id,
            'step_slug', ss.step_slug,
            'status', 'completed',
            'started_at', ss.started_at,
            'completed_at', ss.completed_at,
            'remaining_tasks', 0,
            'remaining_deps', 0,
            'output', '[]'::jsonb
          ),
          concat('step:', ss.step_slug, ':completed'),
          concat('pgflow:run:', ss.run_id),
          false
        ) as _broadcast_result  -- Prefix with _ to indicate internal use only
    ),
    -- ---------- Update dependent steps ----------
    -- Propagate completion and empty arrays to dependents
    dep_updates AS (
      UPDATE pgflow.step_states ss
      SET remaining_deps = ss.remaining_deps - dep_count.count,
          -- If the dependent is a map step and its dependency completed with 0 tasks,
          -- set its initial_tasks to 0 as well
          initial_tasks = CASE
            WHEN s.step_type = 'map' AND dep_count.has_zero_tasks
            THEN 0  -- Empty array propagation
            ELSE ss.initial_tasks  -- Keep existing value (including NULL)
          END
      FROM (
        -- Aggregate dependency updates per dependent step
        SELECT
          d.flow_slug,
          d.step_slug as dependent_slug,
          COUNT(*) as count,
          BOOL_OR(c.initial_tasks = 0) as has_zero_tasks
        FROM completed c
        JOIN pgflow.deps d ON d.flow_slug = c.flow_slug
                           AND d.dep_slug = c.step_slug
        GROUP BY d.flow_slug, d.step_slug
      ) dep_count,
      pgflow.steps s
      WHERE ss.run_id = cascade_complete_taskless_steps.run_id
        AND ss.flow_slug = dep_count.flow_slug
        AND ss.step_slug = dep_count.dependent_slug
        AND s.flow_slug = ss.flow_slug
        AND s.step_slug = ss.step_slug
    ),
    -- ---------- Update run counters ----------
    -- Only decrement remaining_steps; let maybe_complete_run handle finalization
    run_updates AS (
      UPDATE pgflow.runs r
      SET remaining_steps = r.remaining_steps - c.completed_count
      FROM (SELECT COUNT(*) AS completed_count FROM completed) c
      WHERE r.run_id = cascade_complete_taskless_steps.run_id
        AND c.completed_count > 0
    )
    -- ---------- Check iteration results ----------
    SELECT COUNT(*) INTO v_iteration_completed FROM completed;

    EXIT WHEN v_iteration_completed = 0;  -- No more steps to complete
    v_total_completed := v_total_completed + v_iteration_completed;
  END LOOP;

  RETURN v_total_completed;
END;
$$;


-- Modify "start_ready_steps" function
CREATE OR REPLACE FUNCTION "pgflow"."start_ready_steps" ("run_id" UUID) RETURNS void LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
begin
-- ==========================================
-- GUARD: No mutations on failed runs
-- ==========================================
IF EXISTS (SELECT 1 FROM pgflow.runs WHERE pgflow.runs.run_id = start_ready_steps.run_id AND pgflow.runs.status = 'failed') THEN
  RETURN;
END IF;

-- ==========================================
-- HANDLE EMPTY ARRAY MAPS (initial_tasks = 0)
-- ==========================================
-- These complete immediately without spawning tasks
WITH empty_map_steps AS (
  SELECT step_state.*
  FROM pgflow.step_states AS step_state
  JOIN pgflow.steps AS step 
    ON step.flow_slug = step_state.flow_slug 
    AND step.step_slug = step_state.step_slug
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
    AND step.step_type = 'map'
    AND step_state.initial_tasks = 0
  ORDER BY step_state.step_slug
  FOR UPDATE OF step_state
),
-- ---------- Complete empty map steps ----------
completed_empty_steps AS (
  UPDATE pgflow.step_states
  SET status = 'completed',
      started_at = now(),
      completed_at = now(),
      remaining_tasks = 0
  FROM empty_map_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = empty_map_steps.step_slug
  RETURNING
    pgflow.step_states.*,
    -- Broadcast step:completed event atomically with the UPDATE
    -- Using RETURNING ensures this executes during row processing
    -- and cannot be optimized away by the query planner
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:completed',
        'run_id', pgflow.step_states.run_id,
        'step_slug', pgflow.step_states.step_slug,
        'status', 'completed',
        'started_at', pgflow.step_states.started_at,
        'completed_at', pgflow.step_states.completed_at,
        'remaining_tasks', 0,
        'remaining_deps', 0,
        'output', '[]'::jsonb
      ),
      concat('step:', pgflow.step_states.step_slug, ':completed'),
      concat('pgflow:run:', pgflow.step_states.run_id),
      false
    ) as _broadcast_completed  -- Prefix with _ to indicate internal use only
),

-- ==========================================
-- HANDLE NORMAL STEPS (initial_tasks > 0)
-- ==========================================
-- ---------- Find ready steps ----------
-- Steps with no remaining deps and known task count
ready_steps AS (
  SELECT *
  FROM pgflow.step_states AS step_state
  WHERE step_state.run_id = start_ready_steps.run_id
    AND step_state.status = 'created'
    AND step_state.remaining_deps = 0
    AND step_state.initial_tasks IS NOT NULL  -- NEW: Cannot start with unknown count
    AND step_state.initial_tasks > 0  -- Don't start taskless steps
    -- Exclude empty map steps already handled
    AND NOT EXISTS (
      SELECT 1 FROM empty_map_steps
      WHERE empty_map_steps.run_id = step_state.run_id
        AND empty_map_steps.step_slug = step_state.step_slug
    )
  ORDER BY step_state.step_slug
  FOR UPDATE
),
-- ---------- Mark steps as started ----------
started_step_states AS (
  UPDATE pgflow.step_states
  SET status = 'started',
      started_at = now(),
      remaining_tasks = ready_steps.initial_tasks  -- Copy initial_tasks to remaining_tasks when starting
  FROM ready_steps
  WHERE pgflow.step_states.run_id = start_ready_steps.run_id
    AND pgflow.step_states.step_slug = ready_steps.step_slug
  RETURNING pgflow.step_states.*,
    -- Broadcast step:started event atomically with the UPDATE
    -- Using RETURNING ensures this executes during row processing
    -- and cannot be optimized away by the query planner
    realtime.send(
      jsonb_build_object(
        'event_type', 'step:started',
        'run_id', pgflow.step_states.run_id,
        'step_slug', pgflow.step_states.step_slug,
        'status', 'started',
        'started_at', pgflow.step_states.started_at,
        'remaining_tasks', pgflow.step_states.remaining_tasks,
        'remaining_deps', pgflow.step_states.remaining_deps
      ),
      concat('step:', pgflow.step_states.step_slug, ':started'),
      concat('pgflow:run:', pgflow.step_states.run_id),
      false
    ) as _broadcast_result  -- Prefix with _ to indicate internal use only
),

-- ==========================================
-- TASK GENERATION AND QUEUE MESSAGES
-- ==========================================
-- ---------- Generate tasks and batch messages ----------
-- Single steps: 1 task (index 0)
-- Map steps: N tasks (indices 0..N-1)
message_batches AS (
  SELECT
    started_step.flow_slug,
    started_step.run_id,
    started_step.step_slug,
    COALESCE(step.opt_start_delay, 0) as delay,
    array_agg(
      jsonb_build_object(
        'flow_slug', started_step.flow_slug,
        'run_id', started_step.run_id,
        'step_slug', started_step.step_slug,
        'task_index', task_idx.task_index
      ) ORDER BY task_idx.task_index
    ) AS messages,
    array_agg(task_idx.task_index ORDER BY task_idx.task_index) AS task_indices
  FROM started_step_states AS started_step
  JOIN pgflow.steps AS step 
    ON step.flow_slug = started_step.flow_slug 
    AND step.step_slug = started_step.step_slug
  -- Generate task indices from 0 to initial_tasks-1
  CROSS JOIN LATERAL generate_series(0, started_step.initial_tasks - 1) AS task_idx(task_index)
  GROUP BY started_step.flow_slug, started_step.run_id, started_step.step_slug, step.opt_start_delay
),
-- ---------- Send messages to queue ----------
-- Uses batch sending for performance with large arrays
sent_messages AS (
  SELECT
    mb.flow_slug,
    mb.run_id,
    mb.step_slug,
    task_indices.task_index,
    msg_ids.msg_id
  FROM message_batches mb
  CROSS JOIN LATERAL unnest(mb.task_indices) WITH ORDINALITY AS task_indices(task_index, idx_ord)
  CROSS JOIN LATERAL pgmq.send_batch(mb.flow_slug, mb.messages, mb.delay) WITH ORDINALITY AS msg_ids(msg_id, msg_ord)
  WHERE task_indices.idx_ord = msg_ids.msg_ord
)

-- ==========================================
-- RECORD TASKS IN DATABASE
-- ==========================================
INSERT INTO pgflow.step_tasks (flow_slug, run_id, step_slug, task_index, message_id)
SELECT
  sent_messages.flow_slug,
  sent_messages.run_id,
  sent_messages.step_slug,
  sent_messages.task_index,
  sent_messages.msg_id
FROM sent_messages;

-- ==========================================
-- BROADCAST REALTIME EVENTS
-- ==========================================
-- Note: Both step:completed events for empty maps and step:started events
-- are now broadcast atomically in their respective CTEs using RETURNING pattern.
-- This ensures correct ordering, prevents duplicate broadcasts, and guarantees
-- that events are sent for exactly the rows that were updated.

end;
$$;


-- Modify "complete_task" function
CREATE OR REPLACE FUNCTION "pgflow"."complete_task" ("run_id" UUID, "step_slug" TEXT, "task_index" INTEGER, "output" JSONB) RETURNS SETOF "pgflow"."step_tasks" LANGUAGE plpgsql
SET
  "search_path" = '' AS $$
declare
  v_step_state pgflow.step_states%ROWTYPE;
  v_dependent_map_slug text;
  v_run_record pgflow.runs%ROWTYPE;
  v_step_record pgflow.step_states%ROWTYPE;
begin

-- ==========================================
-- GUARD: No mutations on failed runs
-- ==========================================
IF EXISTS (SELECT 1 FROM pgflow.runs WHERE pgflow.runs.run_id = complete_task.run_id AND pgflow.runs.status = 'failed') THEN
  RETURN QUERY SELECT * FROM pgflow.step_tasks
    WHERE pgflow.step_tasks.run_id = complete_task.run_id
      AND pgflow.step_tasks.step_slug = complete_task.step_slug
      AND pgflow.step_tasks.task_index = complete_task.task_index;
  RETURN;
END IF;

-- ==========================================
-- LOCK ACQUISITION AND TYPE VALIDATION
-- ==========================================
-- Acquire locks first to prevent race conditions
SELECT * INTO v_run_record FROM pgflow.runs
WHERE pgflow.runs.run_id = complete_task.run_id
FOR UPDATE;

SELECT * INTO v_step_record FROM pgflow.step_states
WHERE pgflow.step_states.run_id = complete_task.run_id
  AND pgflow.step_states.step_slug = complete_task.step_slug
FOR UPDATE;

-- Check for type violations AFTER acquiring locks
SELECT child_step.step_slug INTO v_dependent_map_slug
FROM pgflow.deps dependency
JOIN pgflow.steps child_step ON child_step.flow_slug = dependency.flow_slug
                             AND child_step.step_slug = dependency.step_slug
JOIN pgflow.steps parent_step ON parent_step.flow_slug = dependency.flow_slug
                              AND parent_step.step_slug = dependency.dep_slug
JOIN pgflow.step_states child_state ON child_state.flow_slug = child_step.flow_slug
                                    AND child_state.step_slug = child_step.step_slug
WHERE dependency.dep_slug = complete_task.step_slug  -- parent is the completing step
  AND dependency.flow_slug = v_run_record.flow_slug
  AND parent_step.step_type = 'single'  -- Only validate single steps
  AND child_step.step_type = 'map'
  AND child_state.run_id = complete_task.run_id
  AND child_state.initial_tasks IS NULL
  AND (complete_task.output IS NULL OR jsonb_typeof(complete_task.output) != 'array')
LIMIT 1;

-- Handle type violation if detected
IF v_dependent_map_slug IS NOT NULL THEN
  -- Mark run as failed immediately
  UPDATE pgflow.runs
  SET status = 'failed',
      failed_at = now()
  WHERE pgflow.runs.run_id = complete_task.run_id;

  -- Broadcast run:failed event
  -- Uses PERFORM pattern to ensure execution (proven reliable pattern in this function)
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'run:failed',
      'run_id', complete_task.run_id,
      'flow_slug', v_run_record.flow_slug,
      'status', 'failed',
      'failed_at', now()
    ),
    'run:failed',
    concat('pgflow:run:', complete_task.run_id),
    false
  );

  -- Archive all active messages (both queued and started) to prevent orphaned messages
  PERFORM pgmq.archive(
    v_run_record.flow_slug,
    array_agg(st.message_id)
  )
  FROM pgflow.step_tasks st
  WHERE st.run_id = complete_task.run_id
    AND st.status IN ('queued', 'started')
    AND st.message_id IS NOT NULL
  HAVING count(*) > 0;  -- Only call archive if there are messages to archive

  -- Mark current task as failed and store the output
  UPDATE pgflow.step_tasks
  SET status = 'failed',
      failed_at = now(),
      output = complete_task.output,  -- Store the output that caused the violation
      error_message = '[TYPE_VIOLATION] Produced ' ||
                     CASE WHEN complete_task.output IS NULL THEN 'null'
                          ELSE jsonb_typeof(complete_task.output) END ||
                     ' instead of array'
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index;

  -- Mark step state as failed
  UPDATE pgflow.step_states
  SET status = 'failed',
      failed_at = now(),
      error_message = '[TYPE_VIOLATION] Map step ' || v_dependent_map_slug ||
                     ' expects array input but dependency ' || complete_task.step_slug ||
                     ' produced ' || CASE WHEN complete_task.output IS NULL THEN 'null'
                                         ELSE jsonb_typeof(complete_task.output) END
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug;

  -- Broadcast step:failed event
  -- Uses PERFORM pattern to ensure execution (proven reliable pattern in this function)
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'step:failed',
      'run_id', complete_task.run_id,
      'step_slug', complete_task.step_slug,
      'status', 'failed',
      'error_message', '[TYPE_VIOLATION] Map step ' || v_dependent_map_slug ||
                      ' expects array input but dependency ' || complete_task.step_slug ||
                      ' produced ' || CASE WHEN complete_task.output IS NULL THEN 'null'
                                          ELSE jsonb_typeof(complete_task.output) END,
      'failed_at', now()
    ),
    concat('step:', complete_task.step_slug, ':failed'),
    concat('pgflow:run:', complete_task.run_id),
    false
  );

  -- Archive the current task's message (it was started, now failed)
  PERFORM pgmq.archive(
    v_run_record.flow_slug,
    st.message_id  -- Single message, use scalar form
  )
  FROM pgflow.step_tasks st
  WHERE st.run_id = complete_task.run_id
    AND st.step_slug = complete_task.step_slug
    AND st.task_index = complete_task.task_index
    AND st.message_id IS NOT NULL;

  -- Return empty result
  RETURN QUERY SELECT * FROM pgflow.step_tasks WHERE false;
  RETURN;
END IF;

-- ==========================================
-- MAIN CTE CHAIN: Update task and propagate changes
-- ==========================================
WITH
-- ---------- Task completion ----------
-- Update the task record with completion status and output
task AS (
  UPDATE pgflow.step_tasks
  SET
    status = 'completed',
    completed_at = now(),
    output = complete_task.output
  WHERE pgflow.step_tasks.run_id = complete_task.run_id
    AND pgflow.step_tasks.step_slug = complete_task.step_slug
    AND pgflow.step_tasks.task_index = complete_task.task_index
    AND pgflow.step_tasks.status = 'started'
  RETURNING *
),
-- ---------- Step state update ----------
-- Decrement remaining_tasks and potentially mark step as completed
step_state AS (
  UPDATE pgflow.step_states
  SET
    status = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN 'completed'  -- Will be 0 after decrement
    ELSE 'started'
    END,
    completed_at = CASE
    WHEN pgflow.step_states.remaining_tasks = 1 THEN now()  -- Will be 0 after decrement
    ELSE NULL
    END,
    remaining_tasks = pgflow.step_states.remaining_tasks - 1
  FROM task
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug = complete_task.step_slug
  RETURNING pgflow.step_states.*
),
-- ---------- Dependency resolution ----------
-- Find all child steps that depend on the completed parent step (only if parent completed)
child_steps AS (
  SELECT deps.step_slug AS child_step_slug
  FROM pgflow.deps deps
  JOIN step_state parent_state ON parent_state.status = 'completed' AND deps.flow_slug = parent_state.flow_slug
  WHERE deps.dep_slug = complete_task.step_slug  -- dep_slug is the parent, step_slug is the child
  ORDER BY deps.step_slug  -- Ensure consistent ordering
),
-- ---------- Lock child steps ----------
-- Acquire locks on all child steps before updating them
child_steps_lock AS (
  SELECT * FROM pgflow.step_states
  WHERE pgflow.step_states.run_id = complete_task.run_id
    AND pgflow.step_states.step_slug IN (SELECT child_step_slug FROM child_steps)
  FOR UPDATE
),
-- ---------- Update child steps ----------
-- Decrement remaining_deps and resolve NULL initial_tasks for map steps
child_steps_update AS (
  UPDATE pgflow.step_states child_state
  SET remaining_deps = child_state.remaining_deps - 1,
      -- Resolve NULL initial_tasks for child map steps
      -- This is where child maps learn their array size from the parent
      -- This CTE only runs when the parent step is complete (see child_steps JOIN)
      initial_tasks = CASE
        WHEN child_step.step_type = 'map' AND child_state.initial_tasks IS NULL THEN
          CASE
            WHEN parent_step.step_type = 'map' THEN
              -- Map->map: Count all completed tasks from parent map
              -- We add 1 because the current task is being completed in this transaction
              -- but isn't yet visible as 'completed' in the step_tasks table
              -- TODO: Refactor to use future column step_states.total_tasks
              -- Would eliminate the COUNT query and just use parent_state.total_tasks
              (SELECT COUNT(*)::int + 1
               FROM pgflow.step_tasks parent_tasks
               WHERE parent_tasks.run_id = complete_task.run_id
                 AND parent_tasks.step_slug = complete_task.step_slug
                 AND parent_tasks.status = 'completed'
                 AND parent_tasks.task_index != complete_task.task_index)
            ELSE
              -- Single->map: Use output array length (single steps complete immediately)
              CASE
                WHEN complete_task.output IS NOT NULL
                     AND jsonb_typeof(complete_task.output) = 'array' THEN
                  jsonb_array_length(complete_task.output)
                ELSE NULL  -- Keep NULL if not an array
              END
          END
        ELSE child_state.initial_tasks  -- Keep existing value (including NULL)
      END
  FROM child_steps children
  JOIN pgflow.steps child_step ON child_step.flow_slug = (SELECT r.flow_slug FROM pgflow.runs r WHERE r.run_id = complete_task.run_id)
                               AND child_step.step_slug = children.child_step_slug
  JOIN pgflow.steps parent_step ON parent_step.flow_slug = (SELECT r.flow_slug FROM pgflow.runs r WHERE r.run_id = complete_task.run_id)
                                AND parent_step.step_slug = complete_task.step_slug
  WHERE child_state.run_id = complete_task.run_id
    AND child_state.step_slug = children.child_step_slug
)
-- ---------- Update run remaining_steps ----------
-- Decrement the run's remaining_steps counter if step completed
UPDATE pgflow.runs
SET remaining_steps = pgflow.runs.remaining_steps - 1
FROM step_state
WHERE pgflow.runs.run_id = complete_task.run_id
  AND step_state.status = 'completed';

-- ==========================================
-- POST-COMPLETION ACTIONS
-- ==========================================

-- ---------- Get updated state for broadcasting ----------
SELECT * INTO v_step_state FROM pgflow.step_states
WHERE pgflow.step_states.run_id = complete_task.run_id AND pgflow.step_states.step_slug = complete_task.step_slug;

-- ---------- Handle step completion ----------
IF v_step_state.status = 'completed' THEN
  -- Broadcast step:completed event FIRST (before cascade)
  -- This ensures parent broadcasts before its dependent children
  -- For map steps, aggregate all task outputs; for single steps, use the task output
  PERFORM realtime.send(
    jsonb_build_object(
      'event_type', 'step:completed',
      'run_id', complete_task.run_id,
      'step_slug', complete_task.step_slug,
      'status', 'completed',
      'output', CASE
        WHEN (SELECT s.step_type FROM pgflow.steps s
              WHERE s.flow_slug = v_step_state.flow_slug
                AND s.step_slug = complete_task.step_slug) = 'map' THEN
          -- Aggregate all task outputs for map steps
          (SELECT COALESCE(jsonb_agg(st.output ORDER BY st.task_index), '[]'::jsonb)
           FROM pgflow.step_tasks st
           WHERE st.run_id = complete_task.run_id
             AND st.step_slug = complete_task.step_slug
             AND st.status = 'completed')
        ELSE
          -- Single step: use the individual task output
          complete_task.output
      END,
      'completed_at', v_step_state.completed_at
    ),
    concat('step:', complete_task.step_slug, ':completed'),
    concat('pgflow:run:', complete_task.run_id),
    false
  );

  -- THEN cascade complete any taskless steps that are now ready
  -- This ensures dependent children broadcast AFTER their parent
  PERFORM pgflow.cascade_complete_taskless_steps(complete_task.run_id);
END IF;

-- ---------- Archive completed task message ----------
-- Move message from active queue to archive table
PERFORM (
  WITH completed_tasks AS (
    SELECT r.flow_slug, st.message_id
    FROM pgflow.step_tasks st
    JOIN pgflow.runs r ON st.run_id = r.run_id
    WHERE st.run_id = complete_task.run_id
      AND st.step_slug = complete_task.step_slug
      AND st.task_index = complete_task.task_index
      AND st.status = 'completed'
  )
  SELECT pgmq.archive(ct.flow_slug, ct.message_id)
  FROM completed_tasks ct
  WHERE EXISTS (SELECT 1 FROM completed_tasks)
);

-- ---------- Trigger next steps ----------
-- Start any steps that are now ready (deps satisfied)
PERFORM pgflow.start_ready_steps(complete_task.run_id);

-- Check if the entire run is complete
PERFORM pgflow.maybe_complete_run(complete_task.run_id);

-- ---------- Return completed task ----------
RETURN QUERY SELECT *
FROM pgflow.step_tasks AS step_task
WHERE step_task.run_id = complete_task.run_id
  AND step_task.step_slug = complete_task.step_slug
  AND step_task.task_index = complete_task.task_index;

end;
$$;