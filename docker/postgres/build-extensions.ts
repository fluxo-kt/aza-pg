#!/usr/bin/env bun
/**
 * PostgreSQL Extension Build Orchestrator
 *
 * Orchestrates building 30+ PostgreSQL extensions with 8+ different build systems.
 * This is the MOST CRITICAL script in the codebase - handles cargo-pgrx version
 * management, git cloning with SHA verification, manifest parsing, and compilation.
 *
 * Build Systems Supported:
 * - pgxs: PostgreSQL Extension Build System
 * - cargo-pgrx: Rust pgrx framework (versioned)
 * - timescaledb: Custom bootstrap build
 * - autotools: ./configure && make
 * - cmake: CMake build
 * - meson: Meson build
 * - make: Generic make install
 * - script: Custom build scripts
 */

import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ────────────────────────────────────────────────────────────────────────────

interface SourceSpec {
  type: "builtin" | "git" | "git-ref";
  repository?: string;
  commit?: string;
  tag?: string;
  ref?: string;
}

interface BuildSpec {
  type: "pgxs" | "cargo-pgrx" | "timescaledb" | "autotools" | "cmake" | "meson" | "make" | "script";
  subdir?: string;
  features?: string[];
  noDefaultFeatures?: boolean;
  mesonOptions?: string[];
  makeOptions?: string[];
  script?: string;
  patches?: string[];
}

interface SourceLibrary {
  source: { repository: string; tag: string };
  asset: string;
  sha256: string;
}

interface RuntimeSpec {
  sharedPreload?: boolean;
  defaultEnable?: boolean;
  preloadOnly?: boolean;
  notes?: string[];
}

interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "tool" | "builtin";
  category: string;
  description: string;
  source: SourceSpec;
  build?: BuildSpec;
  runtime?: RuntimeSpec;
  dependencies?: string[];
  provides?: string[];
  aptPackages?: string[];
  sourceLibraries?: string[];
  soFileName?: string;
  notes?: string[];
  install_via?: "pgdg" | "percona" | "source";
  perconaVersion?: string;
  perconaPackage?: string;
  enabled?: boolean;
  disabledReason?: string;
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
  sourceLibraries?: Record<string, SourceLibrary>;
}

// ────────────────────────────────────────────────────────────────────────────
// Global State
// ────────────────────────────────────────────────────────────────────────────

const CARGO_PGRX_INIT = new Map<string, boolean>();

// Environment configuration
const MANIFEST_PATH = Bun.argv[2];
const BUILD_ROOT = Bun.argv[3] || "/tmp/extensions-build";
const PG_MAJOR = Bun.env.PG_MAJOR || "18";
const PG_CONFIG_BIN = Bun.env.PG_CONFIG || `/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config`;
const NPROC = await $`nproc`.text().then((s) => s.trim());

// Update PATH and cargo environment
process.env.PATH = `/root/.cargo/bin:${process.env.PATH}`;
process.env.CARGO_NET_GIT_FETCH_WITH_CLI = "true";

// ────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[ext-build] ${message}`);
}

async function ensureCleanDir(dir: string): Promise<void> {
  // Use fs.rm (not Bun shell rm) — Bun's shell rm built-in fails on deeply nested
  // directories (e.g. pgroonga regression test trees) with "Directory not empty".
  // force:true is the nothrow equivalent: silently succeeds if dir doesn't exist.
  await rm(dir, { recursive: true, force: true });
  await Bun.write(`${dir}/.gitkeep`, "");
}

// ────────────────────────────────────────────────────────────────────────────
// Git URL Validation
// ────────────────────────────────────────────────────────────────────────────

function validateGitUrl(url: string): void {
  const allowedDomains = ["github.com", "gitlab.com"];

  // Extract domain from URL
  const httpsDomain = url.match(/^https?:\/\/([^/]+)/)?.[1];
  const gitDomain = url.match(/^git@([^:]+):/)?.[1];

  let domain: string;
  if (httpsDomain) {
    domain = httpsDomain;
  } else if (gitDomain) {
    domain = gitDomain;
  } else {
    log(`ERROR: Invalid git URL format: ${url}`);
    process.exit(1);
  }

  if (!allowedDomains.includes(domain)) {
    log(`ERROR: Git repository domain '${domain}' not in allowlist`);
    log(`Allowed domains: ${allowedDomains.join(", ")}`);
    process.exit(1);
  }
}

