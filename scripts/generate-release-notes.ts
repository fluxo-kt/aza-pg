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
 *     --output=release-notes.md \
 *     [--package-version-id=585941799] \
 *     [--compressed-size="247.79 MB"] \
 *     [--uncompressed-size="894.07 MB"] \
 *     [--layer-count=36] \
 *     [--base-image-name="postgres:18.1-trixie"] \
 *     [--base-image-digest="sha256:..."]
 *
 * Arguments:
 *   --pg-version          PostgreSQL version (e.g., "18.1")
 *   --tag                 Full image tag (e.g., "18.1-202511132330-single-node")
 *   --digest              Image digest (e.g., "sha256:abc123...")
 *   --catalog-enabled     Number of enabled extensions
 *   --output              Output markdown file path
 *   --package-version-id  (Optional) GHCR package version ID for package link
 *   --compressed-size     (Optional) Compressed image size (e.g., "247.79 MB")
 *   --uncompressed-size   (Optional) Uncompressed image size (e.g., "894.07 MB")
 *   --layer-count         (Optional) Number of image layers
 *   --base-image-name     (Optional) Base image name (e.g., "postgres:18.1-trixie")
 *   --base-image-digest   (Optional) Base image digest (e.g., "sha256:abc...")
 */

import { join } from "node:path";
import type { ManifestEntry } from "./extensions/manifest-data.ts";
import { warning } from "./utils/logger";

const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");
const CHANGELOG_PATH = join(PROJECT_ROOT, "CHANGELOG.md");

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
  output: string;
  packageVersionId?: number; // Optional for backward compatibility
  compressedSize?: string; // Optional: formatted compressed size (e.g., "247.79 MB")
  uncompressedSize?: string; // Optional: formatted uncompressed size (e.g., "894.07 MB")
  layerCount?: number; // Optional: number of layers
  baseImageName?: string; // Optional: base image name (e.g., "postgres:18.1-trixie")
  baseImageDigest?: string; // Optional: base image digest (e.g., "sha256:abc...")
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
  installMethod: "builtin" | "pgdg" | "percona" | "timescale" | "github-release" | "source";
}

// Category merge map: source → target
// Merges single-extension categories into related larger categories
const CATEGORY_MERGE: Record<string, string> = {
  analytics: "observability", // hll → observability
  cdc: "operations", // wal2json → operations
  validation: "utilities", // pg_jsonschema → utilities
  safety: "security", // pg_safeupdate → security
  workflow: "queueing", // pgflow → queueing
  language: "indexing", // plpgsql → indexing (as "Core Extensions")
};

// Category display names mapping (ordered by importance)
// Note: Merged categories get updated display names
const CATEGORY_NAMES: Record<string, string> = {
  ai: "AI/ML & Vector Search",
  timeseries: "Time-Series",
  search: "Full-Text Search",
  security: "Security & Auditing", // includes safety
  observability: "Observability & Analytics", // includes analytics
  performance: "Performance",
  operations: "Operations & CDC", // includes cdc
  maintenance: "Maintenance",
  integration: "Integration & FDW",
  queueing: "Queueing & Workflows", // includes workflow
  quality: "Quality & Testing",
  gis: "GIS & Spatial",
  utilities: "Utilities & Validation", // includes validation
  indexing: "Core Extensions", // includes language
};

