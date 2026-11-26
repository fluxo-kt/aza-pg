#!/usr/bin/env bun
/**
 * Is everything this repository pins current, at one revision? `bun scripts/check-current.ts [--rev <commit>]`
 *
 * One instrument for `/update`'s pre-flight and `/release` step 0.8, which both need the same answer. Each check reads
 * repository files (flake.lock, package.json, workflow pins), so it must read them AT THE REVISION BEING JUDGED: run by
 * hand from a checkout of another branch (release, while dev is what ships), every check silently reports that
 * branch's pins instead, and a stale lock reads as due work or due work reads as current. So the revision is extracted
 * into a scratch directory and every check runs there; the caller's working tree is never read.
 *
 * Checks (one line each): enabled extensions, companion and tool images (check-updates.ts), the nixpkgs revision
 * against the channel head, the sbomnix input against its newest release, the Bun runtime, Bun packages, GitHub
 * Actions pins (actions-up), and local Nix against the version CI's install-nix-action installs.
 *
 * Exit: 0 everything current, 1 something is due (the normal "work to do" answer), 2 a check could not run — its
 * verdict is unknown, never "current".
 */
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Verdict = "current" | "due" | "failed";
interface Line {
  check: string;
  verdict: Verdict;
  detail: string;
}

/** Package rows of `bun outdated`'s table; it exits 0 whether or not anything is outdated, so only the table tells. */
export function outdatedPackages(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Package "))
    .map((line) => line.split("|")[1]!.trim());
}

/** `actions-up --dry-run --json` counts proposed pin changes in `summary.totalUpdates`. */
export function actionUpdates(json: string): number {
  const total = (JSON.parse(json) as { summary?: { totalUpdates?: unknown } }).summary
    ?.totalUpdates;
  if (typeof total !== "number") throw new Error("actions-up JSON has no summary.totalUpdates");
  return total;
}