async function gitWithRetry(args: string[], label: string, maxAttempts = 5): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await $`git -c http.version=HTTP/1.1 ${args}`.quiet().nothrow();
    if (result.exitCode === 0) return result.stdout.toString();

    lastError = result.stderr.toString().trim() || result.stdout.toString().trim();
    if (attempt < maxAttempts) {
      log(`${label} failed (attempt ${attempt}/${maxAttempts}); retrying`);
      await Bun.sleep(1000 * attempt);
    }
  }

  throw new Error(`${label} failed after ${maxAttempts} attempts: ${lastError}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Git Repository Cloning
// ────────────────────────────────────────────────────────────────────────────

async function cloneRepo(repo: string, commit: string, target: string): Promise<void> {
  // Validate URL before cloning (security: prevent arbitrary git clones)
  validateGitUrl(repo);

  log(`Cloning ${repo} @ ${commit} (shallow)`);

  // Shallow clone: fetch only the specific commit
  // Benefits: faster clone, reduced disk usage, smaller attack surface
  await gitWithRetry(["init", target], `git init ${target}`);
  await gitWithRetry(["-C", target, "remote", "add", "origin", repo], `git remote add ${repo}`);

  // Try shallow fetch first, fallback to full fetch if server rejects
  try {
    await gitWithRetry(
      ["-C", target, "fetch", "--depth", "1", "origin", commit],
      `shallow fetch ${repo} @ ${commit}`
    );
  } catch {
    log(`Shallow fetch failed, falling back to full fetch for ${commit}`);
    await gitWithRetry(["-C", target, "fetch", "origin", commit], `fetch ${repo} @ ${commit}`);
  }

  await gitWithRetry(["-C", target, "checkout", "--quiet", commit], `checkout ${commit}`);

  // Initialize submodules if present
  if (await Bun.file(join(target, ".gitmodules")).exists()) {
    await gitWithRetry(
      ["-C", target, "submodule", "update", "--init", "--recursive"],
      `submodule update ${repo}`
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cargo PGRX Version Management
// ────────────────────────────────────────────────────────────────────────────

async function ensureCargoPgrx(version: string): Promise<string> {
  const installRoot = `/root/.cargo-pgrx/${version}`;
  const cargoPgrxBin = join(installRoot, "bin", "cargo-pgrx");

  if (!(await Bun.file(cargoPgrxBin).exists())) {
    log(`Installing cargo-pgrx ${version}`);
    // Temporarily unset RUSTFLAGS to avoid conflicts with cargo-pgrx installation
    // RUSTFLAGS optimization should only apply to extension builds, not build tools
    const savedRustflags = process.env.RUSTFLAGS;
    delete process.env.RUSTFLAGS;
    try {
      await $`cargo install --locked cargo-pgrx --version ${version} --root ${installRoot}`;
    } finally {
      if (savedRustflags !== undefined) {
        process.env.RUSTFLAGS = savedRustflags;
      }
    }
  }

  return installRoot;
}

async function ensurePgrxInitForVersion(installRoot: string, version: string): Promise<void> {
  if (CARGO_PGRX_INIT.get(version)) {
    return;
  }

  const pathEnv = `${installRoot}/bin:${process.env.PATH}`;

  // cargo pgrx init is idempotent - safe to run multiple times
  // Note: "cargo pgrx list" was removed in v0.16+, so we just run init unconditionally
  await $`env PATH=${pathEnv} cargo pgrx init --pg${PG_MAJOR} ${PG_CONFIG_BIN}`;

  CARGO_PGRX_INIT.set(version, true);
}

async function getPgrxVersion(dir: string): Promise<string> {
  const cargoFile = join(dir, "Cargo.toml");
  if (!(await Bun.file(cargoFile).exists())) {
    return "";
  }

  try {
    // Parse TOML using Bun's built-in parser
    const content = await Bun.file(cargoFile).text();
    const lines = content.split("\n");

    // Simple TOML parser for pgrx version (handles both inline and table formats)
    let inDependencies = false;
    for (const line of lines) {
      if (line.trim() === "[dependencies]") {
        inDependencies = true;
        continue;
      }
      if (line.trim().startsWith("[") && line.trim() !== "[dependencies]") {
        inDependencies = false;
        continue;
      }

      if (inDependencies && line.includes("pgrx")) {
        // Handle: pgrx = "0.16.1" or pgrx = { version = "0.16.1", ... }
        const version = line.match(/version\s*=\s*["']([^"']+)["']/)?.[1];
        if (version) {
          return version.startsWith("=") ? version.substring(1) : version;
        }

        // Handle simple string version: pgrx = "0.16.1"
        const simpleVersion = line.match(/pgrx\s*=\s*["']([^"']+)["']/)?.[1];
        if (simpleVersion) {
          return simpleVersion.startsWith("=") ? simpleVersion.substring(1) : simpleVersion;
        }
      }
    }

    return "";
  } catch (error) {
    log(`Warning: Failed to parse Cargo.toml in ${dir}: ${error}`);
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Build System Implementations
// ────────────────────────────────────────────────────────────────────────────

// The image must run on every CPU of its architecture, not only on the build runner's. A binary
// tuned with -march=native passes every test on the runner and dies with SIGILL on an older host,
// so no test can catch it. pgvector's Makefile defaults OPTFLAGS to -march=native; PGXS itself
// never reads OPTFLAGS, so clearing it touches only Makefiles that define it. The dry run then
// refuses any host tuning that arrives under another variable name.
const PORTABLE_PGXS = ["USE_PGXS=1", "OPTFLAGS="];

// The last -O on a command line wins, so an upstream PG_CPPFLAGS = -O0 silently undoes PostgreSQL's
// -O2 (CPPFLAGS follows CFLAGS on PGXS compile lines). Refusing it makes every unoptimised build a
// recorded decision. Lines without any -O (install, mkdir) never match.
export function unoptimisedCompileLine(plan: string): string | undefined {
  return plan.split("\n").find((line) => line.match(/(?<!\S)-O\S*/g)?.at(-1) === "-O0");
}

async function buildPgxs(dir: string, build: BuildSpec): Promise<void> {
  log(`Running pgxs build in ${dir}`);
  const args = [...PORTABLE_PGXS, ...(build.makeOptions ?? [])];
  const plan = await $`make -n -C ${dir} ${args}`.text();
  const native = plan.match(/-m(?:arch|tune|cpu)=native/);
  if (native) {
    throw new Error(
      `${dir}: the build would compile with ${native[0]}, tying the image to the build host's CPU. ` +
        `Find the Makefile variable that adds it and override it in PORTABLE_PGXS (build-extensions.ts).`
    );
  }
  const unoptimised = unoptimisedCompileLine(plan);
  if (unoptimised) {
    throw new Error(
      `${dir}: the build would compile without optimisation (-O0): ${unoptimised.trim()}\n` +
        `Find the Makefile variable that adds -O0 and clear it with build.makeOptions in manifest-data.ts.`
    );
  }
  await $`make -C ${dir} ${args} -j${NPROC}`;
  await $`make -C ${dir} ${args} install`;
}

