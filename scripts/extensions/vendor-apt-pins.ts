import type { ManifestEntry } from "./manifest-data";

export type VendorRepo = "percona" | "timescale";

export interface VendorAptPin {
  name: string;
  repo: VendorRepo;
  aptPackage: string;
  version: string;
}

type VendorEntry = Pick<
  ManifestEntry,
  | "name"
  | "enabled"
  | "install_via"
  | "perconaPackage"
  | "perconaVersion"
  | "timescalePackage"
  | "timescaleVersion"
>;

/**
 * Every `package=version` the image installs from the Percona and Timescale repositories, in
 * manifest order. The Dockerfile generator installs exactly this list and check-vendor-apt.ts queries
 * exactly this list, so the packages checked are the packages installed — a hand-copied list drifts
 * from the manifest with every added, removed or migrated entry.
 *
 * Timescale's main package pulls its loader as a dependency, and the loader's version decides which
 * extension version PostgreSQL loads: left to apt it moves ahead of the pinned extension and fails
 * with "no installation script for version X". So each timescaledb-N-postgresql-M pin adds its
 * loader at the same version.
 *
 * Missing fields throw: an unpinned vendor package installs whatever the repo serves on build day.
 */
export function vendorAptPins(entries: readonly VendorEntry[]): VendorAptPin[] {
  return entries
    .filter((e) => e.enabled ?? true)
    .flatMap((e): VendorAptPin[] => {
      const repo = e.install_via;
      if (repo !== "percona" && repo !== "timescale") return [];
      const aptPackage = repo === "percona" ? e.perconaPackage : e.timescalePackage;
      const version = repo === "percona" ? e.perconaVersion : e.timescaleVersion;
      if (!aptPackage || !version) {
        throw new Error(
          `${repo} entry "${e.name}" needs both ${repo}Package and ${repo}Version in ` +
            `scripts/extensions/manifest-data.ts (find them with: bun scripts/extensions/check-vendor-apt.ts).`
        );
      }
      const pin = { name: e.name, repo, aptPackage, version };
      const loader = aptPackage.replace(/^(timescaledb-\d+-)(postgresql-.+)$/, "$1loader-$2");
      return repo === "timescale" && loader !== aptPackage
        ? [pin, { ...pin, aptPackage: loader }]
        : [pin];
    });
}