async function latestRelease(repo: string): Promise<string> {
  const out = await $`gh release view -R ${repo} --json tagName --jq .tagName`.nothrow().quiet();
  if (out.exitCode !== 0)
    throw new Error(`gh release view ${repo}: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

async function run(dir: string): Promise<Line[]> {
  const read = (path: string) => Bun.file(join(dir, path)).text();
  const checks: Array<[string, () => Promise<Omit<Line, "check">>]> = [
    [
      "extensions and images",
      async () => {
        // check-updates exits 1 for an enabled update and 2 when a source could not be read; disabled entries can
        // report updates under exit 0, which are listed but never due.
        const out = await $`bun scripts/extensions/check-updates.ts --format=json`
          .cwd(dir)
          .nothrow()
          .quiet();
        if (out.exitCode >= 2)
          return {
            verdict: "failed",
            detail: out.stderr.toString().trim().split("\n").slice(-3).join(" | "),
          };
        const rows = JSON.parse(out.stdout.toString()) as Array<{
          name: string;
          current: string;
          latest: string | null;
          updateAvailable: boolean;
          enabled: boolean;
        }>;
        const due = rows.filter((r) => r.updateAvailable && r.enabled);
        const disabled = rows.filter((r) => r.updateAvailable && !r.enabled);
        const list = (rs: typeof rows) =>
          rs.map((r) => `${r.name} ${r.current} → ${r.latest}`).join(", ");
        return due.length > 0
          ? { verdict: "due", detail: list(due) }
          : {
              verdict: "current",
              detail: disabled.length ? `disabled, not shipped: ${list(disabled)}` : "",
            };
      },
    ],
    [
      "nixpkgs",
      async () => {
        const lock = JSON.parse(await read("flake.lock")) as {
          nodes?: { nixpkgs?: { locked?: { rev?: string } } };
        };
        const locked = lock.nodes?.nixpkgs?.locked?.rev;
        if (!locked) return { verdict: "failed", detail: "flake.lock has no nixpkgs revision" };
        const out =
          await $`git ls-remote https://github.com/NixOS/nixpkgs refs/heads/nixos-unstable`
            .nothrow()
            .quiet();
        const head = out.stdout.toString().split("\t")[0]!;
        if (out.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(head))
          return { verdict: "failed", detail: "cannot read the nixos-unstable head" };
        return head === locked
          ? { verdict: "current", detail: locked.slice(0, 7) }
          : {
              verdict: "due",
              detail: `locked ${locked.slice(0, 7)}, channel head ${head.slice(0, 7)}`,
            };
      },
    ],
    [
      "sbomnix",
      async () => {
        const pinned = (await read("flake.nix")).match(/github:tiiuae\/sbomnix\/([^"]+)"/)?.[1];
        if (!pinned) return { verdict: "failed", detail: "no sbomnix input in flake.nix" };
        const latest = await latestRelease("tiiuae/sbomnix");
        return pinned === latest
          ? { verdict: "current", detail: pinned }
          : { verdict: "due", detail: `${pinned} → ${latest}` };
      },
    ],
    [
      "Bun runtime",
      async () => {
        const pinned = (await read(".tool-versions")).match(/^bun\s+(\S+)/m)?.[1];
        if (!pinned) return { verdict: "failed", detail: "no bun line in .tool-versions" };
        const latest = (await latestRelease("oven-sh/bun")).replace(/^bun-v/, "");
        return pinned === latest
          ? { verdict: "current", detail: pinned }
          : { verdict: "due", detail: `${pinned} → ${latest}` };
      },
    ],
    [
      "Bun packages",
      async () => {
        const out = await $`bun outdated`.cwd(dir).nothrow().quiet();
        if (out.exitCode !== 0) return { verdict: "failed", detail: out.stderr.toString().trim() };
        const outdated = outdatedPackages(out.stdout.toString());
        return outdated.length
          ? { verdict: "due", detail: outdated.join(", ") }
          : { verdict: "current", detail: "" };
      },
    ],
    [
      "Actions pins",
      async () => {
        const out = await $`actions-up --dry-run --json --include-branches --prefer-tags`
          .cwd(dir)
          .nothrow()
          .quiet();
        if (out.exitCode !== 0) return { verdict: "failed", detail: out.stderr.toString().trim() };
        const n = actionUpdates(out.stdout.toString());
        return n === 0
          ? { verdict: "current", detail: "" }
          : { verdict: "due", detail: `${n} pin(s): run actions-up (/update Phase 2.5)` };
      },
    ],
    [
      "local Nix",
      async () => {
        // scripts/nix/nix.ts must run the Nix CI installs: the nix_version in the pinned install-nix-action's script.
        const local = (await read("scripts/nix/nix.ts")).match(/"nixos\/nix:([^@"]+)@/)?.[1];
        const sha = (await read(".github/actions/setup-nix/action.yml")).match(
          /cachix\/install-nix-action@([0-9a-f]{40})/
        )?.[1];
        if (!local || !sha)
          return {
            verdict: "failed",
            detail: "cannot find NIX_IMAGE or the install-nix-action pin",
          };
        const script = await fetch(
          `https://raw.githubusercontent.com/cachix/install-nix-action/${sha}/install-nix.sh`
        );
        const ci = script.ok ? (await script.text()).match(/^nix_version=(\S+)/m)?.[1] : undefined;
        if (!ci)
          return {
            verdict: "failed",
            detail: `cannot read nix_version from install-nix.sh@${sha.slice(0, 7)}`,
          };
        return local === ci
          ? { verdict: "current", detail: ci }
          : { verdict: "due", detail: `nix.ts ${local}, CI ${ci}` };
      },
    ],
  ];
  return Promise.all(
    checks.map(async ([check, fn]) => {
      try {
        return { check, ...(await fn()) };
      } catch (err) {
        return {
          check,
          verdict: "failed" as const,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}

async function main(): Promise<number> {
  // Strict: an unrecognised argument (a typo like `--revv dev`) must not silently judge HEAD instead.
  const [flag, value, ...rest] = Bun.argv.slice(2);
  const rev =
    flag === undefined
      ? "HEAD"
      : flag === "--rev" && value && rest.length === 0
        ? value
        : undefined;
  if (!rev) {
    console.error("Usage: bun scripts/check-current.ts [--rev <commit>]");
    return 2;
  }
  const sha = (await $`git rev-parse --verify ${rev}^{commit}`.quiet()).stdout.toString().trim();
  const dir = await mkdtemp(join(tmpdir(), "aza-pg-check-current-"));
  try {
    // check-updates reads Git metadata and the Nix flake sees only tracked files, so the snapshot is a Git repository
    // with everything staged; nothing is committed there (a commit would run this repository's hooks on the copy).
    await $`git archive ${sha} | tar -x -C ${dir}`.quiet();
    await $`git init -q && git add -A`.cwd(dir).quiet();
    // One install from the revision's own lockfile, before the checks run in parallel: check-updates imports from
    // node_modules, and `bun outdated` compares the directory's package.json and bun.lock against its node_modules, so
    // a node_modules linked from another branch would mislead it.
    const install = await $`bun install --frozen-lockfile`.cwd(dir).nothrow().quiet();
    if (install.exitCode !== 0)
      throw new Error(`bun install at ${sha.slice(0, 7)}: ${install.stderr.toString().trim()}`);
    const lines = await run(dir);
    console.log(`Currency at ${sha.slice(0, 7)} (${rev}):`);
    const mark = { current: "✅", due: "⚠️ ", failed: "❌" } as const;
    for (const l of lines)
      console.log(
        `${mark[l.verdict]} ${l.check.padEnd(22)} ${l.verdict}${l.detail ? `: ${l.detail}` : ""}`
      );
    if (lines.some((l) => l.verdict === "failed")) return 2;
    return lines.some((l) => l.verdict === "due") ? 1 : 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main());
