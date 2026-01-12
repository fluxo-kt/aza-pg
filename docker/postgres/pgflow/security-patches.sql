-- pgflow v0.13.1 Security Patches
-- Applied after 05-pgflow-init.sh loads upstream schema
--
-- Patches applied:
-- 1. CVE-PGFLOW-001: Add SET search_path to get_run_with_states
-- 2. CVE-PGFLOW-002: Add SET search_path to start_flow_with_states
--
-- Upstream tracking:
-- - Issue: https://github.com/pgflow-dev/pgflow/issues/XXX (to be filed)
-- - Status: Pending upstream fix
-- - Local patch required until upstream resolves
--
-- Security context:
-- SECURITY DEFINER functions without SET search_path are vulnerable to
-- search_path hijacking attacks where malicious schemas/functions can be
-- called with elevated privileges. Both functions resolve PostgreSQL
-- built-ins (jsonb_build_object, jsonb_agg, COALESCE) which could be
-- overridden by attacker-controlled schemas in the search_path.
-- Patch 1: pgflow.get_run_with_states
CREATE OR REPLACE FUNCTION pgflow.get_run_with_states (run_id UUID) RETURNS JSONB LANGUAGE sql SECURITY DEFINER
SET
  search_path = '' -- SECURITY FIX: Prevent search_path hijacking
  AS $$
  SELECT jsonb_build_object(
    'run', to_jsonb(r),
    'steps', COALESCE(jsonb_agg(to_jsonb(s)) FILTER (WHERE s.run_id IS NOT NULL), '[]'::jsonb)
  )
  FROM pgflow.runs r
  LEFT JOIN pgflow.step_states s ON s.run_id = r.run_id
  WHERE r.run_id = get_run_with_states.run_id
  GROUP BY r.run_id;
$$;


-- Patch 2: pgflow.start_flow_with_states
CREATE OR REPLACE FUNCTION pgflow.start_flow_with_states (flow_slug TEXT, input JSONB, run_id UUID DEFAULT NULL) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' -- SECURITY FIX: Prevent search_path hijacking
  AS $$
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


COMMENT ON FUNCTION pgflow.get_run_with_states IS 'Patched: Added SET search_path for CVE-PGFLOW-001';


COMMENT ON FUNCTION pgflow.start_flow_with_states IS 'Patched: Added SET search_path for CVE-PGFLOW-002';