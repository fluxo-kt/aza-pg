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

function collectRunSteps(value: unknown, runs: string[] = []): string[] {
  const record = asRecord(value);
  if (record) {
    if (typeof record.run === "string") {
      runs.push(record.run);
    }
    for (const child of Object.values(record)) {
      collectRunSteps(child, runs);
    }
    return runs;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      collectRunSteps(child, runs);
    }
  }

  return runs;
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

function collectLongFlags(text: string): Set<string> {
  const flags = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)(--[a-z0-9-]+)(?=\s|$)/gm)) {
    const flag = match[1];
    if (flag) flags.add(flag);
  }
  return flags;
}

function collectCliSwitchCases(text: string): Set<string> {
  const flags = new Set<string>();
  for (const match of text.matchAll(/case\s+"(--[a-z0-9-]+)":/g)) {
    const flag = match[1];
    if (flag) flags.add(flag);
  }
  return flags;
}

async function validateManifestCliContract(issues: Issue[]): Promise<void> {
  const workflowFile = ".github/workflows/publish.yml";
  const workflow = await readYaml(workflowFile);
  const validateManifestSource = await readText("scripts/docker/validate-manifest.ts");
  const metadataSource = await readText("scripts/utils/oci-metadata.ts");

  const supportedFlags = collectCliSwitchCases(validateManifestSource);
  for (const flag of collectCliSwitchCases(metadataSource)) {
    supportedFlags.add(flag);
  }

  const runSteps = collectRunSteps(workflow);
  for (const runStep of runSteps) {
    if (!runStep.includes("bun scripts/docker/validate-manifest.ts")) continue;

    for (const flag of collectLongFlags(runStep)) {
      if (!supportedFlags.has(flag)) {
        addIssue(
          issues,
          workflowFile,
          `validate-manifest workflow call uses unsupported CLI flag: ${flag}`
        );
      }
    }
  }
}

async function main(): Promise<void> {
  section("Release Process Validation");

  const issues: Issue[] = [];
  await validatePublishEnvironment(issues);
  await validatePublishVerificationTopology(issues);
  await validateManifestCliContract(issues);

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
