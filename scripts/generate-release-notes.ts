#!/usr/bin/env bun

/**
 * Generate GitHub Release Notes from Extension Manifest
 *
 * Creates production-ready release notes with extension catalog grouped by category,
 * quick start examples, auto-config documentation, and verification instructions.
 *
 * Usage:
 *   bun scripts/generate-release-notes.ts \
 *     --pg-version=18.1 \
 *     --tag=18.1-202511132330-single-node \
 *     --digest=sha256:abc123... \
 *     --catalog-enabled=36 \
 *     --catalog-total=38 \
 *     --output=release-notes.md
 *
 * Arguments:
 *   --pg-version       PostgreSQL version (e.g., "18.1")
 *   --tag              Full image tag (e.g., "18.1-202511132330-single-node")
 *   --digest           Image digest (e.g., "sha256:abc123...")
 *   --catalog-enabled  Number of enabled extensions
 *   --catalog-total    Total extensions in catalog
 *   --output           Output markdown file path
 */

import { join } from "path";
import type { ManifestEntry } from "./extensions/manifest-data.ts";
import { warning } from "./utils/logger";

const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");

// GitHub repository info
const REPO_OWNER = "fluxo-kt";
const REPO_NAME = "aza-pg";
const REGISTRY = `ghcr.io/${REPO_OWNER}/${REPO_NAME}`;

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

interface Args {
  pgVersion: string;
  tag: string;
  digest: string;
  catalogEnabled: number;
  catalogTotal: number;
  output: string;
}

interface CategoryGroup {
  category: string;
  displayName: string;
  extensions: ExtensionInfo[];
}

interface ExtensionInfo {
  name: string;
  displayName: string;
  version: string;
  description: string;
}

// Category display names mapping (ordered by importance)
const CATEGORY_NAMES: Record<string, string> = {
  ai: "AI/ML & Vector Search",
  timeseries: "Time-Series",
  search: "Full-Text Search",
  analytics: "Analytics",
  security: "Security & Auditing",
  observability: "Observability & Monitoring",
  performance: "Performance",
  operations: "Operations & Automation",
  maintenance: "Maintenance",
  integration: "Integration & FDW",
  queueing: "Queueing & Messaging",
  cdc: "Change Data Capture",
  validation: "Validation",
  safety: "Safety & Guards",
  quality: "Quality & Testing",
  gis: "GIS & Spatial",
  utilities: "Utilities",
  indexing: "Indexing",
  language: "Languages",
};

// Category order (matches EXTENSIONS.md structure)
const CATEGORY_ORDER = [
  "ai",
  "timeseries",
  "search",
  "analytics",
  "security",
  "observability",
  "performance",
  "operations",
  "maintenance",
  "integration",
  "queueing",
  "cdc",
  "validation",
  "safety",
  "quality",
  "gis",
  "utilities",
  "indexing",
  "language",
];

/**
 * Parse CLI arguments
 */
function parseArgs(): Args | null {
  const args = Bun.argv.slice(2);

  const getArg = (name: string): string | undefined => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg?.split("=")[1];
  };

  const pgVersion = getArg("pg-version");
  const tag = getArg("tag");
  const digest = getArg("digest");
  const catalogEnabled = getArg("catalog-enabled");
  const catalogTotal = getArg("catalog-total");
  const output = getArg("output");

  // Validate required args
  if (!pgVersion || !tag || !digest || !catalogEnabled || !catalogTotal || !output) {
    console.error("ERROR: Missing required arguments");
    console.error("");
    console.error("Usage:");
    console.error("  bun scripts/generate-release-notes.ts \\");
    console.error("    --pg-version=18.1 \\");
    console.error("    --tag=18.1-202511132330-single-node \\");
    console.error("    --digest=sha256:abc123... \\");
    console.error("    --catalog-enabled=36 \\");
    console.error("    --catalog-total=38 \\");
    console.error("    --output=release-notes.md");
    return null;
  }

  return {
    pgVersion,
    tag,
    digest,
    catalogEnabled: parseInt(catalogEnabled, 10),
    catalogTotal: parseInt(catalogTotal, 10),
    output,
  };
}

/**
 * Extract version from source spec
 */