const builtLibraries = new Set<string>();

// Builds each library the entry links into /usr/local once per run. The tarball is trusted only through
// its pinned SHA-256; the Dockerfile copies /usr/local/lib into the final image.
async function ensureSourceLibraries(entry: ManifestEntry, manifest: Manifest): Promise<void> {
  for (const name of entry.sourceLibraries ?? []) {
    if (builtLibraries.has(name)) continue;
    const lib = manifest.sourceLibraries?.[name];
    if (!lib) throw new Error(`${entry.name}: source library ${name} is not in the manifest`);

    const url = `${lib.source.repository.replace(/\.git$/, "")}/releases/download/${lib.source.tag}/${lib.asset}`;
    log(`Building source library ${name} ${lib.source.tag} for ${entry.name}`);
    let tarball: Uint8Array | undefined;
    for (let attempt = 1; attempt <= 5 && !tarball; attempt++) {
      const response = await fetch(url).catch(() => undefined);
      if (response?.ok) tarball = new Uint8Array(await response.arrayBuffer());
      else if (attempt < 5) await Bun.sleep(1000 * attempt);
    }
    if (!tarball) throw new Error(`${name}: could not download ${url}`);
    const digest = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
    if (digest !== lib.sha256) {
      throw new Error(`${name}: ${url} has sha256 ${digest}, manifest pins ${lib.sha256}`);
    }

    const dir = join(BUILD_ROOT, `lib-${name}`);
    await ensureCleanDir(dir);
    await $`tar -xz -C ${dir} --strip-components=1 < ${new Response(tarball)}`;
    await $`./configure --prefix=/usr/local --disable-static`.cwd(dir);
    await $`make -j${NPROC}`.cwd(dir);
    await $`make install`.cwd(dir);
    await $`ldconfig`;
    builtLibraries.add(name);
  }
}

