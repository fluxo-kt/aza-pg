/**
 * PostgreSQL Regression Test Groups
 *
 * Classifies tests by their dependencies:
 * - Self-contained: Create their own test data inline, no setup required
 * - Minimal setup: Need tables created by minimal_setup.sql (INSERT-only)
 * - Full setup: Need test_setup.sql with PostgreSQL data files (COPY)
 */

/**
 * Self-contained tests that create their own test data inline.
 * These tests require NO setup script.
 */
export const SELF_CONTAINED_TESTS = [
  "boolean", // Creates BOOLTBL1, BOOLTBL2, BOOLTBL3, booltbl4 inline
  "strings", // Tests string literals inline
  "float4", // Creates FLOAT4_TBL inline
  "numeric", // Creates num_data, num_exp_* tables inline
  "numerology", // Tests numeric literals inline
  "json", // Tests JSON parsing inline
] as const;

/**
 * Tests that need minimal_setup.sql (INSERT-based tables).
 * minimal_setup.sql creates: CHAR_TBL, FLOAT8_TBL, INT2_TBL, INT4_TBL,
 * INT8_TBL, POINT_TBL, TEXT_TBL, VARCHAR_TBL using INSERT statements only.
 */
export const MINIMAL_SETUP_TESTS = [
  "int2", // Uses INT2_TBL
  "int4", // Uses INT4_TBL
  "int8", // Uses INT8_TBL
  "float8", // Uses FLOAT8_TBL
  "text", // Uses TEXT_TBL
  "varchar", // Uses VARCHAR_TBL
] as const;

/**
 * Tests that need full test_setup.sql with PostgreSQL data files.
 * These tests use tables populated via COPY from:
 * - onek.data, tenk.data (onek, tenk1, tenk2 tables)
 * - person.data, emp.data, student.data, stud_emp.data (inheritance tests)
 * - streets.data (road table)
 * - array.data, jsonb.data (specific test data)
 */
export const FULL_SETUP_TESTS = [
  // Core operations (need onek/tenk tables)
  "select", // Uses onek
  "insert", // Uses onek
  "update", // Uses onek
  "delete", // Uses onek
  "join", // Uses onek, tenk1
  "union", // Uses onek, tenk1
  "subselect", // Uses onek, tenk1

  // Essential features
  "constraints", // Uses various tables
  "triggers", // Uses emp, stud_emp (inheritance tables)
  "create_index", // Uses onek, tenk1
  "create_table", // Uses various tables
  "transactions", // Uses onek
  "aggregates", // Uses onek, tenk1
  "copy", // Tests COPY command (needs data files)
  "prepare", // Uses onek

  // Advanced features
  "jsonb", // Uses jsonb.data file
  "arrays", // Uses array.data file
  "btree_index", // Uses onek, tenk1
] as const;

/**
 * Required PostgreSQL data files for full setup tests.
 * Downloaded from postgres/postgres repository REL_18_STABLE branch.
 */
export const PG_DATA_FILES = [
  "onek.data", // 1000 rows for onek table
  "tenk.data", // 10000 rows for tenk1 table
  "person.data", // Person table data
  "emp.data", // Employee table data (inherits person)
  "student.data", // Student table data (inherits person)
  "stud_emp.data", // Student employee data (inherits emp, student)
  "streets.data", // Road/street data
  "array.data", // Array test data
  "jsonb.data", // JSONB test data
] as const;

export type SelfContainedTest = (typeof SELF_CONTAINED_TESTS)[number];
export type MinimalSetupTest = (typeof MINIMAL_SETUP_TESTS)[number];
export type FullSetupTest = (typeof FULL_SETUP_TESTS)[number];
export type DataFile = (typeof PG_DATA_FILES)[number];

/**
 * Test group for CI fast mode (8 tests total).
 * Uses self-contained tests + tests that work with minimal_setup.sql
 */
export const CI_FAST_TESTS = [...SELF_CONTAINED_TESTS, ...MINIMAL_SETUP_TESTS] as const;

/**
 * All tests for full regression (30 tests total).
 */
export const ALL_TESTS = [
  ...SELF_CONTAINED_TESTS,
  ...MINIMAL_SETUP_TESTS,
  ...FULL_SETUP_TESTS,
] as const;

/**
 * Determines the setup required for a given test.
 */
export function getTestSetupRequirement(testName: string): "none" | "minimal" | "full" {
  if ((SELF_CONTAINED_TESTS as readonly string[]).includes(testName)) {
    return "none";
  }
  if ((MINIMAL_SETUP_TESTS as readonly string[]).includes(testName)) {
    return "minimal";
  }
  if ((FULL_SETUP_TESTS as readonly string[]).includes(testName)) {
    return "full";
  }
  // Unknown test - assume full setup for safety
  return "full";
}

/**
 * Groups tests by their setup requirement.
 */
export function groupTestsBySetup(tests: string[]): {
  selfContained: string[];
  minimalSetup: string[];
  fullSetup: string[];
} {
  const result = {
    selfContained: [] as string[],
    minimalSetup: [] as string[],
    fullSetup: [] as string[],
  };

  for (const test of tests) {
    const req = getTestSetupRequirement(test);
    switch (req) {
      case "none":
        result.selfContained.push(test);
        break;
      case "minimal":
        result.minimalSetup.push(test);
        break;
      case "full":
        result.fullSetup.push(test);
        break;
    }
  }

  return result;
}

/**
 * Check if any test in the list requires minimal setup.
 */
export function requiresMinimalSetup(tests: string[]): boolean {
  return tests.some(
    (t) =>
      (MINIMAL_SETUP_TESTS as readonly string[]).includes(t) ||
      (FULL_SETUP_TESTS as readonly string[]).includes(t)
  );
}

/**
 * Check if any test in the list requires full setup.
 */
export function requiresFullSetup(tests: string[]): boolean {
  return tests.some((t) => (FULL_SETUP_TESTS as readonly string[]).includes(t));
}