function getVersion(entry: ManifestEntry): string {
  if (entry.source.type === "builtin") {
    return "builtin";
  }

  if (entry.source.type === "git" && entry.source.tag) {
    let version = entry.source.tag;

    // Remove common tag prefixes (order matters!)
    // Note: Must check longer prefixes first (ver_ before v)
    version = version
      .replace(/^ver_/, "") // ver_1.5.3 -> 1.5.3
      .replace(/^release\//, "") // release/2.57.0 -> 2.57.0
      .replace(/^REL/, "") // REL4_2_0 -> 4_2_0
      .replace(/^v(\d)/, "$1"); // v1.0.0 -> 1.0.0 (only if followed by digit)

    // Replace underscores with dots for versioned tags
    // Examples: wal2json_2_6 -> wal2json.2.6, 4_2_0 -> 4.2.0
    version = version.replace(/_/g, ".");

    return version;
  }

  if (entry.source.type === "git-ref" && entry.source.ref) {
    // Show short commit hash
    return entry.source.ref.slice(0, 7);
  }

  return "latest";
}

/**
 * Group enabled extensions by category
 */
function groupByCategory(manifest: Manifest): CategoryGroup[] {
  const enabledExtensions = manifest.entries.filter((e) => e.enabled !== false);

  // Group by category
  const categoryMap = new Map<string, ExtensionInfo[]>();

  for (const entry of enabledExtensions) {
    const category = entry.category;
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }

    const extensionInfo: ExtensionInfo = {
      name: entry.name,
      displayName: entry.displayName ?? entry.name,
      version: getVersion(entry),
      description: entry.description,
    };

    categoryMap.get(category)!.push(extensionInfo);
  }

  // Sort extensions within each category by display name
  for (const extensions of categoryMap.values()) {
    extensions.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  // Create category groups in specified order
  const groups: CategoryGroup[] = [];

  for (const category of CATEGORY_ORDER) {
    const extensions = categoryMap.get(category);
    if (extensions && extensions.length > 0) {
      groups.push({
        category,
        displayName: CATEGORY_NAMES[category] ?? category,
        extensions,
      });
    }
  }

  // Add any remaining categories not in the predefined order
  for (const [category, extensions] of categoryMap.entries()) {
    if (!CATEGORY_ORDER.includes(category)) {
      groups.push({
        category,
        displayName: CATEGORY_NAMES[category] ?? category,
        extensions,
      });
    }
  }

  return groups;
}

/**
 * Generate convenience tags from full tag
 */
function getConvenienceTags(fullTag: string, pgVersion: string): string[] {
  // Extract PostgreSQL major version
  const pgMajor = pgVersion.split(".")[0] ?? pgVersion;

  // Parse tag format: {pg_version}-{timestamp}-{type}
  // Timestamp can be YYYYMMDDHHmm or RFC3339 compact format
  // Type can contain hyphens (e.g., "single-node")
  const match = fullTag.match(/^([\d.]+)-([\w:T-]+)-(.+)$/);

  if (!match) {
    warning(`Could not parse tag format: ${fullTag}`);
    return []; // Return empty array if parsing fails
  }

  const [, , , typePart] = match;

  return [`${pgMajor}-${typePart}`, pgMajor];
}

/**
 * Generate markdown release notes
 */
function generateMarkdown(
  args: Args,
  _manifest: Manifest,
  categoryGroups: CategoryGroup[]
): string {
  const lines: string[] = [];

  // Extract version components
  const convenienceTags = getConvenienceTags(args.tag, args.pgVersion);
  const simpleTag = convenienceTags[0]; // e.g., "18-single-node"

  // Header
  lines.push(`# aza-pg PostgreSQL ${args.pgVersion}`);
  lines.push("");
  lines.push(
    `Production-ready PostgreSQL with **${args.catalogEnabled} enabled extensions** across ${categoryGroups.length} categories.`
  );
  lines.push("");

  // What's Inside section
  lines.push("## What's Inside");
  lines.push("");

  for (const group of categoryGroups) {
    const count = group.extensions.length;
    const countText = count === 1 ? "extension" : "extensions";
    lines.push(`### ${group.displayName} (${count} ${countText})`);
    lines.push("");

    for (const ext of group.extensions) {
      const versionText = ext.version !== "builtin" ? ` ${ext.version}` : "";
      lines.push(`- **${ext.displayName}**${versionText} - ${ext.description}`);
    }

    lines.push("");
  }

  // Image Details section
  lines.push("## Image Details");
  lines.push("");
  lines.push(`- **Registry**: ${REGISTRY}`);
  lines.push(
    `- **Package Page**: [ghcr.io/fluxo-kt/aza-pg](https://github.com/fluxo-kt/aza-pg/pkgs/container/aza-pg)`
  );
  lines.push(`- **Tags**: \`${args.tag}\`, \`${convenienceTags.join("`, `")}\``);
  lines.push(`- **Digest**: \`${args.digest}\``);
  lines.push("- **Platforms**: linux/amd64, linux/arm64 (native builds, no QEMU)");
  lines.push(`- **Base**: postgres:${args.pgVersion}-trixie (SHA-pinned)`);
  lines.push("");

  // Quick Start section
  lines.push("## Quick Start");
  lines.push("");
  lines.push("```bash");
  lines.push("docker run -d \\");
  lines.push("  -e POSTGRES_PASSWORD=secure \\");
  lines.push("  -e POSTGRES_WORKLOAD_TYPE=web \\");
  lines.push("  -p 5432:5432 \\");
  lines.push(`  ${REGISTRY}:${simpleTag}`);
  lines.push("```");
  lines.push("");
  lines.push("```sql");
  lines.push("-- Enable extensions on-demand");
  lines.push("CREATE EXTENSION vector;");
  lines.push("CREATE EXTENSION timescaledb;");
  lines.push("");
  lines.push("-- List all available");
  lines.push("SELECT name, default_version, comment ");
  lines.push("FROM pg_available_extensions ");
  lines.push("ORDER BY name;");
  lines.push("```");
  lines.push("");

  // Auto-Configuration section
  lines.push("## Auto-Configuration");
  lines.push("");
  lines.push("Automatically detects and tunes based on:");
  lines.push("- **RAM**: Optimizes shared_buffers, work_mem (caps: 32GB, 32MB)");
  lines.push("- **CPU**: Parallel workers, maintenance workers");
  lines.push("- **Workload**: web (default), oltp, dw, mixed");
  lines.push("- **Storage**: ssd (default), hdd, san");
  lines.push("");

  // Verification section
  lines.push("## Verification");
  lines.push("");
  lines.push("```bash");
  lines.push("# Verify Cosign signature");
  lines.push(`cosign verify ${REGISTRY}:${simpleTag}`);
  lines.push("");
  lines.push("# View version info");
  lines.push(`docker run --rm ${REGISTRY}:${simpleTag} \\`);
  lines.push("  cat /etc/postgresql/version-info.txt");
  lines.push("");
  lines.push("# Download SBOM");
  lines.push(`cosign download sbom ${REGISTRY}:${simpleTag}`);
  lines.push("```");
  lines.push("");

  // Documentation section
  lines.push("## Documentation");
  lines.push("");
  lines.push(
    `- [Extension Catalog](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/EXTENSIONS.md) - Complete list with versions`
  );
  lines.push(
    `- [Architecture](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/ARCHITECTURE.md) - Design decisions`
  );
  lines.push(
    `- [Production Guide](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/PRODUCTION.md) - Deployment best practices`
  );

  return lines.join("\n");
}

/**
 * Main function
 */
async function main() {
  const args = parseArgs();
  if (!args) {
    process.exit(1);
  }

  // Read manifest
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    console.error(`ERROR: Manifest not found at ${MANIFEST_PATH}`);
    console.error("Run 'bun run generate:manifest' to generate it.");
    process.exit(1);
  }

  const manifest: Manifest = await manifestFile.json();

  // Group extensions by category
  const categoryGroups = groupByCategory(manifest);

  // Generate markdown
  const markdown = generateMarkdown(args, manifest, categoryGroups);

  // Write output
  const outputPath = join(PROJECT_ROOT, args.output);
  await Bun.write(outputPath, markdown);

  console.log(`✓ Release notes generated: ${outputPath}`);
  console.log(`  PostgreSQL: ${args.pgVersion}`);
  console.log(`  Tag: ${args.tag}`);
  console.log(`  Enabled extensions: ${args.catalogEnabled}/${args.catalogTotal}`);
  console.log(`  Categories: ${categoryGroups.length}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
