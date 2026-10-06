import { describe, expect, test } from "bun:test";

import { findProblems } from "./subprocess-calls";

const flagged = (file: string, text: string) => findProblems(file, text).length > 0;

describe("container docker rm needs -v in its own arguments", () => {
  test.each([
    ["shell text", "s.sh", "docker rm -f pg"],
    ["container alias", "s.sh", "docker container rm -f pg"],
    [
      "-v only on the next command",
      "a.ts",
      "await $`docker rm -f ${a}`; await $`docker run -v x:/y img`;",
    ],
    ["array form", "a.ts", 'await run(["docker", "rm", "-f", name]);'],
    [
      "array alias, split over lines",
      "a.ts",
      'Bun.spawn([\n  "docker",\n  "container",\n  "rm",\n  name,\n]);',
    ],
    ["workflow step", "w.yml", "      - run: docker rm -f pg || true"],
  ])("%s is flagged", (_, file, text) => expect(flagged(file, text)).toBe(true));

  test.each([
    ["-v", "s.sh", "docker rm -f -v pg"],
    ["bundled -fv", "s.sh", "docker rm -fv pg"],
    ["--volumes", "s.sh", "docker rm --volumes pg"],
    ["array with -v", "a.ts", 'Bun.spawn(["docker", "rm", "-f", "-v", name]);'],
    ["docker rmi", "s.sh", "docker rmi img"],
    ["docker volume rm", "s.sh", "docker volume rm vol"],
    ["a comment", "a.ts", "  // docker rm -f pg would orphan the volume"],
  ])("%s passes", (_, file, text) => expect(flagged(file, text)).toBe(false));
});

describe("subprocess env objects keep the parent environment", () => {
  test.each([
    [".env object", "await $`docker compose up`.env({ COMPOSE_PROJECT_NAME: name });"],
    ["spawn env option", "Bun.spawn(cmd, { env: { COMPOSE_PROJECT_NAME: name } });"],
    [
      "spawnSync env option, multi-line",
      "Bun.spawnSync(cmd, {\n  stdout: 'pipe',\n  env: {\n    A: '1',\n  },\n});",
    ],
  ])("%s is flagged", (_, text) => expect(flagged("a.ts", text)).toBe(true));

  test.each([
    [
      ".env spread wrapped by the formatter",
      "await $`docker compose up -d`.env({\n  ...Bun.env,\n  COMPOSE_PROJECT_NAME: name,\n});",
    ],
    ["spawn env spreading process.env", "spawn(cmd, { env: { ...process.env, A: '1' } });"],
    [
      "deliberate minimal env naming PATH",
      "Bun.spawnSync(cmd, { env: { PATH: Bun.env.PATH ?? '/bin', ...env } });",
    ],
    [
      "a test case's container env",
      "const cases = [{ name: 'x', env: { POSTGRES_MEMORY: '1536' } }];",
    ],
  ])("%s passes", (_, text) => expect(flagged("a.ts", text)).toBe(false));
});

describe("docker exec fed by stdin needs -i", () => {
  const md = (body: string) => `Run:\n\n\`\`\`bash\n${body}\n\`\`\`\n`;
  test.each([
    [
      "heredoc in a doc code block",
      "d.md",
      md("docker exec postgres psql -U postgres <<EOF\nSELECT 1;\nEOF"),
    ],
    ["pipe", "s.sh", "cat dump.sql | docker exec pg psql -U postgres"],
    ["redirect", "w.yml", "      - run: docker exec pg psql -U postgres < init.sql"],
    ["-i only after the container", "s.sh", "docker exec pg psql -i <<EOF"],
  ])("%s is flagged", (_, file, text) => expect(flagged(file, text)).toBe(true));

  test.each([
    ["-i", "d.md", md("docker exec -i postgres psql <<EOF\nSELECT 1;\nEOF")],
    ["-i after a valued option", "s.sh", "docker exec -u postgres -i pg psql < init.sql"],
    ["bundled -it", "s.sh", "cat x | docker exec -it pg psql"],
    ["prose outside a code block", "d.md", "Never run docker exec pg psql <<EOF without -i."],
    ["< inside an SQL string", "s.sh", 'docker exec pg psql -c "SELECT 1 < 2"'],
    ["placeholders", "d.md", md("docker exec <container> pg_dump -d <database> > backup.sql")],
    [
      "heredoc inside the container's own shell",
      "s.sh",
      "docker exec pg bash -c 'cat > f << \"EOF\"\nx\nEOF'",
    ],
    ["docker compose exec keeps stdin", "s.sh", "docker compose exec postgres psql <<EOF"],
    ["pipe into a later command", "s.sh", "docker exec pg psql -c 'SELECT 1' | grep 1"],
  ])("%s passes", (_, file, text) => expect(flagged(file, text)).toBe(false));
});