// Category order (consolidated from 19 to ~13)
const CATEGORY_ORDER = [
  "ai",
  "timeseries",
  "search",
  "security",
  "observability",
  "performance",
  "operations",
  "maintenance",
  "integration",
  "queueing",
  "quality",
  "gis",
  "utilities",
  "indexing",
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
  const output = getArg("output");
  const packageVersionId = getArg("package-version-id"); // Optional
  const compressedSize = getArg("compressed-size"); // Optional
  const uncompressedSize = getArg("uncompressed-size"); // Optional
  const layerCount = getArg("layer-count"); // Optional
  const baseImageName = getArg("base-image-name"); // Optional
  const baseImageDigest = getArg("base-image-digest"); // Optional

  // Validate required args
  if (!pgVersion || !tag || !digest || !catalogEnabled || !output) {
    console.error("ERROR: Missing required arguments");
    console.error("");
    console.error("Usage:");
    console.error("  bun scripts/generate-release-notes.ts \\");
    console.error("    --pg-version=18.1 \\");
    console.error("    --tag=18.1-202511132330-single-node \\");
    console.error("    --digest=sha256:abc123... \\");
    console.error("    --catalog-enabled=36 \\");
    console.error("    --output=release-notes.md \\");
    console.error("    [--package-version-id=585941799]  # Optional: GHCR package version ID");
    console.error("    [--compressed-size='247.79 MB']   # Optional: Compressed image size");
    console.error("    [--uncompressed-size='894.07 MB'] # Optional: Uncompressed image size");
    console.error("    [--layer-count=36]                # Optional: Number of layers");
    console.error("    [--base-image-name='postgres:18.1-trixie']  # Optional: Base image name");
    console.error("    [--base-image-digest='sha256:...'] # Optional: Base image digest");
    return null;
  }

  return {
    pgVersion,
    tag,
    digest,
    catalogEnabled: parseInt(catalogEnabled, 10),
    output,
    packageVersionId: packageVersionId ? parseInt(packageVersionId, 10) : undefined,
    compressedSize,
    uncompressedSize,
    layerCount: layerCount ? parseInt(layerCount, 10) : undefined,
    baseImageName,
    baseImageDigest,
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

    // Handle name_version patterns (e.g., wal2json_2_6 -> 2.6, pgflow@0.7.2 -> 0.7.2)
    // Extract numeric version from patterns like "name_X_Y" or "name@X.Y.Z"
    const nameVersionMatch = version.match(/^[a-zA-Z][a-zA-Z0-9]*[_@](.+)$/);
    if (nameVersionMatch?.[1]) {
      version = nameVersionMatch[1];
    }

    // Replace underscores with dots for versioned tags
    // Examples: 2_6 -> 2.6, 4_2_0 -> 4.2.0
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

// Source installation method emoji badges
// Note: All emojis use variation selector (U+FE0F) for consistent rendering
// Pre-compiled packages (pgdg, percona, timescale, github-release) all use 📦️
// Source-built extensions use 🏗️
const SOURCE_EMOJI: Record<ExtensionInfo["installMethod"], string> = {
  builtin: "⚙️",
  pgdg: "📦️",
  percona: "📦️",
  timescale: "📦️",
  "github-release": "📦️",
  source: "🏗️",
};

/**
 * Format extension markdown with links
 * Format: {source_emoji} **[name](source)** [`version`](release) 📖 — Description
 */
function formatExtensionMarkdown(ext: ExtensionInfo): string {
  const { displayName, version, sourceUrl, docsUrl, description, installMethod } = ext;

  // Source badge at line start
  const sourceEmoji = SOURCE_EMOJI[installMethod];

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

  return `- ${sourceEmoji} ${nameMarkdown}${versionMarkdown}${badgeText}${docsLinkMarkdown} — ${description}`;
}

/**
 * Group enabled extensions by category (with merging)
 */
function groupByCategory(manifest: Manifest): CategoryGroup[] {
  const enabledExtensions = manifest.entries.filter((e) => e.enabled !== false);

  // Group by category (applying merge map)
  const categoryMap = new Map<string, ExtensionInfo[]>();

  for (const entry of enabledExtensions) {
    // Apply category merge: redirect source categories to their targets
    const rawCategory = entry.category;
    const category = CATEGORY_MERGE[rawCategory] ?? rawCategory;

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
      installMethod:
        entry.kind === "builtin"
          ? "builtin"
          : ((entry.install_via as ExtensionInfo["installMethod"]) ?? "source"),
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
 * Generate Docker Hub link for base image
 * @param baseImageName - Base image name (e.g., "postgres:18.1-trixie")
 * @param baseImageDigest - Base image digest (e.g., "sha256:abc...")
 * @returns Docker Hub URL or null if parameters invalid
 */
function getDockerHubLink(baseImageName: string, baseImageDigest: string): string | null {
  // Extract tag from image name (e.g., "postgres:18.1-trixie" → "18.1-trixie")
  const parts = baseImageName.split(":");
  if (parts.length !== 2) {
    return null;
  }

  const imageName = parts[0]; // "postgres"
  const tag = parts[1]; // "18.1-trixie"

  // Convert digest format: sha256:abc... → sha256-abc...
  const digestForUrl = baseImageDigest.replace(":", "-");

  // Build Docker Hub URL
  // Format: https://hub.docker.com/layers/library/{image}/{tag}/images/{digest}
  return `https://hub.docker.com/layers/library/${imageName}/${tag}/images/${digestForUrl}`;
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
 * Extract [Unreleased] section from CHANGELOG.md
 * Returns the content between ## [Unreleased] and the next ## heading (or ---)
 */
async function extractUnreleasedChangelog(): Promise<string | null> {
  const changelogFile = Bun.file(CHANGELOG_PATH);
  if (!(await changelogFile.exists())) {
    warning("CHANGELOG.md not found, skipping changelog section in release notes");
    return null;
  }

  const content = await changelogFile.text();
  const lines = content.split("\n");

  let inUnreleased = false;
  const unreleasedLines: string[] = [];

  for (const line of lines) {
    // Start capturing after ## [Unreleased]
    if (line.match(/^## \[Unreleased\]/i)) {
      inUnreleased = true;
      continue;
    }

    // Stop at next section (## [...] or ---)
    if (inUnreleased && (line.match(/^## \[/) || line.match(/^---/))) {
      break;
    }

    if (inUnreleased) {
      unreleasedLines.push(line);
    }
  }

  // Trim empty lines from start and end
  while (unreleasedLines.length > 0 && unreleasedLines[0]?.trim() === "") {
    unreleasedLines.shift();
  }
  while (unreleasedLines.length > 0 && unreleasedLines[unreleasedLines.length - 1]?.trim() === "") {
    unreleasedLines.pop();
  }

  if (unreleasedLines.length === 0) {
    return null;
  }

  return unreleasedLines.join("\n");
}

/**
 * Generate Configuration section with collapsible subsections
 */
function generateConfigurationSection(): string[] {
  const lines: string[] = [];

  lines.push("## 🔧 Configuration");
  lines.push("");

  // Prominent volume warning alert box
  lines.push("> ⚠️ **Volume Mount Warning (PostgreSQL 18+)**");
  lines.push("> Mount `/var/lib/postgresql` (**NOT** `/var/lib/postgresql/data`).");
  lines.push(
    "> Wrong path = startup failure. [Details →](https://github.com/fluxo-kt/aza-pg/blob/main/docs/COOLIFY.md#storage-configuration)"
  );
  lines.push("");

  // Environment Variables (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Environment Variables</b></summary>");
  lines.push("");
  lines.push("| Variable | Required | Default | Description |");
  lines.push("|----------|----------|---------|-------------|");
  lines.push("| `POSTGRES_PASSWORD` | ✅ | - | Superuser password |");
  lines.push("| `POSTGRES_USER` | No | `postgres` | Superuser name |");
  lines.push("| `POSTGRES_DB` | No | `postgres` | Default database |");
  lines.push("| `POSTGRES_MEMORY` | No | auto | RAM (MB) for auto-tuning |");
  lines.push("| `POSTGRES_BIND_IP` | No | `127.0.0.1` | Bind address |");
  lines.push(
    "| `POSTGRES_WORKLOAD_TYPE` | No | `mixed` | `web` (200 conn), `oltp` (300 conn), `dw` (100 conn, analytics), `mixed` (120 conn, balanced) |"
  );
  lines.push(
    "| `POSTGRES_STORAGE_TYPE` | No | `ssd` | `ssd` (local NVMe/SSD), `san` (network volumes like Hetzner Volumes), `hdd` (spinning disks) |"
  );
  lines.push(
    "| `POSTGRES_SHARED_PRELOAD_LIBRARIES` | No | [see docs](https://github.com/fluxo-kt/aza-pg/blob/main/docs/ENVIRONMENT-VARIABLES.md) | Override default preloaded extensions |"
  );
  lines.push("| `ENABLE_PGSODIUM_INIT` | No | `false` | Enable pgsodium TCE initialization |");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Volume Mounts (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Volume Mounts</b></summary>");
  lines.push("");
  lines.push("| Path | Purpose | Required |");
  lines.push("|------|---------|----------|");
  lines.push("| `/var/lib/postgresql` | Data directory | Yes |");
  lines.push(
    "| `/backup` | pgBackRest repository (WAL archive + backups for PITR) | Production: Yes, Dev: No |"
  );
  lines.push("");
  lines.push(
    "**Backup storage**: Required for Point-in-Time Recovery and disaster recovery. pgBackRest stores compressed backups (full/differential/incremental) with 7-day retention by default. Storage needs: ~7-10× database size for full retention cycle. Optional for dev/test environments without recovery requirements."
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Ports & Network (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Ports & Network</b></summary>");
  lines.push("");
  lines.push("| Port | Service | Default Bind |");
  lines.push("|------|---------|--------------|");
  lines.push("| 5432 | PostgreSQL | 127.0.0.1 |");
  lines.push("| 6432 | PgBouncer | 127.0.0.1 |");
  lines.push("| 9187 | Prometheus metrics | 127.0.0.1 |");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Connection Defaults (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Connection Defaults</b></summary>");
  lines.push("");
  lines.push("- **User**: `postgres`");
  lines.push("- **Database**: `postgres`");
  lines.push("- **Auth**: SCRAM-SHA-256");
  lines.push("- **Bind**: localhost only (secure by default)");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Resource Requirements (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Resource Requirements</b></summary>");
  lines.push("");
  lines.push("| Tier | Memory | CPU |");
  lines.push("|------|--------|-----|");
  lines.push("| Minimum | 512MB | 0.5 |");
  lines.push("| Production | 2GB+ | 2+ |");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Health Check (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Health Check</b></summary>");
  lines.push("");
  lines.push("7-tier validation via `pg_isready`:");
  lines.push("- Interval: 10s, Timeout: 5s");
  lines.push("- Start period: 120s, Retries: 3");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Security Defaults (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Security Defaults</b></summary>");
  lines.push("");
  lines.push("- Non-root user (postgres, UID 999)");
  lines.push("- Data checksums enabled");
  lines.push("- pgaudit audit logging");
  lines.push("- Localhost-only binding");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // pg_safeupdate disable note (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Disabling pg_safeupdate per Database</b></summary>");
  lines.push("");
  lines.push(
    "`pg_safeupdate` blocks UPDATE/DELETE without WHERE. Some services require disabling it:"
  );
  lines.push("");
  lines.push("```sql");
  lines.push("-- Disable for a specific database");
  lines.push("ALTER DATABASE mydb SET safeupdate.enabled = 0;");
  lines.push("");
  lines.push("-- Or for current session only");
  lines.push("SET safeupdate.enabled = 0;");
  lines.push("```");
  lines.push("");
  lines.push("Connection-level: `PGOPTIONS='-c safeupdate.enabled=0' psql ...`");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Workload Type Recommendations (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Workload Type Recommendations</b></summary>");
  lines.push("");
  lines.push("| Workload | `POSTGRES_WORKLOAD_TYPE` | Connections | Use Case |");
  lines.push("|----------|--------------------------|-------------|----------|");
  lines.push(
    "| Web applications | `web` | 200 | High-concurrency apps with short-lived connections |"
  );
  lines.push("| Transaction processing | `oltp` | 300 | Heavy read/write OLTP workloads |");
  lines.push(
    "| Analytics/reporting | `dw` | 100 | Data warehouse queries (stats_target=500, large work_mem) |"
  );
  lines.push(
    "| General purpose | `mixed` (default) | 120 | Balanced configuration for varied workloads |"
  );
  lines.push("");
  lines.push(
    "**Technical details**: Connection limits scale with RAM (<2GB: 50%, 2-4GB: 70%, 4-8GB: 85%, ≥8GB: 100%). DW workload allocates larger WAL buffers (4-16GB) and work_mem (up to 256MB) for complex queries."
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Storage Type Recommendations (collapsible)
  lines.push("<details>");
  lines.push("<summary><b>Storage Type Recommendations</b></summary>");
  lines.push("");
  lines.push("| Storage | `POSTGRES_STORAGE_TYPE` | Use Case |");
  lines.push("|---------|-------------------------|----------|");
  lines.push(
    "| Local NVMe/SSD (e.g., Hetzner CPX VPS) | `ssd` (default) | High-performance local storage (40k+ IOPS, <0.1ms latency) |"
  );
  lines.push(
    "| Network volumes (e.g., Hetzner Volumes, AWS EBS) | `san` | Network-attached block storage (5-10k IOPS, ~0.5ms latency) |"
  );
  lines.push(
    "| Traditional spinning disks | `hdd` | Legacy/archive systems (optimizes for sequential scans) |"
  );
  lines.push("");
  lines.push(
    "**Technical details**: `ssd` uses random_page_cost=1.1 (favors index scans), `san` uses random_page_cost=1.1 with higher I/O concurrency (300) for network latency compensation, `hdd` uses random_page_cost=4.0 (favors sequential scans)."
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // pgsodium TCE callout
  lines.push("> ⚠️ **pgsodium TCE Setup**");
  lines.push(
    `> For Transparent Column Encryption, set \`ENABLE_PGSODIUM_INIT=true\` and mount \`pgsodium_getkey\` script. [Setup Guide →](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/PGSODIUM-SETUP.md)`
  );
  lines.push("");

  // Link to full docs
  lines.push(
    "[→ Full configuration guide](https://github.com/fluxo-kt/aza-pg/blob/main/docs/PRODUCTION.md)"
  );
  lines.push("");

  return lines;
}

/**
 * Generate markdown release notes
 */
function generateMarkdown(
  args: Args,
  manifest: Manifest,
  categoryGroups: CategoryGroup[],
  changelogContent: string | null
): string {
  const lines: string[] = [];

  // Extract version components
  const convenienceTags = getConvenienceTags(args.tag, args.pgVersion);

  // Count special extensions (only from enabled entries)
  const enabledEntries = manifest.entries.filter((e) => e.enabled !== false);
  const preloadedCount = enabledEntries.filter((e) => e.runtime?.sharedPreload).length;
  const autoCreatedCount = enabledEntries.filter((e) => e.runtime?.defaultEnable).length;

  // Header with improved summary
  lines.push(`# aza-pg PostgreSQL ${args.pgVersion}`);
  lines.push("");
  lines.push(
    `Production-ready PostgreSQL ${args.pgVersion} with **${args.catalogEnabled} extensions** ` +
      `(${preloadedCount} preloaded, ${autoCreatedCount} auto-created) across ${categoryGroups.length} categories. ` +
      `Auto-tuned for web, OLTP, analytics, and mixed workloads.`
  );
  lines.push("");

  // What's Changed section from CHANGELOG.md (if available)
  if (changelogContent) {
    lines.push("## 📋 What's Changed");
    lines.push("");
    // Add changelog content as blockquote for visual distinction
    const changelogLines = changelogContent.split("\n");
    for (const line of changelogLines) {
      // Convert ### headings to bold text within the blockquote
      if (line.startsWith("### ")) {
        lines.push(`> **${line.slice(4)}**`);
      } else if (line.trim() === "") {
        lines.push(">");
      } else {
        lines.push(`> ${line}`);
      }
    }
    lines.push("");
  }

  // GHCR Package Link (prominent)
  // Use package version ID if provided, otherwise fall back to digest short (legacy)
  const packageId =
    args.packageVersionId?.toString() ?? args.digest.replace("sha256:", "").substring(0, 12);
  lines.push("## 📦️ Package");
  lines.push("");
  lines.push(
    `**[View on GitHub Container Registry →](https://github.com/${REPO_OWNER}/${REPO_NAME}/pkgs/container/${REPO_NAME}/${packageId}?tag=${args.tag})**`
  );
  lines.push("");
  lines.push(`- **Registry**: \`${REGISTRY}\``);
  lines.push(`- **Digest**: \`${args.digest}\``);
  lines.push(`- **Tags**: \`${args.tag}\`, \`${convenienceTags.join("`, `")}\``);
  lines.push("");

  // Image Details section
  lines.push("## 🐳 Image Details");
  lines.push("");
  lines.push(`- **PostgreSQL Version**: ${args.pgVersion}`);

  // Format base image with optional Docker Hub link
  if (args.baseImageName && args.baseImageDigest) {
    const dockerHubLink = getDockerHubLink(args.baseImageName, args.baseImageDigest);
    if (dockerHubLink) {
      lines.push(`- **Base Image**: [${args.baseImageName}](${dockerHubLink}) (SHA-pinned)`);
    } else {
      lines.push(`- **Base Image**: ${args.baseImageName} (SHA-pinned)`);
    }
  } else {
    // Fallback to default format if base image info not provided
    lines.push(`- **Base Image**: postgres:${args.pgVersion}-trixie (SHA-pinned)`);
  }

  lines.push("- **Platforms**: linux/amd64, linux/arm64 (native builds, no QEMU)");
  lines.push(`- **Extensions**: ${args.catalogEnabled}`);
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

  // Get auto-created extension names (sorted alphabetically)
  const autoCreatedNames = manifest.entries
    .filter((e) => e.runtime?.defaultEnable === true)
    .map((e) => e.name)
    .sort();

  // Get enabled extensions that are NOT auto-created (for on-demand examples)
  // Filter: enabled, not auto-created, not preload-only, and is an extension (not tool)
  const onDemandExamples = manifest.entries
    .filter(
      (e) =>
        e.enabled !== false &&
        e.runtime?.defaultEnable !== true &&
        e.runtime?.preloadOnly !== true &&
        e.kind !== "tool"
    )
    .map((e) => e.name)
    .sort()
    .slice(0, 2); // Pick first 2 alphabetically for examples

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
  lines.push(`-- Auto-created extensions (${autoCreatedNames.length} ready to use):`);
  lines.push(`-- ${autoCreatedNames.join(", ")}`);
  if (onDemandExamples.length > 0) {
    lines.push("");
    lines.push("-- Enable additional extensions on-demand:");
    for (const name of onDemandExamples) {
      lines.push(`CREATE EXTENSION ${name};`);
    }
  }
  lines.push("");
  lines.push("-- List all available:");
  lines.push("SELECT name, default_version, comment ");
  lines.push("FROM pg_available_extensions ");
  lines.push("ORDER BY name;");
  lines.push("```");
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
  lines.push("**Source:**");
  lines.push("- ⚙️ PostgreSQL contrib (bundled with PostgreSQL)");
  lines.push("- 📦️ Package (pre-compiled from PGDG, Percona, Timescale, or GitHub releases)");
  lines.push("- 🏗️ Source build (compiled during Docker image build)");
  lines.push("");
  lines.push("**Status:**");
  lines.push("- ⚡ preloaded: Loaded via `shared_preload_libraries` on startup");
  lines.push("- ✨ auto-created: Automatically created in new databases");
  lines.push("- 🔧 preload-only: Module only (no `CREATE EXTENSION` needed)");
  lines.push("- _No badge_: Available on-demand via `CREATE EXTENSION`");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Configuration section (with collapsible subsections)
  lines.push(...generateConfigurationSection());

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
  lines.push(
    `- [Environment Variables](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/ENVIRONMENT-VARIABLES.md) — Complete variable reference`
  );
  lines.push(
    `- [pgsodium Setup](https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/docs/PGSODIUM-SETUP.md) — TCE & vault configuration`
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

  // Extract changelog content from [Unreleased] section
  const changelogContent = await extractUnreleasedChangelog();

  // Generate markdown
  const markdown = generateMarkdown(args, manifest, categoryGroups, changelogContent);

  // Write output
  const outputPath = join(PROJECT_ROOT, args.output);
  await Bun.write(outputPath, markdown);

  console.log(`✓ Release notes generated: ${outputPath}`);
  console.log(`  PostgreSQL: ${args.pgVersion}`);
  console.log(`  Tag: ${args.tag}`);
  console.log(`  Enabled extensions: ${args.catalogEnabled}`);
  console.log(`  Categories: ${categoryGroups.length}`);
  console.log(`  Changelog: ${changelogContent ? "included" : "not found"}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
