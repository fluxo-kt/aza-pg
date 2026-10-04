#!/usr/bin/env bun
/**
 * Image behaviour suite: starts ONE container from the image under test and runs every check in
 * test-image-lib.ts against it, in order. It is the single owner of extension and tool behaviour.
 *
 * Usage:
 *   bun scripts/docker/test-image.ts [image]          # default: DEFAULT_TEST_IMAGE (local build)
 *   bun scripts/docker/test-image.ts --image=<ref>
 *   bun scripts/docker/test-image.ts --container=<name>
 *
 * --container runs the checks against an already-running container and leaves it running; it exists
 * to reproduce a failure, or to prove a check fails, against a container put into a known state first.
 * Any other flag is rejected, so a stale flag in a workflow fails loudly instead of being ignored.
 */

import {
  checkDockerDaemon,
  dockerCleanup,
  generateUniqueContainerName,
  waitForPostgres,
} from "../utils/docker";
import { getErrorMessage } from "../utils/errors";
import { error, formatDuration, info, section, testSummary } from "../utils/logger";
import type { TestResult } from "../utils/logger";
import { parseContainerName, resolveImageTag } from "../test/image-resolver";
import * as lib from "./test-image-lib";

const KNOWN_FLAGS = ["--image=", "--container="];

type Check = (container: string) => Promise<TestResult>;

const PHASES: Array<[string, Check[]]> = [
  [
    "Image contents",
    [
      lib.testSharedLibrariesResolve,
      lib.testToolsPresent,
      lib.testPgBackRestFunctional,
      lib.testPgBadgerFunctional,
    ],
  ],
  [
    "Startup state",
    [
      lib.testAutoConfigApplied,
      lib.testPreloadedExtensions,
      lib.testPrecreatedExtensions,
      lib.testPostgresConfiguration,
    ],
  ],
  ["Extension creation", [lib.testEnabledExtensions]],
  [
    "Extension behaviour",
    [
      lib.testPgvectorHnsw,
      lib.testPgvectorParallelHnswBuild,
      lib.testVectorscaleDiskann,
      lib.testHllCardinality,
      lib.testWal2jsonReplication,
      lib.testBtreeGistExclusion,
      lib.testBtreeGinIndex,
      lib.testHttpRequests,
      lib.testPgPartmanPartitioning,
      lib.testPgStatStatements,
      lib.testPgCronScheduling,
      lib.testHypopgHypotheticalIndexes,
      lib.testIndexAdvisor,
      lib.testPlpgsqlCheck,
      lib.testPgPlanFilter,
      lib.testPgRepack,
      lib.testPgmqQueue,
      lib.testPgTrgmSimilarity,
      lib.testPgroongaFullText,
      lib.testRumRankedSearch,
      lib.testPgauditLogging,
      lib.testPgsodiumEncryption,
      lib.testTimescaledbHypertables,
      lib.testPgHashidsEncoding,
      lib.testPgJsonschemaValidation,
    ],
  ],
];

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const unknown = args.filter(
    (a) => a.startsWith("-") && !KNOWN_FLAGS.some((f) => a.startsWith(f))
  );
  if (unknown.length > 0) {
    error(
      `Unknown flag(s): ${unknown.join(" ")} (accepted: [image] ${KNOWN_FLAGS.map((f) => `${f}<value>`).join(" ")})`
    );
    return 2;
  }

  await checkDockerDaemon();
  const existing = parseContainerName(Bun.argv);
  const container = existing ?? generateUniqueContainerName("aza-pg-image-test");
  const started = Date.now();

  try {
    if (!existing) {
      const image = resolveImageTag({ argv: Bun.argv });
      section(`Image behaviour: ${image}`);
      const run = Bun.spawn(
        [
          "docker",
          "run",
          "-d",
          "--name",
          container,
          "-e",
          "POSTGRES_PASSWORD=test-image-pass",
          image,
        ],
        { stdout: "ignore", stderr: "pipe" }
      );
      const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
      if (code !== 0) {
        error(`docker run failed: ${stderr.trim()}`);
        return 1;
      }
      await waitForPostgres({ container, timeout: 120 });
    } else {
      section(`Image behaviour: existing container ${container}`);
    }

    const results: TestResult[] = [];
    for (const [phase, checks] of PHASES) {
      info(phase);
      for (const run of checks) results.push(await run(container));
    }
    await lib.cleanupTestData(container);

    testSummary(results);
    info(`Total: ${formatDuration(Date.now() - started)}`);
    return results.every((r) => r.passed) ? 0 : 1;
  } catch (err) {
    error(`Image behaviour suite aborted: ${getErrorMessage(err)}`);
    return 1;
  } finally {
    if (!existing) await dockerCleanup(container);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
