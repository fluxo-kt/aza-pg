#!/usr/bin/env bun
/**
 * Validate local GitHub Action metadata files under .github/actions.
 *
 * Why this exists:
 * - actionlint validates workflow syntax/expressions.
 * - actionlint does not deeply validate composite action internals.
 * - This script closes that gap for local action metadata and local action wiring.
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { getErrorMessage } from "../utils/errors";
import { error, info, section, success, warning } from "../utils/logger";

type ValidationIssue = {
  file: string;
  message: string;
};

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const ACTIONS_ROOT = path.join(REPO_ROOT, ".github/actions");

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const fileStat = await stat(targetPath);
    return fileStat.isDirectory();
  } catch {
    return false;
  }
}

async function resolveActionMetadataFile(actionDir: string): Promise<string | null> {
  const yamlPath = path.join(actionDir, "action.yaml");
  const ymlPath = path.join(actionDir, "action.yml");

  if (await pathExists(ymlPath)) return ymlPath;
  if (await pathExists(yamlPath)) return yamlPath;
  return null;
}

async function checkLocalActionReference(
  actionFilePath: string,
  actionDir: string,
  usesValue: string,
  errors: ValidationIssue[]
): Promise<void> {
  const candidates = [path.resolve(REPO_ROOT, usesValue), path.resolve(actionDir, usesValue)];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      const metadata = await resolveActionMetadataFile(candidate);
      if (metadata) return;
    } else if (await pathExists(candidate)) {
      return;
    }
  }

  errors.push({
    file: actionFilePath,
    message: `local action reference "${usesValue}" does not resolve to a valid action.yml/action.yaml`,
  });
}

async function validateActionFile(actionFilePath: string): Promise<{
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const actionDir = path.dirname(actionFilePath);

  const content = await Bun.file(actionFilePath).text();
  const doc = parseDocument(content);

  if (doc.errors.length > 0) {
    for (const parseError of doc.errors) {
      errors.push({
        file: actionFilePath,
        message: `YAML parse error: ${String(parseError.message)}`,
      });
    }
    return { errors, warnings };
  }

  const metadata = doc.toJS() as Record<string, unknown> | null;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    errors.push({
      file: actionFilePath,
      message: "action metadata must be a YAML mapping",
    });
    return { errors, warnings };
  }

  for (const requiredKey of ["name", "description", "runs"] as const) {
    if (!(requiredKey in metadata)) {
      errors.push({
        file: actionFilePath,
        message: `missing required top-level key "${requiredKey}"`,
      });
    }
  }

  const runs = metadata.runs;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) {
    errors.push({
      file: actionFilePath,
      message: '"runs" must be a mapping',
    });
    return { errors, warnings };
  }

  const using = (runs as Record<string, unknown>).using;
  if (typeof using !== "string") {
    errors.push({
      file: actionFilePath,
      message: '"runs.using" must be a string',
    });
    return { errors, warnings };
  }

  const allowedUsing = new Set(["composite", "docker", "node20", "node24"]);
  if (!allowedUsing.has(using)) {
    errors.push({
      file: actionFilePath,
      message: `"runs.using" has unsupported value "${using}"`,
    });
    return { errors, warnings };
  }

  if (using !== "composite") {
    return { errors, warnings };
  }

  const steps = (runs as Record<string, unknown>).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push({
      file: actionFilePath,
      message: 'composite action must define a non-empty "runs.steps" array',
    });
    return { errors, warnings };
  }

  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      errors.push({
        file: actionFilePath,
        message: `step #${index + 1} must be a mapping`,
      });
      continue;
    }

    const stepRecord = step as Record<string, unknown>;
    const hasRun = typeof stepRecord.run === "string" && stepRecord.run.length > 0;
    const hasUses = typeof stepRecord.uses === "string" && stepRecord.uses.length > 0;

    if (!hasRun && !hasUses) {
      errors.push({
        file: actionFilePath,
        message: `step #${index + 1} must define either "run" or "uses"`,
      });
      continue;
    }

    if (hasRun && hasUses) {
      errors.push({
        file: actionFilePath,
        message: `step #${index + 1} cannot define both "run" and "uses"`,
      });
      continue;
    }

    if (hasRun && typeof stepRecord.shell !== "string") {
      errors.push({
        file: actionFilePath,
        message: `step #${index + 1} with "run" must define "shell"`,
      });
      continue;
    }

    if (hasUses) {
      const usesValue = String(stepRecord.uses);
      if (usesValue.startsWith("./")) {
        await checkLocalActionReference(actionFilePath, actionDir, usesValue, errors);
      }
    }
  }

  return { errors, warnings };
}

async function findActionFiles(): Promise<string[]> {
  const entries = await readdir(ACTIONS_ROOT, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const actionDir = path.join(ACTIONS_ROOT, entry.name);
    const metadata = await resolveActionMetadataFile(actionDir);
    if (!metadata) {
      files.push(path.join(actionDir, "action.yml"));
      continue;
    }
    files.push(metadata);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  section("Local GitHub Actions Validation");
  info(`Scanning local actions at ${ACTIONS_ROOT}`);

  const actionFiles = await findActionFiles();
  const allErrors: ValidationIssue[] = [];
  const allWarnings: ValidationIssue[] = [];

  if (actionFiles.length === 0) {
    warning("No local actions found under .github/actions");
    return;
  }

  info(`Found ${actionFiles.length} action metadata file(s)`);

  for (const actionFilePath of actionFiles) {
    if (!(await pathExists(actionFilePath))) {
      allErrors.push({
        file: actionFilePath,
        message: "missing action metadata file (expected action.yml or action.yaml)",
      });
      continue;
    }

    const { errors, warnings } = await validateActionFile(actionFilePath);
    allErrors.push(...errors);
    allWarnings.push(...warnings);
  }

  for (const issue of allWarnings) {
    warning(`${path.relative(REPO_ROOT, issue.file)}: ${issue.message}`);
  }

  if (allErrors.length > 0) {
    for (const issue of allErrors) {
      error(`${path.relative(REPO_ROOT, issue.file)}: ${issue.message}`);
    }
    throw new Error(`Local action metadata validation failed (${allErrors.length} error(s))`);
  }

  success(`All ${actionFiles.length} local action metadata file(s) are valid`);
}

main().catch((err: unknown) => {
  error(`Validation failed: ${getErrorMessage(err)}`);
  process.exit(1);
});
