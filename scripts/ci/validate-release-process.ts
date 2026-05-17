#!/usr/bin/env bun
/**
 * Validates release-process contracts that normal workflow linters cannot see.
 */

import path from "node:path";
import { parseDocument } from "yaml";
import { error, section, success } from "../utils/logger";

type Issue = {
  file: string;
  message: string;
};

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

async function readText(relativePath: string): Promise<string> {
  return Bun.file(path.join(REPO_ROOT, relativePath)).text();
}

async function readYaml(relativePath: string): Promise<Record<string, unknown>> {
  const doc = parseDocument(await readText(relativePath));
  if (doc.errors.length > 0) {
    throw new Error(`${relativePath}: YAML parse error: ${doc.errors[0]?.message ?? "unknown"}`);
  }

  const data = asRecord(doc.toJS());
  if (!data) {
    throw new Error(`${relativePath}: YAML root must be a mapping`);
  }

  return data;
}

function addIssue(issues: Issue[], file: string, message: string): void {
  issues.push({ file, message });
}

async function validateReleaseCommand(issues: Issue[]): Promise<void> {
  const file = ".claude/commands/release.md";
  const text = await readText(file);

  if (!text.includes("git merge --squash refs/heads/dev")) {
    addIssue(issues, file, "Phase 4.1 must squash refs/heads/dev, not a bare dev ref");
  }

  const staleBareMergeLine = text
    .split("\n")
    .some((line) => line.trim() === "if ! git merge --squash dev; then");
  if (staleBareMergeLine) {
    addIssue(issues, file, "bare `git merge --squash dev` is forbidden by the command guardrails");
  }
}

async function validatePublishEnvironment(issues: Issue[]): Promise<void> {
  const file = ".github/workflows/publish.yml";
  const workflow = await readYaml(file);
  const jobs = asRecord(workflow.jobs);
  const releaseJob = asRecord(jobs?.release);
  const environment = releaseJob?.environment;

  if (environment !== undefined) {
    addIssue(
      issues,
      file,
      "publish release job must not add a GitHub Environment gate without an explicit release-contract change"
    );
  }
}

async function validatePublishVerificationTopology(issues: Issue[]): Promise<void> {
  const file = ".github/workflows/publish.yml";
  const workflow = await readYaml(file);
  const jobs = asRecord(workflow.jobs);
  const verifyPublicRelease = asRecord(jobs?.["verify-public-release"]);
  if (!verifyPublicRelease) {
    addIssue(
      issues,
      file,
      "publish workflow must verify public release artifacts after GitHub Release creation"
    );
  }

  const cleanup = asRecord(jobs?.cleanup);
  const cleanupNeeds = asStringArray(cleanup?.needs);
  if (!cleanupNeeds.includes("verify-public-release")) {
    addIssue(
      issues,
      file,
      "cleanup must wait for verify-public-release so public verification failures stay visible"
    );
  }
}

async function validateEnvironmentDocs(issues: Issue[]): Promise<void> {
  const files = ["docs/BUILD.md", "docs/GITHUB_ENVIRONMENT_SETUP.md"];

  for (const file of files) {
    const text = await readText(file);
    if (/requires? .*manual approval/i.test(text)) {
      addIssue(
        issues,
        file,
        "manual approval must not be documented as unconditional; it exists only when required reviewers are configured"
      );
    }
  }
}

async function validateReleasedImageHarness(issues: Issue[]): Promise<void> {
  const file = "scripts/test/test-released-image.ts";
  const text = await readText(file);

  const forbiddenPatterns = [
    '["bun", "scripts/test/test-pgbouncer-healthcheck.ts", imageTag]',
    '["bun", "scripts/test/test-pgbouncer-failures.ts", imageTag]',
    "phase9NegativeScenarios(fastMode)",
  ];

  for (const pattern of forbiddenPatterns) {
    if (text.includes(pattern)) {
      addIssue(issues, file, `released-image harness must not contain stale pattern: ${pattern}`);
    }
  }
}

async function validateForbiddenBunX(issues: Issue[]): Promise<void> {
  const file = "scripts/test-all.ts";
  const text = await readText(file);
  if (text.includes('"bun", "x"') || text.includes("bun x")) {
    addIssue(issues, file, "`bun x` is forbidden; use package scripts via bun run");
  }
}

async function main(): Promise<void> {
  section("Release Process Validation");

  const issues: Issue[] = [];
  await validateReleaseCommand(issues);
  await validatePublishEnvironment(issues);
  await validatePublishVerificationTopology(issues);
  await validateEnvironmentDocs(issues);
  await validateReleasedImageHarness(issues);
  await validateForbiddenBunX(issues);

  if (issues.length > 0) {
    for (const issue of issues) {
      error(`${issue.file}: ${issue.message}`);
    }
    throw new Error(`Release process validation failed (${issues.length} issue(s))`);
  }

  success("Release process contracts validated");
}

if (import.meta.main) {
  await main();
}
