/**
 * Order extensions so each comes after the ones it depends on: 01-extensions.sql creates them in this order, and
 * CREATE EXTENSION fails when a dependency does not exist yet. Dependencies outside the given list are skipped
 * (the caller decides which extensions are created); a circular dependency throws.
 */

import type { ManifestEntry } from "../extensions/manifest-data";

export function resolveExtensionDependencies(extensions: ManifestEntry[]): ManifestEntry[] {
  const sorted: ManifestEntry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const nameToEntry = new Map<string, ManifestEntry>();
  for (const ext of extensions) {
    nameToEntry.set(ext.name, ext);
  }

  function visit(entry: ManifestEntry): void {
    if (visited.has(entry.name)) {
      return;
    }

    if (visiting.has(entry.name)) {
      throw new Error(`Circular dependency detected: ${entry.name}`);
    }

    visiting.add(entry.name);

    // Visit dependencies first
    const deps = entry.dependencies ?? [];
    for (const depName of deps) {
      const depEntry = nameToEntry.get(depName);
      if (depEntry) {
        visit(depEntry);
      }
    }

    visiting.delete(entry.name);
    visited.add(entry.name);
    sorted.push(entry);
  }

  for (const ext of extensions) {
    visit(ext);
  }

  return sorted;
}
