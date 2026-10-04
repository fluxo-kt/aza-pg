/**
 * Where an extension with `x86CpuFlags` keeps its control and SQL files.
 *
 * Such an extension ships a binary that executes those x86 instructions before any check of its own:
 * vectorscale 0.9.1 under QEMU `-cpu Nehalem` dies with SIGILL on CREATE EXTENSION instead of raising
 * its "requires AVX2 and FMA" error, which takes the whole server through crash recovery. So the image
 * keeps its files out of the default extension directory (generate-dockerfile.ts moves them here), and
 * the entrypoint adds this directory to `extension_control_path` only when /proc/cpuinfo lists every flag.
 * A CPU without them then gets "extension is not available" instead of a crash. The initdb precreate
 * and the healthcheck read that verdict from pg_available_extensions rather than re-checking the CPU.
 * Rosetta's /proc/cpuinfo omits avx2 even though the emulated CPU executes it, so an amd64 container
 * under Rosetta hides the extension: a false negative, never a crash.
 *
 * PostgreSQL appends `/extension` to each `extension_control_path` element (measured on 18.6), so this
 * is the share directory and the files live in its `extension/` subdirectory.
 */
/**
 * The entry's x86CpuFlags, refusing any that is not a /proc/cpuinfo flag name: the flags become shell
 * words in the Dockerfile and the entrypoint, and the entrypoint splits its list on "|" and newlines.
 */
export function requiredX86Flags(entry: { name: string; x86CpuFlags?: string[] }): string[] {
  const flags = entry.x86CpuFlags ?? [];
  const bad = flags.find((flag) => !/^[a-z0-9_]+$/.test(flag));
  if (bad !== undefined) {
    throw new Error(
      `${entry.name}: x86CpuFlags entry "${bad}" is not a /proc/cpuinfo flag name ([a-z0-9_]+)`
    );
  }
  return flags;
}

export function cpuGatedShareDir(pgMajor: string, extension: string): string {
  return `/usr/share/postgresql/${pgMajor}/cpu-gated/${extension}`;
}
