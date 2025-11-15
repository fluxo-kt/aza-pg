#!/usr/bin/env bun
/**
 * Extract PostgreSQL version information from a base image.
 *
 * Used by publish.yml to derive:
 * - Major version (MM)
 * - Minor version (mm)
 * - Full version string "MM.mm"
 *
 * When --github-output is set, writes step outputs to $GITHUB_OUTPUT:
 *   major=18
 *   minor=0
 *   full=18.0
 *   base_image_name=postgres:18-trixie
 *   base_image_digest=sha256:...
 *
 * Usage:
 *   bun scripts/build/extract-pg-version.ts --image postgres:18-trixie@sha256:... --github-output
 */

import { $ } from "bun";

type CliOptions = {
  image: string;
  githubOutput: boolean;
};

function printHelp(): void {
  const helpText = `
Extract PostgreSQL version information from a Docker image.

Usage:
  bun scripts/build/extract-pg-version.ts --image <name[@digest]> [--github-output]

Options:
  --image <ref>        Base image reference (e.g. postgres:18-trixie@sha256:...)
  --github-output      Write results to $GITHUB_OUTPUT for GitHub Actions
  --help, -h           Show this help
`.trim();

  console.log(helpText);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const options: CliOptions = {
    image: "",
    githubOutput: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        // eslint-disable-next-line no-process-exit
        process.exit(0);
      case "--image": {
        const value = args[i + 1];
        if (!value) {
          throw new Error("--image requires a value");
        }
        options.image = value;
        i += 1;
        break;
      }
      case "--github-output":
        options.githubOutput = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.image) {
    throw new Error("--image is required");
  }

  return options;
}

function parseVersion(psqlOutput: string): { major: string; minor: string; full: string } {
  // Expected patterns:
  //   psql (PostgreSQL) 18.0
  //   psql (PostgreSQL) 18.1 (Debian 18.1-1.pgdg120+1)
  const match = psqlOutput.match(/PostgreSQL\)\s+(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse PostgreSQL version from: ${psqlOutput.trim()}`);
  }

  const major = match[1]!;
  const minor = match[2]!;
  const full = `${major}.${minor}`;

  return { major, minor, full };
}

function splitImage(image: string): { name: string; digest: string } {
  const atIndex = image.indexOf("@");
  if (atIndex === -1) {
    return { name: image, digest: "" };
  }

  return {
    name: image.slice(0, atIndex),
    digest: image.slice(atIndex + 1),
  };
}

async function writeGithubOutput(fields: Record<string, string>): Promise<void> {
  const githubOutputPath = Bun.env.GITHUB_OUTPUT;
  if (!githubOutputPath) {
    throw new Error("GITHUB_OUTPUT is not set but --github-output was provided");
  }

  const file = Bun.file(githubOutputPath);
  const exists = await file.exists();
  const existing = exists ? await file.text() : "";

  const lines = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const nextContent =
    existing.length === 0 || existing.endsWith("\n")
      ? `${existing}${lines}\n`
      : `${existing}\n${lines}\n`;

  await Bun.write(githubOutputPath, nextContent);
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv);
  const { image, githubOutput } = options;

  // Run psql --version inside the base image. This does not require a running server.
  const { stdout } = await $`docker run --rm ${image} psql --version`.quiet();
  const rawOutput = stdout.toString();

  const { major, minor, full } = parseVersion(rawOutput);
  const { name: baseName, digest: baseDigest } = splitImage(image);

  console.log(`Detected PostgreSQL version from image ${image}:`);
  console.log(`  Major: ${major}`);
  console.log(`  Minor: ${minor}`);
  console.log(`  Full:  ${full}`);
  console.log(`  Base image name:   ${baseName}`);
  console.log(`  Base image digest: ${baseDigest || "(none)"}`);

  if (githubOutput) {
    await writeGithubOutput({
      major,
      minor,
      full,
      base_image_name: baseName,
      base_image_digest: baseDigest,
    });
  }
}

main().catch((err) => {
  console.error("extract-pg-version failed:", err instanceof Error ? err.message : String(err));
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});

