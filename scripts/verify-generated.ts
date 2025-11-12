#!/usr/bin/env bun
/**
 * Verifies that generated files are up-to-date.
 * Run 'bun run generate' if this fails.
 */

const filesToCheck = [
  "docker/postgres/Dockerfile",
  "docker/postgres/extensions.manifest.json",
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql",
  "docs/.generated/docs-data.json",
  "docs/EXTENSIONS.md",
];

async function verifyGeneratedFiles(): Promise<boolean> {
  console.log("🔍 Verifying generated files are up-to-date...\n");

  // Run generate command to create fresh versions
  console.log("📝 Generating fresh files...");
  const proc = Bun.spawn(["bun", "run", "generate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  // Check git status for modifications
  const gitStatusProc = Bun.spawn(["git", "status", "--porcelain"], {
    stdout: "pipe",
  });
  const gitStatus = await new Response(gitStatusProc.stdout).text();
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
    for (const file of modifiedGeneratedFiles) {
      console.error(`  - ${file}`);
    }

    console.error("\n📋 Showing differences:\n");
    // Show diff for each modified file
    for (const file of modifiedGeneratedFiles) {
      console.error(`\n--- Diff for ${file} ---`);
      const diffProc = Bun.spawn(["git", "diff", "--color=always", file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const diff = await new Response(diffProc.stdout).text();
      if (diff) {
        console.error(diff);
      }
    }

    console.error("\n💡 Run 'bun run generate' and commit the changes.");
    return false;
  }

  console.log("✅ All generated files are up-to-date!");
  return true;
}

// Main execution
const success = await verifyGeneratedFiles();
process.exit(success ? 0 : 1);