// trixie's linker searches /usr/lib/<triplet> before /usr/local/lib, so a stray Debian -dev package
// would make the consumer link the old library and still build. Prove the module resolves ours.
async function assertLinksSourceLibraries(entry: ManifestEntry): Promise<void> {
  if (!entry.sourceLibraries?.length) return;
  const pkglibdir = (await $`pg_config --pkglibdir`.text()).trim();
  const module = join(pkglibdir, entry.soFileName ?? `${entry.name}.so`);
  const ldd = await $`ldd ${module}`.text();
  for (const name of entry.sourceLibraries) {
    const resolved = ldd.split("\n").filter((line) => line.trim().startsWith(`${name}.so`));
    if (resolved.length === 0 || !resolved.every((line) => line.includes("=> /usr/local/lib/"))) {
      throw new Error(`${module} does not resolve ${name} from /usr/local/lib:\n${ldd}`);
    }
  }
  log(`${entry.name} links ${entry.sourceLibraries.join(", ")} from /usr/local/lib`);
}

async function buildCargoPgrx(dir: string, entry: ManifestEntry): Promise<void> {
  let version = await getPgrxVersion(dir);
  if (!version) {
    version = "0.16.1";
  }

  const installRoot = await ensureCargoPgrx(version);
  await ensurePgrxInitForVersion(installRoot, version);

  // Build with the crate's own Cargo.lock under --locked: without it cargo resolves every dependency afresh, so
  // one locked commit builds different Rust code from day to day while nothing in this repository changes.
  // cargo reads the lock at the workspace root, which may sit above `dir`. cargo-pgrx has no --locked flag;
  // it appends PGRX_BUILD_FLAGS to its `cargo build`.
  const workspaceManifest = (
    await $`cargo locate-project --workspace --message-format plain`.cwd(dir).text()
  ).trim();
  const lockFile = join(workspaceManifest, "..", "Cargo.lock");
  const locked = await Bun.file(lockFile).exists();
  if (!locked)
    log(`${entry.name}: upstream ships no Cargo.lock; dependencies resolve at build time`);
  const buildFlags = [Bun.env.PGRX_BUILD_FLAGS, locked ? "--locked" : ""].filter(Boolean).join(" ");

  const features = entry.build?.features || [];
  const noDefaultFeatures = entry.build?.noDefaultFeatures ? "--no-default-features" : "";

  log(`cargo pgrx ${version} install (${features.join(",") || "default"}) in ${dir}`);

  const pathEnv = `${installRoot}/bin:${process.env.PATH}`;

  // Use conditional template literals to handle --features flag properly
  // Bun's $ template requires separate arguments for flags, not array spreading
  // Spread Bun.env to preserve HOME, CARGO_HOME, RUSTUP_HOME etc. — bare .env({ PATH })
  // would strip them, breaking cargo's registry and toolchain resolution.
  const cargoEnv = { ...Bun.env, PATH: pathEnv, PGRX_BUILD_FLAGS: buildFlags };

  // Bun's $ template requires separate arguments for flags, not array spreading
  if (features.length > 0 && noDefaultFeatures) {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN} --features ${features.join(",")} ${noDefaultFeatures}`.env(
      cargoEnv
    );
  } else if (features.length > 0) {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN} --features ${features.join(",")}`.env(
      cargoEnv
    );
  } else if (noDefaultFeatures) {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN} ${noDefaultFeatures}`.env(
      cargoEnv
    );
  } else {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN}`.env(cargoEnv);
  }
}

