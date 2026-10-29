#!/usr/bin/env bun
/**
 * Checks every Percona and Timescale pin the image installs (vendorAptPins) against the vendor repos:
 * the pinned version must still be served, since vendors delete old versions and the build then
 * fails, and a newer version is reported because these packages get packaging rebuilds and security
 * fixes that no git tag shows (check-updates compares tags only).
 *
 * Exit 0 = every pin served and newest; 1 = a pin is gone or outdated; 2 = the check itself failed
 * (Docker, network, a repository's key). A Timescale rebuild for the base image's PostgreSQL minor
 * (suffix -1804 → -1806) sorts newer, so it is reported here; a pin lagging the minor with no such
 * rebuild still installs (the package depends on postgresql-18 >= its own minor) and is not an error.
 *
 * Kept out of `validate`: it needs two third-party repositories, whose outages must not block every
 * commit. The update procedure runs it in pre-flight.
 */

import { MANIFEST_ENTRIES, MANIFEST_METADATA } from "./manifest-data";
import { vendorAptPins } from "./vendor-apt-pins";

const pins = vendorAptPins(MANIFEST_ENTRIES);
const pgMajor = MANIFEST_METADATA.pgVersion.replace(/\..*/, "");

// Arguments arrive as package/version pairs; the script prints "package<TAB>served<TAB>newest",
// one line per pair in argument order.
// dpkg --compare-versions orders epochs (1:) and tildes (~debian13) the way apt does.
const PROBE = `set -euo pipefail
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates >/dev/null
echo "deb [signed-by=/k/percona.asc] https://repo.percona.com/ppg-$PG_MAJOR/apt trixie main" > /etc/apt/sources.list.d/p.list
echo "deb [signed-by=/k/timescale.asc] https://packagecloud.io/timescale/timescaledb/debian/ trixie main" > /etc/apt/sources.list.d/t.list
apt-get update -qq --error-on=any >/dev/null
while [ $# -gt 0 ]; do
  pkg=$1 pin=$2; shift 2
  served=no newest=
  for v in $(apt-cache madison "$pkg" | awk '{print $3}'); do
    [ "$v" = "$pin" ] && served=yes
    if [ -z "$newest" ] || dpkg --compare-versions "$v" gt "$newest"; then newest=$v; fi
  done
  printf '%s\\t%s\\t%s\\n' "$pkg" "$served" "$newest"
done
`;

const proc = Bun.spawn(
  [
    "docker",
    "run",
    "--rm",
    "-i",
    "-e",
    `PG_MAJOR=${pgMajor}`,
    "-v",
    `${import.meta.dir}/../../docker/postgres/apt-keys:/k:ro`,
    `postgres:${MANIFEST_METADATA.pgVersion}-trixie`,
    "bash",
    "-s",
    "--",
    ...pins.flatMap((p) => [p.aptPackage, p.version]),
  ],
  { stdin: new Blob([PROBE]), stdout: "pipe", stderr: "pipe" }
);
const [out, err, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
if (code !== 0) {
  console.error(
    `❌ vendor repository probe failed (exit ${code}); NO_PUBKEY/EXPKEYSIG means a rotated key:\n${err}`
  );
  process.exit(2);
}

const rows = out.trimEnd().split("\n");
const problems: string[] = [];
for (const [i, p] of pins.entries()) {
  const [pkg, served, newest] = rows[i]?.split("\t") ?? [];
  if (pkg !== p.aptPackage) {
    console.error(`❌ probe output out of step at ${p.aptPackage}:\n${out}`);
    process.exit(2);
  }
  if (!newest) problems.push(`${p.aptPackage}: not in the ${p.repo} repository`);
  else if (served !== "yes")
    problems.push(
      `${p.aptPackage}=${p.version}: not served by the repository, so the build fails (newest ${newest})`
    );
  else if (newest !== p.version)
    problems.push(`${p.aptPackage}=${p.version}: newer ${newest} available`);
  else console.log(`✅ ${p.aptPackage}=${p.version}`);
}

for (const problem of problems) console.error(`❌ ${problem}`);
if (problems.length > 0) {
  console.error(
    "\nSet perconaVersion/timescaleVersion on the entry in scripts/extensions/manifest-data.ts to the version named above, then bun run generate (a Timescale bump moves its loader too)."
  );
  process.exit(1);
}
