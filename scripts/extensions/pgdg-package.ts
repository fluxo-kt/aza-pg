/**
 * The apt package name an `install_via: "pgdg"` manifest entry installs. The Dockerfile generator
 * and the PGDG version validator both call this, so the name they check is the name they install.
 *
 * An entry with `pgdgPackage` installs `postgresql-<major>-<pgdgPackage>`, whatever its kind: a tool
 * that is a server module (wal2json) is packaged per PostgreSQL major like an extension. A tool
 * without it ships under its own name (`pgbackrest`). The suffix lives on the manifest entry because
 * it cannot be derived from the extension name (`vector` ships as `pgvector`, `postgis` as
 * `postgis-3`, `pg_cron` as `cron`). An extension without it throws instead of guessing: a guessed
 * name that apt does not know reads as "version mismatch" or, worse, as a valid-looking skip.
 */
export function pgdgAptPackageName(
  entry: { name: string; kind?: "extension" | "tool" | "builtin"; pgdgPackage?: string },
  pgMajor: string
): string {
  if (!entry.pgdgPackage && entry.kind === "tool") return entry.name;
  if (!entry.pgdgPackage) {
    throw new Error(
      `PGDG extension "${entry.name}" has no pgdgPackage. In scripts/extensions/manifest-data.ts set ` +
        `pgdgPackage to the suffix of its apt name postgresql-<major>-<suffix> ` +
        `(find it with: apt-cache search --names-only '^postgresql-<major>-').`
    );
  }
  return `postgresql-${pgMajor}-${entry.pgdgPackage}`;
}
