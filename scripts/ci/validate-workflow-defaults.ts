#!/usr/bin/env bun
/**
 * Validate Workflow Defaults
 *
 * Ensures workflow input defaults in build-postgres-image.yml match
 * extension-defaults.ts to prevent version staleness and drift.
 *
 * Usage:
 *   bun scripts/ci/validate-workflow-defaults.ts
 *
 * Exit codes:
 *   0 - All defaults match
 *   1 - Validation failed (mismatches found)
 */

import { resolve } from "node:path";
import { extensionDefaults, extractSemanticVersion } from "../extension-defaults.ts";

interface ValidationResult {
  field: string;
  workflowValue: string | null;
  expectedValue: string;
  matches: boolean;
}

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function info(msg: string) {
  console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`);
}

function success(msg: string) {
  console.log(`${colors.green}✅ ${msg}${colors.reset}`);
}

function error(msg: string) {
  console.log(`${colors.red}❌ ${msg}${colors.reset}`);
}

async function main() {
  console.log("");
  console.log("============================================================");
  console.log("  Workflow Defaults Validation");
  console.log("============================================================");

  const workflowPath = resolve(import.meta.dir, "../../.github/workflows/build-postgres-image.yml");

  if (!(await Bun.file(workflowPath).exists())) {
    error(`Workflow file not found: ${workflowPath}`);
    process.exit(1);
  }

  info("Reading workflow file...");
  const workflowContent = await Bun.file(workflowPath).text();

  info("Extracting workflow input defaults...");

  const tracksVersionInputs =
    /\n\s+pg_version:\s*\n/.test(workflowContent) ||
    /\n\s+pgvector_version:\s*\n/.test(workflowContent) ||
    /\n\s+pg_cron_version:\s*\n/.test(workflowContent) ||
    /\n\s+pgaudit_version:\s*\n/.test(workflowContent);

  if (!tracksVersionInputs) {
    info("Workflow no longer defines version override defaults in workflow_dispatch inputs.");
    info("Version sources are managed from manifest data and generated defaults.");
    success("No workflow version defaults to validate.");
    console.log("");
    process.exit(0);
  }

  // Extract defaults from workflow YAML
  // Format: default: "0.8.1"
  const pgVersionMatch = workflowContent.match(/pg_version:[\s\S]*?default:\s*["']?(\d+)["']?/);
  const pgvectorMatch = workflowContent.match(
    /pgvector_version:[\s\S]*?default:\s*["']?([\d.]+)["']?/
  );
  const pgCronMatch = workflowContent.match(
    /pg_cron_version:[\s\S]*?default:\s*["']?([\d.]+)["']?/
  );
  const pgauditMatch = workflowContent.match(
    /pgaudit_version:[\s\S]*?default:\s*["']?([\d.]+)["']?/
  );

  // Extract expected values from extension-defaults.ts
  const expectedPgVersion: string = extensionDefaults.pgVersion.split(".")[0]!; // "18.1" → "18"
  const expectedPgvector: string = extractSemanticVersion(extensionDefaults.pgdgVersions.pgvector);
  const expectedPgCron: string = extractSemanticVersion(extensionDefaults.pgdgVersions.pgcron);
  const expectedPgaudit: string = extractSemanticVersion(extensionDefaults.pgdgVersions.pgaudit);

  const results: ValidationResult[] = [
    {
      field: "pg_version",
      workflowValue: pgVersionMatch?.[1] ?? null,
      expectedValue: expectedPgVersion,
      matches: pgVersionMatch?.[1] === expectedPgVersion,
    },
    {
      field: "pgvector_version",
      workflowValue: pgvectorMatch?.[1] ?? null,
      expectedValue: expectedPgvector,
      matches: pgvectorMatch?.[1] === expectedPgvector,
    },
    {
      field: "pg_cron_version",
      workflowValue: pgCronMatch?.[1] ?? null,
      expectedValue: expectedPgCron,
      matches: pgCronMatch?.[1] === expectedPgCron,
    },
    {
      field: "pgaudit_version",
      workflowValue: pgauditMatch?.[1] ?? null,
      expectedValue: expectedPgaudit,
      matches: pgauditMatch?.[1] === expectedPgaudit,
    },
  ];

  console.log("");
  info("Validation Results:");
  console.log("");

  let allMatch = true;
  for (const result of results) {
    if (result.matches) {
      console.log(
        `${colors.green}✓${colors.reset} ${result.field.padEnd(20)} ${colors.cyan}${result.workflowValue}${colors.reset} (matches)`
      );
    } else {
      allMatch = false;
      console.log(
        `${colors.red}✗${colors.reset} ${result.field.padEnd(20)} ` +
          `workflow: ${colors.yellow}${result.workflowValue ?? "NOT FOUND"}${colors.reset}, ` +
          `expected: ${colors.green}${result.expectedValue}${colors.reset}`
      );
    }
  }

  console.log("");

  if (allMatch) {
    success("All workflow defaults match extension-defaults.ts!");
    console.log("");
    process.exit(0);
  } else {
    error("Workflow defaults are out of sync with extension-defaults.ts");
    console.log("");
    console.log(`${colors.cyan}To fix:${colors.reset}`);
    console.log(`1. Update .github/workflows/build-postgres-image.yml defaults`);
    console.log(`2. Ensure they match scripts/extension-defaults.ts semantic versions`);
    console.log(`3. Run this script again to verify`);
    console.log("");
    process.exit(1);
  }
}

main();
