-- pgflow v0.13.1 Security Patches
-- Applied after 05-pgflow-init.sh loads upstream schema
--
-- Patches applied:
-- 1. AZA-PGFLOW-001: Add SET search_path to get_run_with_states
-- 2. AZA-PGFLOW-002: Add SET search_path to start_flow_with_states
-- 3. COMPAT-AZA-PG-001: Fix is_local() for non-Supabase installations
--
-- Upstream tracking:
-- - Issue: https://github.com/pgflow-dev/pgflow/issues/XXX
-- TODO: File upstream issue and replace XXX with actual issue number
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


COMMENT ON FUNCTION pgflow.get_run_with_states IS 'Patched: Added SET search_path for AZA-PGFLOW-001';


COMMENT ON FUNCTION pgflow.start_flow_with_states IS 'Patched: Added SET search_path for AZA-PGFLOW-002';


-- Patch 3: pgflow.is_local() - Fix for non-Supabase installations
-- Context: pgflow designed for Supabase, uses app.settings.supabase_url to detect local environment
-- Problem: aza-pg is a custom Postgres build (not Supabase), this setting is never set
-- Solution: Detect custom installation by checking for aza-pg marker setting
CREATE OR REPLACE FUNCTION pgflow.is_local () RETURNS BOOLEAN LANGUAGE sql STABLE PARALLEL SAFE
SET
  search_path = '' AS $$
  -- For aza-pg custom installations:
  -- We consider it "local" if running in a custom/non-Supabase environment
  -- Detection: Check if we're NOT in Supabase by looking for custom installation marker
  SELECT (current_setting('app.aza_pg_custom', true) = 'true')
      OR (current_setting('app.settings.supabase_url', true) IS NULL)
$$;


COMMENT ON FUNCTION pgflow.is_local IS 'Patched: Detect aza-pg custom installation (non-Supabase) - COMPAT-AZA-PG-001';