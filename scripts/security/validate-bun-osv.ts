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
 * Checks (1-2 here; 3-4 — CI wiring — added alongside the SHOW_IGNORED wiring):
 *   (1) Ignore schema: `.bun-osv.json` must be canonical `{ ignore: [...] }`; every entry (in BOTH
 *       `.bun-osv.json` and `package.json#bunOsv.ignore`) must carry a matcher, a `reason`, and a
 *       finite, future `expires`.
 *   (2) Scanner pin: bunfig must keep `scanner = "bun-osv-scanner-extended"` (blocks silent gate removal).
 */

import path from "node:path";
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

async function readJsonIfPresent(absPath: string): Promise<{ present: boolean; value: unknown }> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return { present: false, value: undefined };
  return { present: true, value: JSON.parse(await file.text()) };
}

async function main(): Promise<void> {
  section("Bun OSV Ignore Audit");

  const violations: Violation[] = [];

  const bunOsv = await readJsonIfPresent(path.join(REPO_ROOT, ".bun-osv.json"));
  const packageJson = (await readJsonIfPresent(path.join(REPO_ROOT, "package.json"))).value;
  const bunfig = Bun.TOML.parse(await Bun.file(path.join(REPO_ROOT, "bunfig.toml")).text());

  violations.push(...checkIgnoreSchema(bunOsv.present ? bunOsv.value : undefined, packageJson));
  violations.push(...checkScannerPin(bunfig));

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
