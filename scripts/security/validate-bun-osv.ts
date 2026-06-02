#!/usr/bin/env bun
/**
 * Audit the bun OSV install-time security gate (scanner: bun-osv-scanner-extended).
 *
 * Why this exists:
 * - A `warn`-level transitive CVE cancels every non-TTY `bun install` (Bun: warn -> TTY prompt,
 *   no-TTY -> exit 1). The remediation order is `overrides` first; only when a CVE is *unfixable*
 *   (no patched version in range) do we acknowledge it in an audited ignore file.
 * - The scanner (bun-osv-scanner-extended) loads ignore rules from MORE channels than is obvious and
 *   accepts MORE `.bun-osv.json` shapes than we want, and treats a missing/unparseable `expires` as
 *   "never expires" (permanent SILENT suppression). Without guards, a clueless or out-of-context agent
 *   can suppress a CVE forever, redirect ignores to an unaudited file, or remove the gate entirely.
 *
 * This module closes that whole class statically. It is a `fast` ValidationCheck (runs in
 * `bun run validate` and `validate:all`). Pure functions (parsed input -> Violation[]) carry the logic
 * so they are unit-tested with inline fixtures (no fs, no mocks); `main()` does the IO and exit.
 *
 * Checks:
 *   (1) Ignore schema: `.bun-osv.json` must be canonical `{ ignore: [...] }`; every entry (in BOTH
 *       `.bun-osv.json` and `package.json#bunOsv.ignore`) must carry a matcher, a `reason`, and a
 *       finite, future `expires`.
 *   (2) Scanner pin: bunfig must keep `scanner = "bun-osv-scanner-extended"` (blocks silent gate removal).
 *   (3) Wiring: every `bun install` site (any workflow/action) must resolve `BUN_OSV_SHOW_IGNORED` to
 *       "0"/"false", else acknowledged CVEs cancel the non-TTY install.
 *   (4) No bypass: no CI env may set BUN_OSV_IGNORE_FILE / OSV_IGNORE_FILE / BUN_OSV_IGNORE_PKG /
 *       BUN_OSV_IGNORE_ADVISORY (those inject ignores outside the audited file).
 */

import path from "node:path";
import { parseDocument } from "yaml";
import { error, info, section, success } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

/** The scanner that MUST stay configured — the only fork giving an audited, expiring ignore. */
export const REQUIRED_SCANNER = "bun-osv-scanner-extended";

/**
 * A single audit failure. `source` locates the offending input (file + entry/key) so an out-of-context
 * reader knows exactly where to look; `message` states WHY it is wrong and HOW to fix it.
 */
