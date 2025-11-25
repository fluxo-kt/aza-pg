#!/usr/bin/env bun
/**
 * Umbrella script: Regenerate all files from manifest
 *
 * Orchestrates code generation in correct order with dependency awareness.
 * Runs independent generators in parallel where safe.
 *
 * Order:
 * 1. Manifest (source of truth) - must run first
 * 2. Extension defaults (depends on manifest)
 * 3. Parallel: Configs, docs, markdown (all depend on manifest but independent of each other)
 * 4. Parallel: Dockerfile + entrypoint (depend on manifest but independent)
 */

import { spawn } from "bun";
import * as logger from "./utils/logger";

interface GeneratorTask {
  name: string;
  script: string;
  dependsOn?: string[];
}

const generators: GeneratorTask[] = [
  // Phase 1: Manifest (must run first)
  { name: "Manifest", script: "scripts/extensions/generate-manifest.ts" },

  // Phase 2: Extension defaults (depends on manifest)
  {
    name: "Extension Defaults",
    script: "scripts/extensions/generate-extension-defaults.ts",
    dependsOn: ["Manifest"],
  },

  // Phase 3: Parallel generators (all depend on manifest, but independent of each other)
  { name: "Configs", script: "scripts/config-generator/generator.ts", dependsOn: ["Manifest"] },
  { name: "Docs Data", script: "scripts/generate-docs-data.ts", dependsOn: ["Manifest"] },
  { name: "Markdown", script: "scripts/extensions/render-markdown.ts", dependsOn: ["Manifest"] },

  // Phase 4: Parallel Docker generators (depend on manifest)
  { name: "Dockerfile", script: "scripts/docker/generate-dockerfile.ts", dependsOn: ["Manifest"] },
  { name: "Entrypoint", script: "scripts/docker/generate-entrypoint.ts", dependsOn: ["Manifest"] },
];

async function runGenerator(task: GeneratorTask): Promise<void> {
  logger.info(`Generating ${task.name}...`);

  const proc = spawn(["bun", task.script], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    logger.error(`Failed to generate ${task.name}`);
    if (stderr) console.error(stderr);
    if (stdout) console.log(stdout);
    throw new Error(`Generator failed: ${task.name}`);
  }

  logger.success(`${task.name} generated`);
}

async function main(): Promise<void> {
  logger.separator();
  console.log("  GENERATE ALL FILES");
  logger.separator();
  console.log();

  const completed = new Set<string>();
  const phases: GeneratorTask[][] = [];

  // Group generators into phases based on dependencies
  while (completed.size < generators.length) {
    const readyTasks = generators.filter(
      (task) =>
        !completed.has(task.name) && (task.dependsOn ?? []).every((dep) => completed.has(dep))
    );

    if (readyTasks.length === 0) {
      logger.error("Circular dependency or missing generator");
      process.exit(1);
    }

    phases.push(readyTasks);
    readyTasks.forEach((task) => completed.add(task.name));
  }

  // Run each phase (parallel within phase, sequential between phases)
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (!phase) continue; // Type guard

    logger.info(`Phase ${i + 1}: ${phase.map((t) => t.name).join(", ")}`);

    if (phase.length === 1) {
      // Single task: run sequentially
      const firstTask = phase[0];
      if (firstTask) await runGenerator(firstTask);
    } else {
      // Multiple tasks: run in parallel
      await Promise.all(phase.map((task) => runGenerator(task)));
    }

    console.log();
  }

  logger.separator();
  logger.success("All files generated successfully");
  logger.separator();
}

main().catch((err) => {
  logger.error(`Generation failed: ${err}`);
  process.exit(1);
});
