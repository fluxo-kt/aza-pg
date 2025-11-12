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

/**
 * Remove timestamp lines from content for comparison
 */
function removeTimestamps(content: string): string {
  return (
    content
      // Remove generatedAt timestamps in JSON
      .replace(/"generatedAt":\s*"[^"]+"/g, '"generatedAt": "TIMESTAMP"')
      // Remove Generated at comments in Dockerfile
      .replace(/^#\s+Generated at:\s+.+$/gm, "# Generated at: TIMESTAMP")
      // Remove any ISO date strings that might be in comments
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "TIMESTAMP")
  );
}

async function verifyGeneratedFiles(): Promise<boolean> {
  console.log("🔍 Verifying generated files are up-to-date...\n");

  // Save original content
  const originalContents = new Map<string, string>();
  for (const file of filesToCheck) {
    const fileHandle = Bun.file(file);
    if (await fileHandle.exists()) {
      originalContents.set(file, await fileHandle.text());
    }
  }

  // Run generate command to create fresh versions
  console.log("📝 Generating fresh files...");
  const proc = Bun.spawn(["bun", "run", "generate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  // Compare content excluding timestamps
  const differences: string[] = [];
  for (const file of filesToCheck) {
    const fileHandle = Bun.file(file);
    if (!(await fileHandle.exists())) {
      differences.push(`Missing file: ${file}`);
      continue;
    }

    const newContent = await fileHandle.text();
    const originalContent = originalContents.get(file) || "";

    // Compare without timestamps
    const originalNormalized = removeTimestamps(originalContent);
    const newNormalized = removeTimestamps(newContent);

    if (originalNormalized !== newNormalized) {
      differences.push(file);
    }
  }

  // Restore original files to avoid timestamp-only changes
  for (const [file, content] of originalContents.entries()) {
    await Bun.write(file, content);
  }

  if (differences.length > 0) {
    console.error("❌ Generated files are out of date!\n");
    console.error("Files with content changes (excluding timestamps):");
    for (const file of differences) {
      console.error(`  - ${file}`);
    }

    console.error("\n💡 Run 'bun run generate' and commit the changes.");

    // Re-generate to show the actual diff
    const regenerateProc = Bun.spawn(["bun", "run", "generate"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await regenerateProc.exited;

    console.error("\n📋 Showing differences:\n");
    for (const file of differences) {
      console.error(`\n--- Content changes in ${file} ---`);
      const diffProc = Bun.spawn(["git", "diff", "--color=always", file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const diff = await new Response(diffProc.stdout).text();
      if (diff) {
        // Filter out timestamp-only changes from display
        const filteredDiff = diff
          .split("\n")
          .filter((line) => {
            // Keep all lines except timestamp-only changes
            return !(line.includes("generatedAt") || line.includes("Generated at:"));
          })
          .join("\n");
        if (filteredDiff.trim()) {
          console.error(filteredDiff);
        }
      }
    }

    return false;
  }

  console.log("✅ All generated files are up-to-date!");
  return true;
}

// Main execution
const success = await verifyGeneratedFiles();
process.exit(success ? 0 : 1);