export type Violation = { source: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate one ignore entry's matcher + justification + expiry. Mirrors the scanner's own acceptance
 * (`new Date(expires)`, matcher = `package || advisory`) so the guard never diverges from runtime
 * behaviour, but is STRICTER: the scanner allows a missing/never `expires`; we forbid it.
 */
function validateEntry(entry: unknown, source: string, now: Date): Violation[] {
  if (!isRecord(entry)) {
    return [
      { source, message: `ignore entry must be a JSON object, got ${JSON.stringify(entry)}` },
    ];
  }

  const violations: Violation[] = [];

  // Matcher: the scanner drops any rule without `package` or `advisory` — a silent no-op that reads as
  // "this CVE is ignored" while suppressing nothing. Force an explicit matcher.
  if (!isNonEmptyString(entry.advisory) && !isNonEmptyString(entry.package)) {
    violations.push({
      source,
      message:
        'ignore entry has no matcher — set "advisory" (e.g. "CVE-2026-12345"/"GHSA-…") or "package". ' +
        "Without one the scanner silently drops the rule (suppresses nothing) while looking acknowledged.",
    });
  }

  // Reason: never read by the scanner; mandated by us so every suppression carries a written audit trail.
  if (!isNonEmptyString(entry.reason)) {
    violations.push({
      source,
      message:
        'ignore entry missing a non-empty "reason" — every acknowledged CVE needs a written justification ' +
        "(why it is unfixable / not exploitable here). Prefer fixing via package.json `overrides` first.",
    });
  }

  // Expires: the scanner treats a missing OR unparseable date as never-expiring => permanent SILENT
  // suppression. Mandate a finite, future date so every ignore self-sunsets and forces re-evaluation.
  if (!isNonEmptyString(entry.expires)) {
    violations.push({
      source,
      message:
        'ignore entry missing "expires" — the scanner treats no-expiry as PERMANENT silent suppression. ' +
        'Add a future ISO date (e.g. "2026-12-31") so the ignore lapses and is re-reviewed.',
    });
  } else {
    const when = new Date(entry.expires);
    if (!Number.isFinite(when.getTime())) {
      violations.push({
        source,
        message:
          `"expires" value ${JSON.stringify(entry.expires)} is not a parseable date — the scanner treats an ` +
          'invalid date as never-expiring (permanent silent suppression). Use an ISO date like "2026-12-31".',
      });
    } else if (when.getTime() <= now.getTime()) {
      violations.push({
        source,
        message:
          `"expires" ${entry.expires} is in the past — this ignore has lapsed. Re-evaluate the CVE: drop the ` +
          "entry if fixed/patched, or extend `expires` with a fresh justification if still unfixable.",
      });
    }
  }

  return violations;
}

/**
 * CHECK 1 — ignore schema across BOTH load sources we permit.
 *
 * @param bunOsvFile parsed `.bun-osv.json` (any JSON), or `undefined` if the file is absent.
 * @param packageJson parsed `package.json` (for the `bunOsv.ignore` channel), or `undefined`.
 * @param now injected for deterministic tests.
 */
export function checkIgnoreSchema(
  bunOsvFile: unknown,
  packageJson: unknown,
  now: Date = new Date()
): Violation[] {
  const violations: Violation[] = [];

  // --- Source A: .bun-osv.json — enforce the canonical { ignore: [...] } shape. The scanner ALSO
  // accepts a bare array and a { packages: { name: range } } shorthand; both bypass the reason/expires
  // mandate (the shorthand cannot even express them), so we reject everything but the canonical object.
  if (bunOsvFile !== undefined) {
    const src = ".bun-osv.json";
    if (Array.isArray(bunOsvFile)) {
      violations.push({
        source: src,
        message:
          'must be a JSON object { "ignore": [...] }, not a bare array — the bare-array shape skips the ' +
          "audited schema (no reason/expires enforcement). Wrap entries in an `ignore` array.",
      });
    } else if (!isRecord(bunOsvFile)) {
      violations.push({
        source: src,
        message: 'must be a JSON object of the form { "ignore": [...] }.',
      });
    } else if ("packages" in bunOsvFile) {
      violations.push({
        source: src,
        message:
          'the { "packages": { name: range } } shorthand is forbidden — it cannot carry "reason"/"expires", ' +
          'so it permanently suppresses without an audit trail. Use { "ignore": [{ advisory, reason, expires }] }.',
      });
    } else if (!Array.isArray(bunOsvFile.ignore)) {
      violations.push({
        source: src,
        message: '"ignore" must be an array (use [] when nothing is ignored).',
      });
    } else {
      bunOsvFile.ignore.forEach((entry, i) => {
        violations.push(...validateEntry(entry, `${src} › ignore[${i}]`, now));
      });
    }
  }

  // --- Source B: package.json#bunOsv.ignore — the scanner reads it only when it is an array.
  if (isRecord(packageJson) && isRecord(packageJson.bunOsv)) {
    const ignore = packageJson.bunOsv.ignore;
    const src = "package.json › bunOsv.ignore";
    if (ignore !== undefined) {
      if (!Array.isArray(ignore)) {
        violations.push({
          source: src,
          message:
            "must be an array — the scanner ignores a non-array `bunOsv.ignore` (rules silently lost).",
        });
      } else {
        ignore.forEach((entry, i) => {
          violations.push(...validateEntry(entry, `${src}[${i}]`, now));
        });
      }
    }
  }

  return violations;
}

/**
 * CHECK 2 — scanner pin. `bunfig` is the parsed bunfig.toml. Removing or swapping the scanner silently
 * disarms the install-time gate (the stock @bun-security-scanner/osv cannot ignore; no scanner = no scan).
 */
export function checkScannerPin(bunfig: unknown): Violation[] {
  const scanner =
    isRecord(bunfig) && isRecord(bunfig.install) && isRecord(bunfig.install.security)
      ? bunfig.install.security.scanner
      : undefined;

  if (scanner === REQUIRED_SCANNER) return [];

  return [
    {
      source: "bunfig.toml › [install.security].scanner",
      message:
        `must be "${REQUIRED_SCANNER}", got ${JSON.stringify(scanner)}. This is the install-time CVE gate; ` +
        "removing/swapping it disarms scanning (the stock scanner cannot honour audited ignores). Restore it.",
    },
  ];
}

/** Install sites are armed by setting this env to a disabling value; the default ("1") would cancel. */
export const SHOW_IGNORED_ENV = "BUN_OSV_SHOW_IGNORED";

/**
 * Env keys that feed ignore rules to the scanner OUTSIDE the audited .bun-osv.json (ignore.ts:
 * BUN_OSV_IGNORE_FILE || OSV_IGNORE_FILE, plus BUN_OSV_IGNORE_PKG / BUN_OSV_IGNORE_ADVISORY). Any of
 * them in CI suppresses a CVE with no reason/expires — forbidden. Enumerated literally: a
 * `BUN_OSV_IGNORE_*` glob would miss the prefix-less `OSV_IGNORE_FILE` alias.
 */
export const FORBIDDEN_IGNORE_ENV = [
  "BUN_OSV_IGNORE_FILE",
  "OSV_IGNORE_FILE",
  "BUN_OSV_IGNORE_PKG",
  "BUN_OSV_IGNORE_ADVISORY",
] as const;

/** GitHub passes env as strings; the scanner disables show-ignored iff "0" or "false" (index.ts). */
function disablesShowIgnored(value: unknown): boolean {
  const norm = String(value).trim().toLowerCase();
  return norm === "0" || norm === "false";
}

/**
 * True iff a shell snippet invokes `bun install` as a top-level command. Splits on shell command
 * separators (a lexer, not a shell parser) and matches a segment's leading two tokens — so it catches
 * `bun install`, `bun install --frozen-lockfile`, `… && bun install`, and double-spaced forms, while
 * ignoring comments and strings like `echo "bun install"`. Obfuscated/eval'd invocations are out of
 * scope (not a realistic CI bypass — the install would still run the scanner).
 */
export function invokesBunInstall(run: string): boolean {
  let normalized = run;
  for (const sep of ["&&", "||", ";", "|"]) normalized = normalized.split(sep).join("\n");
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .some((line) => line.split(/\s+/).slice(0, 2).join(" ") === "bun install");
}
function envOf(node: unknown): Record<string, unknown> | undefined {
  return isRecord(node) && isRecord(node.env) ? node.env : undefined;
}

function stepsOf(node: unknown): unknown[] {
  return isRecord(node) && Array.isArray(node.steps) ? node.steps : [];
}

function stepLabel(step: unknown, index: number): string {
  return isRecord(step) && typeof step.name === "string" ? step.name : `#${index + 1}`;
}

/** Resolve a step's effective env value for one key across its scope chain (most-specific wins). */
function resolveEnv(
  chain: Array<Record<string, unknown> | undefined>,
  key: string
): { defined: boolean; value: unknown } {
  let defined = false;
  let value: unknown;
  for (const scope of chain) {
    if (scope && key in scope) {
      defined = true;
      value = scope[key];
    }
  }
  return { defined, value };
}

export type CiKind = "workflow" | "action";

/**
 * CHECK 3 (every `bun install` site disables show-ignored) + CHECK 4 (no env feeds ignores outside the
 * audited .bun-osv.json) for one parsed CI file. Navigates the GitHub schema (workflow jobs→steps /
 * composite action runs→steps) — never regex over YAML. `file` is repo-relative, for messages.
 */
export function auditCiFile(file: string, parsed: unknown, kind: CiKind): Violation[] {
  const violations: Violation[] = [];
  const envBlocks: Array<{ where: string; env: Record<string, unknown> }> = [];
  const installSites: Array<{ where: string; chain: Array<Record<string, unknown> | undefined> }> =
    [];

  const collectStep = (
    step: unknown,
    where: string,
    outerEnv: Array<Record<string, unknown> | undefined>
  ) => {
    const stepEnv = envOf(step);
    if (stepEnv) envBlocks.push({ where: `${where}.env`, env: stepEnv });
    if (isRecord(step) && typeof step.run === "string" && invokesBunInstall(step.run)) {
      installSites.push({ where, chain: [...outerEnv, stepEnv] });
    }
  };

  if (kind === "workflow" && isRecord(parsed)) {
    const wfEnv = envOf(parsed);
    if (wfEnv) envBlocks.push({ where: "env", env: wfEnv });
    const jobs = isRecord(parsed.jobs) ? parsed.jobs : {};
    for (const [jobId, job] of Object.entries(jobs)) {
      const jobEnv = envOf(job);
      if (jobEnv) envBlocks.push({ where: `jobs.${jobId}.env`, env: jobEnv });
      stepsOf(job).forEach((step, i) => {
        collectStep(step, `jobs.${jobId}.steps[${stepLabel(step, i)}]`, [wfEnv, jobEnv]);
      });
    }
  } else if (kind === "action" && isRecord(parsed)) {
    // Composite actions have no workflow/job env; we wire SHOW_IGNORED on the install step itself.
    stepsOf(isRecord(parsed.runs) ? parsed.runs : undefined).forEach((step, i) => {
      collectStep(step, `runs.steps[${stepLabel(step, i)}]`, []);
    });
  }

  for (const site of installSites) {
    const { defined, value } = resolveEnv(site.chain, SHOW_IGNORED_ENV);
    if (!defined) {
      violations.push({
        source: `${file} › ${site.where}`,
        message:
          `runs \`bun install\` without ${SHOW_IGNORED_ENV} in scope — acknowledged CVEs re-emit as warn and ` +
          `cancel this non-TTY install. Add \`${SHOW_IGNORED_ENV}: "0"\` to the step/job/workflow env.`,
      });
    } else if (!disablesShowIgnored(value)) {
      violations.push({
        source: `${file} › ${site.where}`,
        message:
          `${SHOW_IGNORED_ENV} resolves to ${JSON.stringify(value)} — must be "0" or "false", else acknowledged ` +
          "CVEs still cancel this non-TTY install.",
      });
    }
  }

  for (const block of envBlocks) {
    for (const key of FORBIDDEN_IGNORE_ENV) {
      if (key in block.env) {
        violations.push({
          source: `${file} › ${block.where}`,
          message:
            `sets ${key}, injecting ignore rules that bypass the audited .bun-osv.json (no reason/expires). ` +
            "Remove it; put any ignore in .bun-osv.json with a reason + future expires.",
        });
      }
    }
  }

  return violations;
}

/** Value of a leading `KEY=value` env-prefix token in a shell command, or undefined if absent. */
function inlineEnvValue(command: string, key: string): string | undefined {
  const token = command.split(/\s+/).find((t) => t.startsWith(`${key}=`));
  return token?.slice(key.length + 1);
}

/**
 * CHECK 3 for `.1code/worktree.json` — its `setup-worktree` commands run `bun install` outside any env
 * block (worktree bootstrap), so SHOW_IGNORED must be set inline (`env BUN_OSV_SHOW_IGNORED=0 bun
 * install` — `env` works whether the runner shells out or execs). Verify any install command carries it.
 */
export function auditWorktreeConfig(file: string, parsed: unknown): Violation[] {
  const commands =
    isRecord(parsed) && Array.isArray(parsed["setup-worktree"]) ? parsed["setup-worktree"] : [];
  const violations: Violation[] = [];
  for (const command of commands) {
    if (typeof command !== "string") continue;
    const tokens = command.split(/\s+/);
    const bunAt = tokens.indexOf("bun");
    if (bunAt < 0 || tokens[bunAt + 1] !== "install") continue;
    const value = inlineEnvValue(command, SHOW_IGNORED_ENV);
    if (value === undefined || !disablesShowIgnored(value)) {
      violations.push({
        source: `${file} › setup-worktree`,
        message:
          `\`${command}\` runs bun install but does not set ${SHOW_IGNORED_ENV}=0 inline — acknowledged CVEs ` +
          `would cancel this non-TTY install. Prefix it: \`env ${SHOW_IGNORED_ENV}=0 bun install\`.`,
      });
    }
  }
  return violations;
}

async function readJsonIfPresent(absPath: string): Promise<{ present: boolean; value: unknown }> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return { present: false, value: undefined };
  const text = await file.text();
  try {
    return { present: true, value: JSON.parse(text) };
  } catch (err) {
    // A malformed ignore file is silently dropped by the scanner (file ignored, gate still armed) —
    // surface it loudly instead, naming the file so it is fixable out of context.
    throw new Error(
      `${path.relative(REPO_ROOT, absPath)} is not valid JSON: ${getErrorMessage(err)}`
    );
  }
}