async function buildTimescaledb(dir: string): Promise<void> {
  log(`Building TimescaleDB via bootstrap in ${dir}`);

  // Build with TSL (Timescale License) enabled for compression and continuous aggregates
  // APACHE_ONLY=OFF (default) includes TSL features
  // TSL is free for self-hosted use (including SaaS)
  // Note: Downgrade scripts disabled - not needed for Docker builds (shallow git clone)
  await $`cd ${dir} && ./bootstrap -DAPACHE_ONLY=OFF -DREGRESS_CHECKS=OFF`;

  const buildDir = join(dir, "build");
  const ninjaFile = join(buildDir, "build.ninja");

  if (await Bun.file(ninjaFile).exists()) {
    await $`cd ${buildDir} && ninja -j${NPROC} && ninja install`;
  } else {
    await $`cd ${buildDir} && make -j${NPROC}`;
    await $`cd ${buildDir} && make install`;
  }

  await Bun.write(`/usr/share/postgresql/${PG_MAJOR}/timescaledb/.gitkeep`, "");
}

async function buildAutotools(dir: string, name: string): Promise<void> {
  log(`Running autotools build for ${name} in ${dir}`);

  const autogenScript = join(dir, "autogen.sh");
  if (await Bun.file(autogenScript).exists()) {
    await $`cd ${dir} && ./autogen.sh`;
  }

  const configureArgs = [`--with-pgconfig=${PG_CONFIG_BIN}`];
  if (name === "postgis") {
    configureArgs.push("--with-protobuf=yes", "--with-pcre=yes");
  }

  await $`cd ${dir} && ./configure ${configureArgs}`;
  await $`cd ${dir} && make -j${NPROC}`;
  await $`cd ${dir} && make install`;
}

async function buildCmake(dir: string, name: string): Promise<void> {
  const buildDir = join(dir, ".cmake-build");
  log(`Running CMake build for ${name} in ${dir}`);

  await $`cmake -S ${dir} -B ${buildDir} -DCMAKE_BUILD_TYPE=Release`;
  await $`cmake --build ${buildDir} -j${NPROC}`;
  await $`cmake --install ${buildDir}`;
}

async function buildMeson(dir: string, build: BuildSpec): Promise<void> {
  const buildDir = join(dir, ".meson-build");
  const options = build.mesonOptions ?? [];
  log(`Running Meson build in ${dir}${options.length ? ` (${options.join(" ")})` : ""}`);

  // Meson's default buildtype is "debug" (-O0 -g), and pgroonga's meson.build takes only
  // pg_config's cppflags/cflags_sl, so without this PostgreSQL's -O2 never reaches it.
  // "release" (-O3, no debug info) matches buildCmake's CMAKE_BUILD_TYPE=Release.
  // Entry options come last on purpose: meson keeps the last --prefix, so an entry can override it.
  await $`meson setup ${buildDir} ${dir} --prefix=/usr/local --buildtype=release ${options}`;
  await $`ninja -C ${buildDir} -j${NPROC}`;
  await $`ninja -C ${buildDir} install`;
}

async function buildMakeGeneric(dir: string): Promise<void> {
  log(`Running generic make install in ${dir}`);
  await $`cd ${dir} && make -j${NPROC}`;
  await $`cd ${dir} && make install`;
}

async function buildPgbadger(dir: string): Promise<void> {
  log(`Building pgbadger (Perl) in ${dir}`);
  await $`cd ${dir} && perl Makefile.PL`;
  await $`cd ${dir} && make -j${NPROC}`;
  await $`cd ${dir} && make install`;
}

// ────────────────────────────────────────────────────────────────────────────
// Patch Application
// ────────────────────────────────────────────────────────────────────────────

// build.patches names unified diffs in docker/postgres/patches/, which the Dockerfile copies to PATCH_DIR. git apply is
// all-or-nothing and fails on any hunk that no longer matches, so an upstream bump that moves patched code stops the
// build naming the patch, instead of silently shipping the unpatched extension.
const PATCH_DIR = "/opt/patches";

