/** Git plumbing shared by the release scripts: each call either returns trimmed stdout or stops with git's error. */

export async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

export const isAncestor = async (a: string, b: string) =>
  (await Bun.spawn(["git", "merge-base", "--is-ancestor", a, b], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited) === 0;

/** Ends the script with a refusal; every message names what to do about it. */
export function stop(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}
