#!/usr/bin/env bun
/**
 * Places that COPY the image's runtime contract — compose files and the commands in docs/runbooks — must match it.
 *
 * Why: deployments/, examples/ and docs/ hand-copy the stacks' setup and no test suite boots them, so they drifted
 * silently into deployments that cannot start or cannot be reached. Each rule below is a startup or connection
 * failure measured against the PG18 image, not a style preference:
 *   1. Data volume at /var/lib/postgresql. PG18 keeps PGDATA at /var/lib/postgresql/<major>/docker; its entrypoint
 *      refuses to start when something is mounted at the pre-18 `/var/lib/postgresql/data`.
 *   2. POSTGRES_BIND_IP=0.0.0.0 inside the container when the compose file runs other services. The image uses it
 *      as listen_addresses with default 127.0.0.1, so pgbouncer, exporters and replicas get "connection refused".
 *   3. POSTGRES_MEMORY is an integer in MB. The entrypoint exits on "5GB"-style values.
 *   4. No `/var/lib/postgresql/data` used as a path in any tracked text (a mount target, a file under it, a command
 *      argument, an assignment). It is the pre-18 Docker convention, so it is what memory and old examples produce.
 *      Naming it as the legacy path inside backticks stays legal.
 * Compose override files (compose.<name>.yml beside a compose.yml) are merged onto that base, so rule 2 judges the
 * base only. The stacks are also booted by their suites; this check is the only detector for everything else.
 *
 * Usage: bun scripts/validate/image-runtime-contract.ts   (exit 1 lists each file:line with the fix)
 */
import { Glob } from "bun";

type Service = {
  image?: string;
  environment?: Record<string, unknown> | string[];
  volumes?: unknown[];
};
const problems: string[] = [];
// Assembled so this file does not contain the literal it forbids.
const LEGACY = ["/var/lib/postgresql", "data"].join("/");

/** `${VAR:-default}` → default; a literal stays itself; `${VAR}` / `${VAR:?msg}` has no default → undefined. */
function composeDefault(value: unknown): string | undefined {
  const text = String(value);
  const m = /^\$\{[A-Z0-9_]+(?::?-([^}]*))?(?::?\?[^}]*)?\}$/.exec(text);
  return m ? m[1] : text;
}

function env(service: Service): Map<string, unknown> {
  const e = service.environment;
  if (Array.isArray(e))
    return new Map(
      e.map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)] as [string, unknown])
    );
  return new Map(Object.entries(e ?? {}));
}

const composeFiles = [
  ...(await Array.fromAsync(
    new Glob("{stacks,deployments,examples}/**/{compose,docker-compose}*.{yml,yaml}").scan(".")
  )),
].sort();
for (const file of composeFiles) {
  const compose = Bun.YAML.parse(await Bun.file(file).text()) as {
    services?: Record<string, Service>;
  };
  const services = compose.services ?? {};
  const isOverride =
    /\/compose\.[^/]+\.ya?ml$/.test(file) &&
    (await Bun.file(file.replace(/compose\.[^/]+\.ya?ml$/, "compose.yml")).exists());
  for (const [name, svc] of Object.entries(services)) {
    if (!svc.image?.includes("aza-pg")) continue;
    const where = `${file} (service ${name})`;
    for (const v of svc.volumes ?? []) {
      const target = typeof v === "string" ? v.split(":")[1] : (v as { target?: string }).target;
      if (target === LEGACY || target?.startsWith(`${LEGACY}/`)) {
        problems.push(
          `${where}: volume target ${target} — mount the data volume at /var/lib/postgresql; PG18 refuses to start on the pre-18 path`
        );
      }
    }
    const e = env(svc);
    if (!isOverride && Object.keys(services).length > 1) {
      const bind = e.has("POSTGRES_BIND_IP")
        ? composeDefault(e.get("POSTGRES_BIND_IP"))
        : undefined;
      if (bind !== "0.0.0.0") {
        problems.push(
          `${where}: set environment POSTGRES_BIND_IP: "0.0.0.0" (found ${bind ?? "nothing"}) — the image listens on 127.0.0.1 by default, so this file's other services cannot connect; host exposure is chosen by "ports", not by this variable`
        );
      }
    }
    if (e.has("POSTGRES_MEMORY")) {
      const mem = composeDefault(e.get("POSTGRES_MEMORY"));
      if (mem !== undefined && mem !== "" && !/^\d+$/.test(mem)) {
        problems.push(
          `${where}: POSTGRES_MEMORY default "${mem}" — must be an integer in MB (e.g. 5120); the entrypoint exits on unit suffixes`
        );
      }
    }
  }
}

// Rule 4: the legacy path used as a path. Legal only as a mention: wrapped in backticks, or at the start of a line
// (the entrypoint's quoted error output). Anything else — `:` mount, `=` assignment, a file under it, a command
// argument — is a use that breaks on PG18.
const tracked = (await Bun.$`git ls-files -z`.quiet().text())
  .split("\0")
  .filter((f) => /\.(md|sh|ya?ml|ts|conf|example|sql)$|Dockerfile/.test(f));
await Promise.all(
  tracked.map(async (file) => {
    const text = await Bun.file(file).text();
    // Rule 3 for .env files and documented env lines: the value must be digits, a variable or a `<placeholder>`.
    for (const [i, line] of text.split("\n").entries()) {
      const mem = /\bPOSTGRES_MEMORY=["']?([^\s"'#`,)]+)/.exec(line)?.[1];
      if (mem && !/^(\d+|\$.*|<[^>]+>)$/.test(mem))
        problems.push(
          `${file}:${i + 1}: POSTGRES_MEMORY=${mem} — must be an integer in MB (e.g. 5120); the entrypoint exits on unit suffixes`
        );
    }
    if (!text.includes(LEGACY)) return;
    text.split("\n").forEach((line, i) => {
      for (let at = line.indexOf(LEGACY); at !== -1; at = line.indexOf(LEGACY, at + 1)) {
        const before = line.slice(0, at);
        const after = line[at + LEGACY.length] ?? "";
        // A file under the legacy dir is always a use, even on a continuation line.
        const mention =
          (before.endsWith("`") && after === "`") || (before.trim() === "" && after !== "/");
        if (!mention)
          problems.push(
            `${file}:${i + 1}: ${LEGACY} used as a path — PG18 data lives in "$PGDATA" (/var/lib/postgresql/<major>/docker) under a volume at /var/lib/postgresql; in container commands write "$PGDATA" single-quoted, and name the legacy path only inside backticks`
          );
      }
    });
  })
);

if (problems.length) {
  console.error(
    `Image runtime contract: ${problems.length} problem(s) in copies of the image's setup\n`
  );
  for (const p of problems.sort()) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `Image runtime contract: ${composeFiles.length} compose files and tracked docs match the image`
);
