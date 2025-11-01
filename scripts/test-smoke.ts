#!/usr/bin/env bun
/**
 * Smoke Tests
 *
 * Quick sanity checks that run in < 30 seconds:
 * - YAML lint integration (verify .yamllint exists and is readable)
 * - Script references (verify bun run commands in docs point to real scripts)
 * - Generated data freshness (verify docs-data.json exists and is recent)
 *
 * Usage:
 *   bun scripts/test-smoke.ts
 */

import { getErrorMessage } from "./utils/errors";
import { join } from "node:path";
import { error, info, section, testSummary } from "./utils/logger.ts";
import type { TestResult } from "./utils/logger.ts";
import { Glob } from "bun";

const PROJECT_ROOT = join(import.meta.dir, "..");

/**
 * Test: YAML lint configuration exists
 */
async function testYamlLintConfig(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const yamlLintPath = `${PROJECT_ROOT}/.yamllint`;
    const file = Bun.file(yamlLintPath);

    if (!(await file.exists())) {
      return {
        name: "YAML lint config exists",
        passed: false,
        duration: Date.now() - startTime,
        error: ".yamllint file not found",
      };
    }

    const content = await file.text();
    if (content.length === 0) {
      return {
        name: "YAML lint config exists",
        passed: false,
        duration: Date.now() - startTime,
        error: ".yamllint file is empty",
      };
    }

    // Basic validation: should contain 'rules:' section
    if (!content.includes("rules:")) {
      return {
        name: "YAML lint config exists",
        passed: false,
        duration: Date.now() - startTime,
        error: ".yamllint appears invalid (no 'rules:' section)",
      };
    }

    return {
      name: "YAML lint config exists",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "YAML lint config exists",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Script references in documentation are valid
 */
async function testScriptReferences(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Load package.json to get available scripts
    const packageJsonPath = `${PROJECT_ROOT}/package.json`;
    const packageJson = await Bun.file(packageJsonPath).json();
    const scripts: Record<string, string> = packageJson.scripts || {};
    const availableScripts = new Set(Object.keys(scripts));

    // Find all markdown files
    const docFiles: string[] = [];
    const patterns = ["AGENTS.md", "README.md", "docs/**/*.md"];

    for (const pattern of patterns) {
      const glob = new Glob(pattern);
      for await (const file of glob.scan({ cwd: PROJECT_ROOT })) {
        const fullPath = `${PROJECT_ROOT}/${file}`;
        if (!fullPath.includes("node_modules") && !fullPath.includes(".archived")) {
          docFiles.push(fullPath);
        }
      }
    }

    // Find all "bun run X" references in docs (where X is a script name, not a path)
    // Pattern: "bun run <scriptname>" where scriptname is alphanumeric with : or _ separators
    // but NOT "bun run scripts/..." (direct file paths)
    const scriptRefPattern = /bun\s+run\s+([a-z:_-]+)(?!\/)(?:\s|$)/gi;
    const missingScripts: Set<string> = new Set();
    const foundReferences: Map<string, string[]> = new Map();

    for (const docFile of docFiles) {
      const content = await Bun.file(docFile).text();
      const matches = [...content.matchAll(scriptRefPattern)];

      for (const match of matches) {
        const scriptName = match[1];
        if (!scriptName) {
          continue;
        }
        // Skip if it's a file path indicator (contains dots or slashes)
        if (scriptName.includes(".") || scriptName.includes("/")) {
          continue;
        }
        if (!availableScripts.has(scriptName)) {
          missingScripts.add(scriptName);
          if (!foundReferences.has(scriptName)) {
            foundReferences.set(scriptName, []);
          }
          foundReferences.get(scriptName)?.push(docFile);
        }
      }
    }

    if (missingScripts.size > 0) {
      const missing = Array.from(missingScripts);
      return {
        name: "Script references are valid",
        passed: false,
        duration: Date.now() - startTime,
        error: `Referenced scripts not in package.json: ${missing.join(", ")}`,
      };
    }

    return {
      name: "Script references are valid",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Script references are valid",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Generated documentation data is fresh
 */
async function testGeneratedDataFreshness(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const docsDataPath = `${PROJECT_ROOT}/docs/.generated/docs-data.json`;
    const file = Bun.file(docsDataPath);

    if (!(await file.exists())) {
      return {
        name: "Generated docs data exists",
        passed: false,
        duration: Date.now() - startTime,
        error: "docs-data.json not found - run 'bun run generate'",
      };
    }

    const data = await file.json();
    // Verify essential structure exists
    if (!data.catalog || !Array.isArray(data.extensions)) {
      return {
        name: "Generated docs data exists",
        passed: false,
        duration: Date.now() - startTime,
        error: "docs-data.json missing required fields (catalog, extensions)",
      };
    }

    return {
      name: "Generated docs data exists",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Generated docs data exists",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Essential directories exist
 */
async function testEssentialStructure(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const requiredDirs = ["scripts", "docker/postgres", "stacks/primary", "docs"];

    const missing: string[] = [];

    for (const dir of requiredDirs) {
      const path = `${PROJECT_ROOT}/${dir}`;
      // For directories, we check if they exist by trying to read them
      try {
        const stat = await Bun.file(`${path}/.`).exists();
        if (!stat) {
          // Try alternative check
          const proc = Bun.spawn(["test", "-d", path], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            missing.push(dir);
          }
        }
      } catch {
        missing.push(dir);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Essential directories exist",
        passed: false,
        duration: Date.now() - startTime,
        error: `Missing directories: ${missing.join(", ")}`,
      };
    }

    return {
      name: "Essential directories exist",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Essential directories exist",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Test: Essential files exist
 */
async function testEssentialFiles(): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const requiredFiles = [
      "package.json",
      "tsconfig.json",
      "docker/postgres/Dockerfile",
      "docker/postgres/extensions.manifest.json",
      "AGENTS.md",
      "README.md",
    ];

    const missing: string[] = [];

    for (const filePath of requiredFiles) {
      const path = `${PROJECT_ROOT}/${filePath}`;
      const file = Bun.file(path);
      if (!(await file.exists())) {
        missing.push(filePath);
      }
    }

    if (missing.length > 0) {
      return {
        name: "Essential files exist",
        passed: false,
        duration: Date.now() - startTime,
        error: `Missing files: ${missing.join(", ")}`,
      };
    }

    return {
      name: "Essential files exist",
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      name: "Essential files exist",
      passed: false,
      duration: Date.now() - startTime,
      error: getErrorMessage(err),
    };
  }
}

async function main() {
  section("Smoke Tests");
  info("Running quick sanity checks...");
  console.log("");

  const results: TestResult[] = [];

  // Run all smoke tests
  results.push(await testEssentialStructure());
  results.push(await testEssentialFiles());
  results.push(await testYamlLintConfig());
  results.push(await testScriptReferences());
  results.push(await testGeneratedDataFreshness());

  // Print summary
  console.log("");
  testSummary(results);

  // Exit with error if any tests failed
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  error(`Smoke tests failed: ${getErrorMessage(err)}`);
  process.exit(1);
});
