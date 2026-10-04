/**
 * A private copy of one compose stack for one test run.
 *
 * Why: the stacks read `.env` from their own directory and name their volumes and networks globally
 * (`name: ${POSTGRES_DATA_VOLUME:-postgres_data}`), so tests that ran stacks/<name>/ in place overwrote the
 * operator's `.env`, shared — and with `down -v` deleted — the operator's real `postgres_data` volume, collided on
 * host ports, and could not run in parallel. A staged copy keeps the production compose file and configs
 * byte-for-byte and gives the run its own `.env` in which every globally named thing is scoped to the run:
 *   - COMPOSE_PROJECT_NAME (container names derive from it),
 *   - every variable that names a volume or a non-external network → `<project>-<default>`,
 *   - the external `monitoring` network → a run-scoped network created here and removed by remove(),
 *   - every published host port → 0 (Docker picks a free one; use hostPort()), every host bind IP → 127.0.0.1.
 * External networks other than monitoring (the replica joins the primary's network) must be passed by the caller:
 * stage the primary first and pass its `env.POSTGRES_NETWORK_NAME`.
 */

import { $ } from "bun";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateUniqueProjectName } from "../utils/docker";
import { cleanupTestDockerConfig, getTestDockerConfig } from "../utils/docker-test-config";
import { resolveImageTag } from "./image-resolver";

export type StackName = "primary" | "replica" | "single";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
// The compose files mount this one file through `../../docker/postgres/configs/`.
const SHARED_CONFIG = "docker/postgres/configs/postgres_exporter_queries.yaml";
// `${NAME:-default}` — one interpolation token inside a compose scalar.
const INTERPOLATION = /\$\{(\w+):-([^}]*)\}/g;

export interface StagedStack {
  /** Staged stack directory: the compose project directory, holding this run's `.env`. */
  readonly dir: string;
  readonly project: string;
  /** Every variable written to the staged `.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** Process environment for docker commands (adds DOCKER_CONFIG where the credential helper is missing). */
  readonly dockerEnv: Record<string, string | undefined>;
  /** `docker compose <args>` in the staged directory; callers add .quiet()/.nothrow()/.text(). */
  compose(...args: string[]): ReturnType<typeof $>;
  /** Host port Docker assigned to `service`'s container port. */
  hostPort(service: string, containerPort: number): Promise<number>;
  /** Remove containers, the run's volumes and networks, and the staged copy. Safe to call twice. */
  remove(): Promise<void>;
}

interface ComposeFile {
  services?: Record<string, { ports?: string[] }>;
  volumes?: Record<string, { name?: string } | null>;
  networks?: Record<string, { name?: string; external?: boolean } | null>;
}

function tokens(scalar: string | undefined): Array<{ name: string; fallback: string }> {
  return [...(scalar ?? "").matchAll(INTERPOLATION)].map((m) => ({
    name: m[1] ?? "",
    fallback: m[2] ?? "",
  }));
}

/** The run-scoped overrides listed in the file header, derived from the compose file itself so new volumes/ports are covered. */
function scopedVariables(
  compose: ComposeFile,
  project: string
): { vars: Record<string, string>; createNetworks: string[] } {
  const vars: Record<string, string> = {};
  const createNetworks: string[] = [];
  for (const volume of Object.values(compose.volumes ?? {})) {
    for (const t of tokens(volume?.name)) vars[t.name] = `${project}-${t.fallback}`;
  }
  for (const [key, network] of Object.entries(compose.networks ?? {})) {
    for (const t of tokens(network?.name)) {
      if (!network?.external) {
        vars[t.name] = `${project}-${t.fallback}`;
      } else if (key === "monitoring") {
        vars[t.name] = `${project}-${t.fallback}`;
        createNetworks.push(vars[t.name] ?? "");
      }
    }
  }
  for (const service of Object.values(compose.services ?? {})) {
    for (const port of service.ports ?? []) {
      // "${BIND_IP:-127.0.0.1}:${PORT:-5432}:5432": first token binds, second publishes.
      const [bind, published] = tokens(port);
      if (bind) vars[bind.name] = "127.0.0.1";
      if (published) vars[published.name] = "0";
    }
  }
  return { vars, createNetworks };
}

const live = new Set<StagedStack>();
let handlersInstalled = false;
function removeAllOnSignal(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void Promise.allSettled([...live].map((stage) => stage.remove())).then(() =>
        process.exit(130)
      );
    });
  }
}

export async function stageStack(
  stack: StackName,
  vars: Record<string, string>,
  projectPrefix = `aza-pg-${stack}-test`
): Promise<StagedStack> {
  const root = await mkdtemp(join(tmpdir(), `aza-pg-${stack}-`));
  const dir = join(root, "stacks", stack);
  await cp(join(PROJECT_ROOT, "stacks", stack), dir, {
    recursive: true,
    // A developer's own .env must neither leak into the test nor be needed by it.
    filter: (source) => !/\/\.env(\.|$)/.test(source),
  });
  await cp(join(PROJECT_ROOT, SHARED_CONFIG), join(root, SHARED_CONFIG));

  const compose = Bun.YAML.parse(await Bun.file(join(dir, "compose.yml")).text()) as ComposeFile;
  const project = vars.COMPOSE_PROJECT_NAME ?? generateUniqueProjectName(projectPrefix);
  const scoped = scopedVariables(compose, project);
  const env: Record<string, string> = {
    POSTGRES_IMAGE: resolveImageTag({ argv: [] }),
    ...scoped.vars,
    ...vars,
    COMPOSE_PROJECT_NAME: project,
  };
  await Bun.write(
    join(dir, ".env"),
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );

  const dockerConfig = await getTestDockerConfig();
  const dockerEnv: Record<string, string | undefined> = dockerConfig
    ? { ...Bun.env, DOCKER_CONFIG: dockerConfig }
    : { ...Bun.env };
  // Variables from the caller's shell would override the staged .env (compose gives the environment priority).
  for (const key of Object.keys(env)) delete dockerEnv[key];
  const run = (...args: string[]) => $`docker compose ${args}`.cwd(dir).env(dockerEnv);

  // Networks the caller supplied (e.g. a replica joining the primary's monitoring network) are not ours to create.
  const ownNetworks = scoped.createNetworks.filter((name) => !Object.values(vars).includes(name));
  for (const network of ownNetworks) {
    await $`docker network create ${network}`.env(dockerEnv).quiet();
  }

  let removed = false;
  const stage: StagedStack = {
    dir,
    project,
    env,
    dockerEnv,
    compose: run,
    async hostPort(service, containerPort) {
      const out = (await run("port", service, String(containerPort)).quiet().text()).trim();
      const port = Number(out.slice(out.lastIndexOf(":") + 1));
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error(
          `${project}: no published host port for ${service}:${containerPort} ("${out}")`
        );
      }
      return port;
    },
    async remove() {
      if (removed) return;
      removed = true;
      live.delete(stage);
      await run("down", "-v", "--remove-orphans").quiet().nothrow();
      for (const network of ownNetworks) {
        await $`docker network rm ${network}`.env(dockerEnv).quiet().nothrow();
      }
      await cleanupTestDockerConfig(dockerConfig);
      await rm(root, { recursive: true, force: true });
    },
  };
  live.add(stage);
  removeAllOnSignal();
  return stage;
}
