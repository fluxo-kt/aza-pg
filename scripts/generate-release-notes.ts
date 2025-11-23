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
 *     --output=release-notes.md \
 *     [--package-version-id=585941799] \
 *     [--compressed-size="247.79 MB"] \
 *     [--uncompressed-size="894.07 MB"] \
 *     [--layer-count=36]
 *
 * Arguments:
 *   --pg-version          PostgreSQL version (e.g., "18.1")
 *   --tag                 Full image tag (e.g., "18.1-202511132330-single-node")
 *   --digest              Image digest (e.g., "sha256:abc123...")
 *   --catalog-enabled     Number of enabled extensions
 *   --catalog-total       Total extensions in catalog
 *   --output              Output markdown file path
 *   --package-version-id  (Optional) GHCR package version ID for package link
 *   --compressed-size     (Optional) Compressed image size (e.g., "247.79 MB")
 *   --uncompressed-size   (Optional) Uncompressed image size (e.g., "894.07 MB")
 *   --layer-count         (Optional) Number of image layers
 */

import { join } from "node:path";
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
  packageVersionId?: number; // Optional for backward compatibility
  compressedSize?: string; // Optional: formatted compressed size (e.g., "247.79 MB")
  uncompressedSize?: string; // Optional: formatted uncompressed size (e.g., "894.07 MB")
  layerCount?: number; // Optional: number of layers
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
  isPreloaded: boolean;
  isAutoCreated: boolean;
  isPreloadOnly: boolean;
  sourceUrl?: string;
  docsUrl?: string;
  source: ManifestEntry["source"];
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
  const packageVersionId = getArg("package-version-id"); // Optional
  const compressedSize = getArg("compressed-size"); // Optional
  const uncompressedSize = getArg("uncompressed-size"); // Optional
  const layerCount = getArg("layer-count"); // Optional

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
    console.error("    --output=release-notes.md \\");
    console.error("    [--package-version-id=585941799]  # Optional: GHCR package version ID");
    console.error("    [--compressed-size='247.79 MB']   # Optional: Compressed image size");
    console.error("    [--uncompressed-size='894.07 MB'] # Optional: Uncompressed image size");
    console.error("    [--layer-count=36]                # Optional: Number of layers");
    return null;
  }

  return {
    pgVersion,
    tag,
    digest,
    catalogEnabled: parseInt(catalogEnabled, 10),
    catalogTotal: parseInt(catalogTotal, 10),
    output,
    packageVersionId: packageVersionId ? parseInt(packageVersionId, 10) : undefined,
    compressedSize,
    uncompressedSize,
    layerCount: layerCount ? parseInt(layerCount, 10) : undefined,
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
 * Generate version link for an extension based on its source type
 */
function getVersionLink(ext: ExtensionInfo): string | null {
  const { source, sourceUrl } = ext;

  // Built-in extensions - no version link
  if (source.type === "builtin") {
    return null;
  }

  // No source URL - can't generate link
  if (!sourceUrl) {
    return null;
  }

  // Extract repository base URL (remove .git suffix if present)
  const repoBase = sourceUrl.replace(/\.git$/, "");

  // Git source with tag - link to release or tag
  if (source.type === "git" && source.tag) {
    // Try releases first (most common on GitHub)
    // Fall back to tree view if releases aren't available
    return `${repoBase}/releases/tag/${source.tag}`;
  }

  // Git ref source (commit SHA) - link to specific commit
  if (source.type === "git-ref" && source.ref) {
    return `${repoBase}/commit/${source.ref}`;
  }

  return null;
}

/**
 * Format extension markdown with links
 * Format: **[name](source)** [`version`](release) 📖 — Description
 */
function formatExtensionMarkdown(ext: ExtensionInfo): string {
  const { displayName, version, sourceUrl, docsUrl, description } = ext;

  // Format name (with link if sourceUrl available)
  const nameMarkdown = sourceUrl ? `**[${displayName}](${sourceUrl})**` : `**${displayName}**`;

  // Format version (with link if version link available)
  let versionMarkdown = "";
  if (version !== "builtin") {
    const versionLink = getVersionLink(ext);
    versionMarkdown = versionLink ? ` [\`${version}\`](${versionLink})` : ` \`${version}\``;
  }

  // Format status badges
  const badges: string[] = [];
  if (ext.isPreloadOnly) {
    badges.push("🔧 preload-only");
  } else if (ext.isPreloaded && ext.isAutoCreated) {
    badges.push("⚡ preloaded+auto-created");
  } else if (ext.isPreloaded) {
    badges.push("⚡ preloaded");
  } else if (ext.isAutoCreated) {
    badges.push("✨ auto-created");
  }
  const badgeText = badges.length > 0 ? ` _${badges.join(", ")}_` : "";

  // Add docs link icon if docsUrl is different from sourceUrl
  const docsLinkMarkdown =
    docsUrl && docsUrl !== sourceUrl && !docsUrl.includes(sourceUrl || "N/A")
      ? ` [📖](${docsUrl})`
      : "";

  return `- ${nameMarkdown}${versionMarkdown}${badgeText}${docsLinkMarkdown} — ${description}`;
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
      isPreloaded: entry.runtime?.sharedPreload === true,
      isAutoCreated: entry.runtime?.defaultEnable === true,
      isPreloadOnly: entry.runtime?.preloadOnly === true,
      sourceUrl: entry.sourceUrl,
      docsUrl: entry.docsUrl,
      source: entry.source,
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
  const pgMajor: string = pgVersion.split(".")[0] ?? pgVersion;

  // Parse tag format: {pg_version}-{timestamp}-{type}
  // Timestamp is exactly 12 digits (YYYYMMDDHHmm)
  // Type can contain hyphens (e.g., "single-node")
  const match = fullTag.match(/^([\d.]+)-(\d{12})-(.+)$/);

  if (!match) {
    warning(`Could not parse tag format: ${fullTag}`);
    return []; // Return empty array if parsing fails
  }

  const [, pgVersionPart, , typePart] = match;

  // Ensure extracted parts are defined (regex already validated)
  const versionPart: string = pgVersionPart!;
  const type: string = typePart!;

  // Return all 4 convenience tags in order:
  // 1. {pg_version}-{type} (e.g., 18.1-single-node)
  // 2. {pg_major}-{type} (e.g., 18-single-node)
  // 3. {pg_version} (e.g., 18.1)
  // 4. {pg_major} (e.g., 18)
  return [`${versionPart}-${type}`, `${pgMajor}-${type}`, versionPart, pgMajor];
}

/**
 * Generate markdown release notes
 */
function generateMarkdown(args: Args, manifest: Manifest, categoryGroups: CategoryGroup[]): string {
  const lines: string[] = [];

  // Extract version components
  const convenienceTags = getConvenienceTags(args.tag, args.pgVersion);

  // Count special extensions
  const preloadedCount = manifest.entries.filter((e) => e.runtime?.sharedPreload).length;
  const autoCreatedCount = manifest.entries.filter((e) => e.runtime?.defaultEnable).length;

  // Header with improved summary
  lines.push(`# aza-pg PostgreSQL ${args.pgVersion}`);
  lines.push("");
  lines.push(
    `Production-ready PostgreSQL ${args.pgVersion} with **${args.catalogEnabled} extensions** ` +
      `(${preloadedCount} preloaded, ${autoCreatedCount} auto-created) across ${categoryGroups.length} categories. ` +
      `Auto-tuned for web, OLTP, analytics, and mixed workloads.`
  );
  lines.push("");

  // GHCR Package Link (prominent)
  // Use package version ID if provided, otherwise fall back to digest short (legacy)
  const packageId =
    args.packageVersionId?.toString() ?? args.digest.replace("sha256:", "").substring(0, 12);
  lines.push("## 📦 Package");
  lines.push("");
  lines.push(
    `**[View on GitHub Container Registry →](https://github.com/${REPO_OWNER}/${REPO_NAME}/pkgs/container/${REPO_NAME}/${packageId}?tag=${args.tag})**`
  );
  lines.push("");
  lines.push(`- **Registry**: \`${REGISTRY}\``);
  lines.push(`- **Digest**: \`${args.digest}\``);
  lines.push(`- **Tags**: \`${args.tag}\`, \`${convenienceTags.join("`, `")}\``);
  lines.push("");

  // Quick Start section (moved to top)
  lines.push("## 🚀 Quick Start");
  lines.push("");
  lines.push("```bash");
  lines.push("# Pull and run");
  lines.push(`docker pull ${REGISTRY}:${args.tag}`);
  lines.push("");
  lines.push("docker run -d \\");
  lines.push("  --name postgres \\");
  lines.push("  -e POSTGRES_PASSWORD=secure \\");
  lines.push("  -e POSTGRES_WORKLOAD_TYPE=web \\");
  lines.push("  -p 5432:5432 \\");
  lines.push(`  ${REGISTRY}:${args.tag}`);
  lines.push("```");
  lines.push("");
  lines.push("```sql");
  lines.push("-- Extensions are auto-created by default:");
  lines.push("-- pg_cron, pg_stat_statements, pg_trgm, pgaudit, vector");
  lines.push("");
  lines.push("-- Enable additional extensions on-demand:");
  lines.push("CREATE EXTENSION timescaledb;");
  lines.push("CREATE EXTENSION postgis;");
  lines.push("");
  lines.push("-- List all available:");
  lines.push("SELECT name, default_version, comment ");
  lines.push("FROM pg_available_extensions ");
  lines.push("ORDER BY name;");
  lines.push("```");
  lines.push("");

  // Image Details section
  lines.push("## 🐳 Image Details");
  lines.push("");
  lines.push(`- **PostgreSQL Version**: ${args.pgVersion}`);
  lines.push(`- **Base Image**: postgres:${args.pgVersion}-trixie (SHA-pinned)`);
  lines.push("- **Platforms**: linux/amd64, linux/arm64 (native builds, no QEMU)");
  lines.push(`- **Total Extensions**: ${args.catalogEnabled} enabled, ${args.catalogTotal} total`);
  lines.push(`- **Preloaded**: ${preloadedCount} (shared_preload_libraries)`);
  lines.push(`- **Auto-Created**: ${autoCreatedCount} (created by default in new databases)`);
  lines.push(`- **Build**: Single-node optimized`);

  // Add size metrics if provided
  if (args.compressedSize || args.uncompressedSize || args.layerCount !== undefined) {
    if (args.compressedSize) {
      lines.push(`- **Compressed Size**: ${args.compressedSize} (wire transfer)`);
    }
    if (args.uncompressedSize) {
      lines.push(`- **Uncompressed Size**: ${args.uncompressedSize} (disk usage)`);
    }
    if (args.layerCount !== undefined) {
      lines.push(`- **Layers**: ${args.layerCount}`);
    }
  }

  lines.push("");

  // What's Inside section with status markers
  lines.push("## 📚 Extensions Catalog");
  lines.push("");

  for (const group of categoryGroups) {
    const count = group.extensions.length;
    const countText = count === 1 ? "extension" : "extensions";
    lines.push(`### ${group.displayName} (${count} ${countText})`);
    lines.push("");

    for (const ext of group.extensions) {
      lines.push(formatExtensionMarkdown(ext));
    }

    lines.push("");
  }

  lines.push("<details>");
  lines.push("<summary><b>Legend</b></summary>");
  lines.push("");
  lines.push("- **⚡ preloaded**: Loaded via `shared_preload_libraries` on startup");
  lines.push("- **✨ auto-created**: Automatically created in new databases");
  lines.push("- **🔧 preload-only**: Module only (no `CREATE EXTENSION` needed)");
  lines.push("- _No badge_: Available on-demand via `CREATE EXTENSION`");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Auto-Configuration section
  lines.push("## ⚙️ Auto-Configuration");
  lines.push("");
  lines.push("Automatically detects and optimizes PostgreSQL settings:");
  lines.push("");
  lines.push("**Resource Detection:**");
  lines.push("- RAM: Optimizes `shared_buffers` (up to 32GB), `work_mem` (up to 32MB)");
  lines.push("- CPU: Tunes `max_parallel_workers`, `max_worker_processes`");
  lines.push("");
  lines.push("**Workload Profiles** (`POSTGRES_WORKLOAD_TYPE`):");
  lines.push("- `web` (default): max_connections=200, balanced OLTP + read-heavy");
  lines.push("- `oltp`: max_connections=300, high-concurrency transactions");
  lines.push("- `dw`: max_connections=100, analytics/data warehouse (high statistics_target=500)");
  lines.push("- `mixed`: max_connections=120, general-purpose balanced");
  lines.push("");
  lines.push("**Storage Tuning** (`POSTGRES_STORAGE_TYPE`):");
  lines.push("- `ssd` (default): random_page_cost=1.1, effective_io_concurrency=200");
  lines.push("- `hdd`: random_page_cost=4.0, effective_io_concurrency=2");
  lines.push("- `san`: random_page_cost=1.1, effective_io_concurrency=1");
  lines.push("");

  // Verification section
  lines.push("## ✅ Verification");
  lines.push("");
  lines.push("```bash");
  lines.push("# Verify Cosign signature (keyless OIDC)");
  lines.push("cosign verify \\");
  lines.push(
    `  --certificate-identity-regexp="^https://github.com/${REPO_OWNER}/${REPO_NAME}/" \\`
  );
  lines.push('  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \\');
  lines.push(`  ${REGISTRY}:${args.tag}`);
  lines.push("");
  lines.push("# View embedded version info");
  lines.push(`docker run --rm ${REGISTRY}:${args.tag} cat /etc/postgresql/version-info.txt`);
  lines.push("");
  lines.push("# Download SBOM");
  lines.push(`cosign download sbom ${REGISTRY}:${args.tag}`);
  lines.push("```");
  lines.push("");

  // Documentation section
  lines.push("## 📖 Documentation");
  lines.push("");
  lines.push(
    `- [Extension Catalog](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/EXTENSIONS.md) — Complete list with detailed info`
  );
  lines.push(
    `- [Production Guide](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/PRODUCTION.md) — Deployment best practices`
  );
  lines.push(
    `- [Architecture](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/ARCHITECTURE.md) — Design decisions`
  );
  lines.push(
    `- [Testing](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/TESTING.md) — Validation & test suite`
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
