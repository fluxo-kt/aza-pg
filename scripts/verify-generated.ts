#!/usr/bin/env bun
/**
 * Verifies that generated files are up-to-date.
 * Run 'bun run generate' if this fails.
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const filesToCheck = [
  "docker/postgres/Dockerfile",
  "docker/postgres/extensions.manifest.json",
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql",
  "docs/.generated/docs-data.json",
  "docs/EXTENSIONS.md",
];

function verifyGeneratedFiles(): boolean {
  console.log("🔍 Verifying generated files are up-to-date...\n");

  // Run generate command to create fresh versions
  console.log("📝 Generating fresh files...");
  execSync("bun run generate", { stdio: "pipe" });

  // Check git status for modifications
  const gitStatus = execSync("git status --porcelain", { encoding: "utf-8" });
  const modifiedFiles = gitStatus
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.substring(3).trim());

  // Filter to only check our generated files
  const modifiedGeneratedFiles = modifiedFiles.filter((file) =>
    filesToCheck.some((checkFile) => file === checkFile)
  );

  if (modifiedGeneratedFiles.length > 0) {
    console.error("❌ Generated files are out of date!\n");
    console.error("Modified files:");
    modifiedGeneratedFiles.forEach((file) => {
      console.error(`  - ${file}`);
    });

    console.error("\n📋 Showing differences:\n");
    // Show diff for each modified file
    modifiedGeneratedFiles.forEach((file) => {
      console.error(`\n--- Diff for ${file} ---`);
      try {
        const diff = execSync(`git diff --no-index --color=always ${file} || true`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        console.error(diff);
      } catch (e) {
        // git diff exits with 1 when files differ, which is expected
      }
    });

    console.error("\n💡 Run 'bun run generate' and commit the changes.");
    return false;
  }

  console.log("✅ All generated files are up-to-date!");
  return true;
}

// Main execution
const success = verifyGeneratedFiles();
process.exit(success ? 0 : 1);
