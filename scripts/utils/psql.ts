/**
 * The one way Docker suites run SQL in a container: every suite once carried its own `docker exec … psql` wrapper,
 * so a fix to one (quoting, session handling, error text) missed the others.
 */

export interface PsqlResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Defaults connect as postgres to the postgres database over the container's local socket. */
export interface PsqlTarget {
  user?: string;
  database?: string;
  /** Set to go over TCP, e.g. through PgBouncer inside the container. */
  host?: string;
  port?: number;
  /** Passed with `docker exec -e`, e.g. PGPASSWORD or PGPASSFILE. */
  env?: Record<string, string>;
}

/**
 * Run statements in ONE psql session (one `-c` each, so a SET applies to the statements after it), unaligned
 * rows without headers, stopping at the first error. stderr is kept even on success: NOTICE lines are evidence some
 * checks assert on, and a refused statement's error text is what a negative check matches.
 */
export async function psql(
  container: string,
  statements: string | string[],
  { user = "postgres", database = "postgres", host, port, env = {} }: PsqlTarget = {}
): Promise<PsqlResult> {
  const list = Array.isArray(statements) ? statements : [statements];
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      container,
      "psql",
      "-X",
      ...(host ? ["-h", host] : []),
      ...(port ? ["-p", String(port)] : []),
      "-U",
      user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      ...list.flatMap((sql) => ["-c", sql]),
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** Run statements and return stdout; throw naming the statements and psql's error when any fails. */
export async function sqlOk(
  container: string,
  statements: string | string[],
  target?: PsqlTarget
): Promise<string> {
  const result = await psql(container, statements, target);
  if (!result.ok) {
    // NOTICE lines (e.g. from DROP ... IF EXISTS) precede the error; report the error itself.
    const errors = result.err.split("\n").filter((line) => /ERROR|FATAL|error:/.test(line));
    const sql = [statements].flat().join("; ");
    throw new Error(
      `SQL failed in ${container}: ${errors.join("\n") || result.err || result.out}\n  SQL: ${sql}`
    );
  }
  return result.out;
}
