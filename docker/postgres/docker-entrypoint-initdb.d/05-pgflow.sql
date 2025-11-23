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
-- VERSION: v0.7.2 (Phases 1-3)
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
-- LIMITATIONS (v0.7.2 Phases 1-3 only):
--   ✗ Map steps for parallel array processing (Phases 9-11)
--   ✗ opt_start_delay parameter (Phase 7)
--   ✗ Real-time event broadcasting (Supabase-specific, stubbed as no-op)
--   ✗ Row Level Security / auth.users integration (Supabase-specific)
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
-- KNOWN LIMITATION: PHASE 4-11 migrations are truncated
-- ============================================================================
--
-- This file contains only Phases 1-3 of the pgflow v0.7.2 schema.
-- The following enhancements from Phases 4-11 are NOT included:
--
--   - set_vt_batch optimization (Phase 4)
--   - Realtime event broadcasting (Phase 5, stubbed for standalone PostgreSQL)
--   - Function search_path fixes (Phase 6)
--   - opt_start_delay support (Phase 7)
--   - Worker deprecation (stopped_at -> deprecated_at) (Phase 8)
--   - Map step type support for parallel array processing (Phases 9-11)
--
-- IMPACT:
--   - Core workflow functionality works (DAG execution, retries, task queuing)
--   - Advanced features (map steps, opt_start_delay) are unavailable
--   - Production use requires testing specific to your workflows
--
-- TO GET COMPLETE SCHEMA:
--   1. Visit: https://github.com/pgflow-dev/pgflow
--   2. Navigate to pkgs/core/ directory
--   3. Review migrations or install via npm: @pgflow/core@0.7.2
--   4. Run additional migrations manually if needed
--
-- ALTERNATIVE:
--   If you need the complete schema, replace this file with the full
--   pgflow-schema-v0.7.2.sql from the upstream repository.
--
-- ============================================================================