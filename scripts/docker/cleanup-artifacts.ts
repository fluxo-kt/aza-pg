#!/usr/bin/env bun
/**
 * Reclaims aza-pg-attributable Docker artifacts left by builds/tests — and NOTHING else.
 *
 * Safe on a shared, multi-project host because attribution uses aza-pg's OWN identity markers;
 * another project's images/volumes can never match:
 *   - images:  dangling images whose OCI label `org.opencontainers.image.title` starts with "aza-pg"
 *              (set in docker/postgres/Dockerfile.template).
 *   - volumes: dangling anonymous volumes whose PGDATA `postgresql.auto.conf` contains
 *              `app.aza_pg_custom` — the marker ALTER SYSTEM-set by
 *              docker-entrypoint-initdb.d/00-aza-pg-settings.sh specifically to identify aza-pg installs.
 *   - builder: the dedicated `aza-pg-builder` buildx builder + its cache (recreated on next build).
 *
 * NEVER prunes by type (no `docker image/volume/system prune`): a blunt prune would also delete
 * other projects' orphaned artifacts. Every removal here is positively attributed to aza-pg.
 *
 * The anonymous-volume leak this cleans is fixed at source (dockerCleanup/cleanupContainer pass `-v`);
 * this script reclaims pre-existing accumulation plus artifacts the build inherently leaves behind
 * (superseded image layers when a tag is rebuilt, builder cache).
 *
 * Usage: bun scripts/docker/cleanup-artifacts.ts [--dry-run]
 */

import { dockerRun, isDockerDaemonRunning } from "../utils/docker";
import { info, section, success, warning } from "../utils/logger";

const AZA_IMAGE_TITLE_PREFIX = "aza-pg";
const AZA_VOLUME_MARKER = "app.aza_pg_custom";
const AZA_BUILDER = "aza-pg-builder";
const VOLUME_PROBE_BATCH = 30;

const DRY_RUN = Bun.argv.includes("--dry-run");