async function main(): Promise<void> {
  section("Bun OSV Ignore Audit");

  const violations: Violation[] = [];

  const bunOsv = await readJsonIfPresent(path.join(REPO_ROOT, ".bun-osv.json"));
  const packageJson = (await readJsonIfPresent(path.join(REPO_ROOT, "package.json"))).value;
  const bunfig = Bun.TOML.parse(await Bun.file(path.join(REPO_ROOT, "bunfig.toml")).text());

  violations.push(...checkIgnoreSchema(bunOsv.present ? bunOsv.value : undefined, packageJson));
  violations.push(...checkScannerPin(bunfig));

  // Checks 3-4 over every workflow + local action (not just the known install sites): a future
  // unwired `bun install`, or any forbidden ignore-env, must fail here.
  const gh = path.join(REPO_ROOT, ".github");
  const ciFiles: Array<{ abs: string; kind: CiKind }> = [
    ...[...new Bun.Glob("workflows/*.{yml,yaml}").scanSync({ cwd: gh })].map((rel) => ({
      abs: path.join(gh, rel),
      kind: "workflow" as const,
    })),
    ...[...new Bun.Glob("actions/*/action.{yml,yaml}").scanSync({ cwd: gh })].map((rel) => ({
      abs: path.join(gh, rel),
      kind: "action" as const,
    })),
  ].sort((a, b) => a.abs.localeCompare(b.abs));

  for (const { abs, kind } of ciFiles) {
    const rel = path.relative(REPO_ROOT, abs);
    const doc = parseDocument(await Bun.file(abs).text());
    if (doc.errors.length > 0) {
      violations.push({
        source: rel,
        message: `YAML parse error: ${doc.errors.map((e) => e.message).join("; ")}`,
      });
      continue;
    }
    violations.push(...auditCiFile(rel, doc.toJS(), kind));
  }

  // Non-CI install site: worktree bootstrap runs `bun install` with no env block.
  const worktree = await readJsonIfPresent(path.join(REPO_ROOT, ".1code/worktree.json"));
  if (worktree.present)
    violations.push(...auditWorktreeConfig(".1code/worktree.json", worktree.value));

  if (violations.length > 0) {
    for (const v of violations) error(`${v.source}: ${v.message}`);
    throw new Error(`Bun OSV ignore audit failed (${violations.length} violation(s))`);
  }

  info(
    `Ignore entries: ${
      isRecord(bunOsv.value) && Array.isArray((bunOsv.value as { ignore?: unknown[] }).ignore)
        ? (bunOsv.value as { ignore: unknown[] }).ignore.length
        : 0
    } (.bun-osv.json) · scanner pinned to ${REQUIRED_SCANNER}`
  );
  success("Bun OSV ignore audit passed");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    error(`Bun OSV ignore audit failed: ${getErrorMessage(err)}`);
    process.exit(1);
  });
}