async function applyPatches(entry: ManifestEntry, dest: string, name: string): Promise<void> {
  for (const patch of entry.build?.patches ?? []) {
    const result = await $`git -C ${dest} apply ${join(PATCH_DIR, patch)}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      log(
        `Patch ${patch} no longer applies to ${name}; refresh it against the new source:\n${result.stderr}`
      );
      process.exit(1);
    }
    log(`Applied ${patch} to ${name}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main Entry Processing
// ────────────────────────────────────────────────────────────────────────────

async function processEntry(entry: ManifestEntry, manifest: Manifest): Promise<void> {
  const { name, kind, source, build, enabled } = entry;

  if (kind === "builtin") {
    log(`Skipping builtin extension ${name}`);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // GATE 0: ENABLED CHECK
  // ────────────────────────────────────────────────────────────────────────────
  // Behavior:
  // - Disabled extensions: Skipped entirely (not built, not included in final image)
  // - Enabled extensions: Built, tested, included in final image
  if (enabled === false) {
    const disabledReason = entry.disabledReason || "No reason specified";
    log(`Extension ${name} disabled (reason: ${disabledReason}) - skipping build`);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // GATE 1: PGDG/PERCONA SKIP CHECK (after the enabled check)
  // ────────────────────────────────────────────────────────────────────────────
  // Skip PGDG/Percona extensions here because they're installed via apt-get in Dockerfile
  // Note: This happens AFTER enabled check so disabled extensions are tracked
  if (entry.install_via === "pgdg") {
    log(`Skipping ${name} (installed via PGDG)`);
    return;
  }
  if (entry.install_via === "percona") {
    log(`Skipping ${name} (installed via Percona)`);
    return;
  }

  const dest = join(BUILD_ROOT, name);
  await ensureCleanDir(dest);

  // Clone repository based on source type
  if (source.type === "git" && source.repository && source.tag) {
    // Clone the commit generate-manifest.ts locked for this tag, never the tag itself: a tag moved
    // upstream would otherwise change the built code with no diff in this repository.
    if (!source.commit) {
      log(`${name}: no locked commit for tag ${source.tag}; run \`bun run generate\` and commit`);
      process.exit(1);
    }
    await cloneRepo(source.repository, source.commit, dest);
  } else if (source.type === "git-ref" && source.repository && (source.ref || source.commit)) {
    const commit = source.commit || source.ref!;
    await cloneRepo(source.repository, commit, dest);
  } else if (source.type === "builtin") {
    return;
  } else {
    log(`Unknown source type ${source.type} for ${name}`);
    process.exit(1);
  }

  // Apply patches if specified
  await applyPatches(entry, dest, name);

  // Determine working directory
  const workdir = build?.subdir ? join(dest, build.subdir) : dest;

  await ensureSourceLibraries(entry, manifest);

  // Build extension based on build type
  const buildType = build?.type;
  if (!buildType) {
    log(`No build type specified for ${name}`);
    return;
  }

  switch (buildType) {
    case "pgxs":
      await buildPgxs(workdir, build);
      break;

    case "cargo-pgrx":
      await buildCargoPgrx(workdir, entry);
      if (name === "timescaledb_toolkit") {
        log("Running toolkit post-install hook");
        await $`cd ${dest} && cargo run --manifest-path tools/post-install/Cargo.toml -- pg_config`;
      }
      break;

    case "timescaledb":
      await buildTimescaledb(workdir);
      break;

    case "autotools":
      await buildAutotools(workdir, name);
      break;

    case "cmake":
      await buildCmake(workdir, name);
      break;

    case "meson":
      await buildMeson(workdir, build);
      break;

    case "make":
      if (name === "pgbadger") {
        await buildPgbadger(workdir);
      } else {
        await buildMakeGeneric(workdir);
      }
      break;

    case "script":
      log(`Custom script build type not implemented for ${name}`);
      process.exit(1);
      break;

    default:
      log(`Unsupported build type ${buildType} for ${name}`);
      process.exit(1);
  }

  await assertLinksSourceLibraries(entry);
}

// ────────────────────────────────────────────────────────────────────────────
// Main Execution
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!MANIFEST_PATH) {
    console.error("Usage: build-extensions.ts <manifest-path> [build-root]");
    process.exit(1);
  }

  if (!(await Bun.file(MANIFEST_PATH).exists())) {
    log(`ERROR: Manifest file not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  // Load and parse manifest
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as Manifest;

  // Create build root directory
  await Bun.write(`${BUILD_ROOT}/.gitkeep`, "");

  // Process each entry in the manifest
  for (const entry of manifest.entries) {
    await processEntry(entry, manifest);
  }

  log("Extension build complete");
}

// Guarded so unit tests can import the pure helpers; Docker runs this file directly.
if (import.meta.main) {
  main().catch((error) => {
    log(`FATAL ERROR: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}
