/**
 * The apt package name an `install_via: "pgdg"` manifest entry installs. The Dockerfile generator
 * and the PGDG version validator both call this, so the name they check is the name they install.
 *
 * Tools ship under their own name (`pgbackrest`), extensions under `postgresql-<major>-<pgdgPackage>`.
 * The suffix lives on the manifest entry because it cannot be derived from the extension name
 * (`vector` ships as `pgvector`, `postgis` as `postgis-3`, `pg_cron` as `cron`). An extension
 * without it throws instead of guessing: a guessed name that apt does not know reads as
 * "version mismatch" or, worse, as a valid-looking skip.
 */
export function pgdgAptPackageName(
  entry: { name: string; kind?: "extension" | "tool" | "builtin"; pgdgPackage?: string },
  pgMajor: string
): string {
  if (entry.kind === "tool") return entry.name;
  if (!entry.pgdgPackage) {
    throw new Error(
      `PGDG extension "${entry.name}" has no pgdgPackage. In scripts/extensions/manifest-data.ts set ` +
        `pgdgPackage to the suffix of its apt name postgresql-<major>-<suffix> ` +
        `(find it with: apt-cache search --names-only '^postgresql-<major>-').`
    );
  }
  return `postgresql-${pgMajor}-${entry.pgdgPackage}`;
}