/** Lines of `docker ... -q` output, trimmed and empties dropped. */
export function ids(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// --- Pure attribution decisions (no IO) — these decide what gets DELETED, so they are unit-tested
// in cleanup-artifacts.test.ts against the "never match a foreign project" safety property. ---

/**
 * True iff an image's OCI title marks it as an aza-pg build. Uses startsWith (anchored), NOT
 * includes: a foreign project whose name merely contains "aza-pg" (e.g. "my-aza-pg-fork") must NOT
 * match. aza-pg's own title is "aza-pg PostgreSQL <ver>" (docker/postgres/Dockerfile.template).
 */
export function isAzaImageTitle(title: string | undefined): boolean {
  return !!title && title.startsWith(AZA_IMAGE_TITLE_PREFIX);
}

/** Parse the `title|size` line emitted by `docker image inspect --format`. */
export function parseImageInspectLine(output: string): { title: string | undefined; size: number } {
  const [title, sizeStr] = output.trim().split("|");
  return { title: title || undefined, size: Number(sizeStr) || 0 };
}

/**
 * Map the volume-probe output (one batch index per line, for volumes carrying the marker) back to
 * volume ids. Guards against malformed/out-of-range indices so a parsing glitch can never select a
 * volume the probe did not positively mark.
 */
export function parseVolumeProbeMatches(probeOutput: string, batch: string[]): string[] {
  const matched: string[] = [];
  for (const idx of ids(probeOutput)) {
    const n = Number(idx);
    if (Number.isInteger(n) && batch[n]) matched.push(batch[n]);
  }
  return matched;
}

/** True iff the dedicated aza-pg buildx builder appears in `docker buildx ls` output. */
export function builderPresentInList(buildxLsOutput: string): boolean {
  return buildxLsOutput.split("\n").some((l) => l.trim().startsWith(AZA_BUILDER));
}

/** Dangling images whose OCI title marks them as aza-pg builds. Returns [id, sizeBytes]. */
async function azaDanglingImages(): Promise<Array<{ id: string; size: number }>> {
  const list = await dockerRun(["images", "-f", "dangling=true", "-q"]);
  if (!list.success) return [];
  const matched: Array<{ id: string; size: number }> = [];
  for (const id of ids(list.output)) {
    const insp = await dockerRun([
      "image",
      "inspect",
      id,
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.title"}}|{{.Size}}',
    ]);
    if (!insp.success) continue;
    const { title, size } = parseImageInspectLine(insp.output);
    if (isAzaImageTitle(title)) {
      matched.push({ id, size });
    }
  }
  return matched;
}

/**
 * Dangling volumes whose PGDATA carries the aza-pg marker.
 *
 * Probes by mounting batches of volumes read-only into a throwaway alpine container and grepping
 * each volume's `postgresql.auto.conf` for the marker. Read-only mounts are safe even if a volume
 * were in use; dangling volumes are by definition unused.
 */
async function azaDanglingVolumes(): Promise<string[]> {
  const list = await dockerRun(["volume", "ls", "-f", "dangling=true", "-q"]);
  if (!list.success) return [];
  const all = ids(list.output);
  const matched: string[] = [];

  for (let start = 0; start < all.length; start += VOLUME_PROBE_BATCH) {
    const batch = all.slice(start, start + VOLUME_PROBE_BATCH);
    const mountArgs = batch.flatMap((id, i) => ["-v", `${id}:/m/${i}:ro`]);
    // For each mounted volume dir, locate PGDATA's postgresql.auto.conf and report the index if it
    // contains the aza-pg marker. PG18's image nests PGDATA under /<major>/docker, hence -maxdepth 3.
    // grep -F (fixed string): the marker is a literal and contains a `.`, which as a regex would
    // match any char — this match drives DELETION, so it must be exact, not a pattern.
    const probe =
      'for d in /m/*; do i=$(basename "$d"); ' +
      'f=$(find "$d" -maxdepth 3 -name postgresql.auto.conf 2>/dev/null | head -1); ' +
      `if [ -n "$f" ] && grep -qF ${AZA_VOLUME_MARKER} "$f" 2>/dev/null; then echo "$i"; fi; done`;
    const res = await dockerRun(["run", "--rm", ...mountArgs, "alpine", "sh", "-c", probe]);
    if (!res.success) {
      warning(`Volume probe batch ${start}-${start + batch.length} failed; skipping it`);
      continue;
    }
    matched.push(...parseVolumeProbeMatches(res.output, batch));
  }
  return matched;
}

/** Whether the dedicated aza-pg buildx builder currently exists. */
async function azaBuilderExists(): Promise<boolean> {
  const res = await dockerRun(["buildx", "ls"]);
  return res.success && builderPresentInList(res.output);
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

async function main(): Promise<void> {
  section(`aza-pg artifact cleanup${DRY_RUN ? " (dry-run)" : ""}`);

  if (!(await isDockerDaemonRunning())) {
    warning("Docker daemon not running — nothing to clean");
    return;
  }

  const [images, volumes, builderPresent] = await Promise.all([
    azaDanglingImages(),
    azaDanglingVolumes(),
    azaBuilderExists(),
  ]);

  const imageBytes = images.reduce((sum, im) => sum + im.size, 0);
  info(
    `Found: ${images.length} dangling aza-pg image(s) (${fmtMB(imageBytes)}), ` +
      `${volumes.length} aza-pg PGDATA volume(s), builder=${builderPresent ? "present" : "absent"}`
  );

  if (DRY_RUN) {
    for (const im of images) info(`  would remove image  ${im.id} (${fmtMB(im.size)})`);
    for (const v of volumes) info(`  would remove volume ${v.slice(0, 12)}`);
    if (builderPresent) info(`  would remove builder ${AZA_BUILDER} (+ its cache)`);
    success("Dry-run complete — no changes made");
    return;
  }

  let removedImages = 0;
  for (const im of images) {
    const res = await dockerRun(["rmi", "-f", im.id]);
    if (res.success) removedImages++;
  }

  let removedVolumes = 0;
  // docker volume rm accepts many ids at once; chunk to keep arg lists sane.
  for (let i = 0; i < volumes.length; i += 100) {
    const chunk = volumes.slice(i, i + 100);
    const res = await dockerRun(["volume", "rm", ...chunk]);
    if (res.success) removedVolumes += chunk.length;
    else
      for (const v of chunk) if ((await dockerRun(["volume", "rm", v])).success) removedVolumes++;
  }

  let removedBuilder = false;
  if (builderPresent) {
    removedBuilder = (await dockerRun(["buildx", "rm", AZA_BUILDER])).success;
  }

  success(
    `Removed ${removedImages}/${images.length} image(s) (${fmtMB(imageBytes)}), ` +
      `${removedVolumes}/${volumes.length} volume(s)` +
      `${builderPresent ? `, builder ${removedBuilder ? "removed" : "NOT removed"}` : ""}`
  );
}

// Only run when invoked directly (`bun run cleanup`), not when imported by tests.
if (import.meta.main) await main();
