#!/usr/bin/env bun
import { $ } from "bun";
import { waitForPostgresStable } from "../utils/docker";
import { error, info, success } from "../utils/logger";
import { resolveImageTag } from "./image-resolver";

const imageTag = resolveImageTag();
const containerName = `aza-pg-basic-ext-${Date.now()}-${process.pid}`;

async function runSql(sql: string): Promise<string> {
  const result =
    await $`docker exec ${containerName} psql -v ON_ERROR_STOP=1 -U postgres -d postgres -tAc ${sql}`
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    const message = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(message);
  }

  return result.stdout.toString().trim();
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

async function cleanup(): Promise<void> {
  await $`docker rm -f ${containerName}`.quiet().nothrow();
}

async function main(): Promise<void> {
  info(`Starting ${containerName} from ${imageTag}`);
  await $`docker run -d --name ${containerName} -e POSTGRES_PASSWORD=test ${imageTag}`.quiet();

  try {
    const ready = await waitForPostgresStable({
      container: containerName,
      timeout: 120,
      requiredSuccesses: 3,
      checkInterval: 1000,
    });
    if (!ready) {
      throw new Error("PostgreSQL did not become stable");
    }

    const precreated = await runSql(
      "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('pg_cron', 'vector')"
    );
    assertEqual(precreated, "pg_cron,vector", "precreated extension set");

    const cronNamespace = await runSql("SELECT count(*) FROM pg_namespace WHERE nspname = 'cron'");
    assertEqual(cronNamespace, "1", "pg_cron cron schema");

    const vectorRoundTrip = await runSql("SELECT '[1,2,3]'::vector::text");
    assertEqual(vectorRoundTrip, "[1,2,3]", "vector cast round-trip");

    success("Basic extension loading verified without hidden PostgreSQL errors");
  } finally {
    await cleanup();
  }
}

main().catch(async (err: unknown) => {
  await cleanup();
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
