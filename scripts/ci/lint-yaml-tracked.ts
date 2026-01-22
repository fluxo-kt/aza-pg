#!/usr/bin/env bun
/**
 * Lint all tracked YAML files in the repository.
 *
 * Workflows are linted with a workflow-specific yamllint config where
 * line-length is disabled to avoid noisy false positives for long
 * GitHub Actions expressions and shell snippets.
 */

import path from "node:path";
import { getErrorMessage } from "../utils/errors";
import { error, info, section, success } from "../utils/logger";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const WORKFLOW_PREFIX = ".github/workflows/";
const RELAXED_LINE_LENGTH_FILES = new Set([
  "deployments/phase1-single-vps/prometheus/postgres_exporter_queries.yaml",
]);

function normalizePaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("node_modules/"))
    .filter((line) => !line.startsWith(".git/"))
    .filter((line) => !line.startsWith(".archived/"));
}

async function listTrackedYamlFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "*.yml", "*.yaml"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ls-files failed: ${stderr || "unknown error"}`);
  }

  return normalizePaths(stdout);
}

async function runYamllint(configPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;

  const command = [
    "docker",
    "run",
    "--rm",
    "-v",
    `${REPO_ROOT}:/work:ro`,
    "-w",
    "/work",
    "cytopia/yamllint",
    "-c",
    configPath,
    ...files,
  ];

  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`yamllint failed with exit code ${exitCode} (config: ${configPath})`);
  }
}

async function main(): Promise<void> {
  section("YAML Lint (Tracked Files)");
  info("Discovering tracked YAML files...");

  const trackedYaml = await listTrackedYamlFiles();
  if (trackedYaml.length === 0) {
    info("No tracked YAML files found");
    return;
  }

  const workflowFiles = trackedYaml.filter((file) => file.startsWith(WORKFLOW_PREFIX));
  const relaxedLineLengthFiles = trackedYaml.filter((file) => RELAXED_LINE_LENGTH_FILES.has(file));
  const strictFiles = trackedYaml.filter(
    (file) => !file.startsWith(WORKFLOW_PREFIX) && !RELAXED_LINE_LENGTH_FILES.has(file)
  );

  info(
    `Linting ${trackedYaml.length} tracked YAML files (${strictFiles.length} strict, ${workflowFiles.length} workflows, ${relaxedLineLengthFiles.length} relaxed-line-length)`
  );

  await runYamllint("/work/.yamllint", strictFiles);
  await runYamllint("/work/.yamllint-workflows", relaxedLineLengthFiles);
  await runYamllint("/work/.yamllint-workflows", workflowFiles);

  success("All tracked YAML files passed lint checks");
}

main().catch((err: unknown) => {
  error(`YAML lint failed: ${getErrorMessage(err)}`);
  process.exit(1);
});
