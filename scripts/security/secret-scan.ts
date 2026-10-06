#!/usr/bin/env bun
/**
 * Fails (exit 1) when a tracked file assigns a literal to a credential-like name (password, secret, api key, token),
 * printing each file:line. A required check of `bun run validate:all`: a hard-coded credential must stop the change,
 * never print a warning nobody reads.
 *
 * Usage: bun scripts/security/secret-scan.ts
 */

import { getErrorMessage } from "../utils/errors";

export type SecretFinding = {
  file: string;
  lineNumber: number;
  line: string;
};

const ASSIGNMENT_PATTERN =
  /(?:^|[{\s,;])["']?(password|secret|api[_-]?key|token)["']?\s*[:=]\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|([A-Za-z0-9_./:+-]{8,}))/gi;

const ALLOWED_LINE_PATTERNS = [
  /\$\{/,
  /Bun\.env\./,
  /process\.env\./,
  /\bexport\b/,
  /POSTGRES_PASSWORD=(test|postgres)/i,
  /secrets\.GITHUB_TOKEN/,
  /id-token:\s*write/,
  /your-/i,
  /\bxxx\b/i,
  /\byyy\b/i,
  /placeholder/i,
  /password.*test/i,
  /PASSWORD.*test/,
];

function isExcluded(file: string): boolean {
  return (
    file.endsWith(".env.example") ||
    file.startsWith(".archived/") ||
    file.startsWith(".github/") ||
    file.startsWith("docs/") ||
    file.startsWith("deployments/") ||
    file.endsWith(".test.ts") ||
    /(^|\/)test-[^/]*\.ts$/.test(file) ||
    /(^|\/)\.[^/]*rc$/.test(file)
  );
}

function isCodeExpression(file: string, value: string): boolean {
  return (
    /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file) &&
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)
  );
}

function isAllowedLine(line: string): boolean {
  return ALLOWED_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function findSecretFindingsInText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (isAllowedLine(line)) {
      continue;
    }

    ASSIGNMENT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ASSIGNMENT_PATTERN.exec(line)) !== null) {
      const unquotedValue = match[4] ?? "";
      if (unquotedValue !== "" && isCodeExpression(file, unquotedValue)) {
        continue;
      }

      findings.push({
        file,
        lineNumber: index + 1,
        line: line.trim(),
      });
    }
  }

  return findings;
}

async function getTrackedFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ls-files failed: ${stderr.trim()}`);
  }

  return stdout.split("\n").filter((file) => file !== "" && !isExcluded(file));
}

async function scanTrackedFiles(): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];

  for (const file of await getTrackedFiles()) {
    const source = Bun.file(file);
    if (!(await source.exists())) {
      continue;
    }
    findings.push(...findSecretFindingsInText(file, await source.text()));
  }

  return findings;
}

async function main(): Promise<void> {
  if (Bun.argv.length > 2) throw new Error(`takes no arguments: ${Bun.argv.slice(2).join(" ")}`);
  const findings = await scanTrackedFiles();

  for (const finding of findings) {
    console.log(`${finding.file}:${finding.lineNumber}:${finding.line}`);
  }

  if (findings.length > 0) {
    console.error(
      "Possible hard-coded secrets above. A real credential: read it from the environment (Bun.env.X) or a secret " +
        "store and rotate it. A false positive: rename the variable so it no longer looks like a credential."
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Secret scan failed: ${getErrorMessage(err)}`);
    process.exit(1);
  });
}
