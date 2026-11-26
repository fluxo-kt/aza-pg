/**
 * Finds pg_cron and Vault references that a pgflow migration executes at migration time, outside any function body.
 *
 * Why: pgflow-upgrade runs upstream's migrations in every pgflow database, but pg_cron exists only in the database
 * named by cron.database_name and Vault is optional, so a migration-time `SELECT cron.schedule…` or
 * `CREATE EXTENSION pg_cron` fails the whole upgrade there. The upgrade suite cannot see it (its database has
 * pg_cron), and the generator's anchored patches catch only CHANGED upstream text, never a NEW statement, so this
 * check reads every executable migration instead. References inside dollar-quoted bodies are fine: function bodies
 * run only when called, and the generator's own guards (`DO $aza$ … IF to_regclass(…)`) are dollar-quoted too, so a
 * guarded statement drops out here without any list of reviewed files to maintain.
 *
 * A lexer, not a regex over the file: dollar-quote tags must match exactly and string literals may contain `cron.`
 * (pgflow's COMMENT ON texts do), which a single pattern cannot get right.
 */
export function migrationTimeOptionalRefs(sql: string): string[] {
  let top = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (sql[i] === "'") {
      // '' inside a literal is an escaped quote, not its end; an E'' string (E not ending a longer word) also
      // escapes with a backslash, so \' is no end either. Ending early would hide the statements that follow.
      const backslashEscapes = /[Ee]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (backslashEscapes && sql[j] === "\\") j++;
        else if (sql[j] === "'" && sql[j + 1] === "'") j++;
        else if (sql[j] === "'") break;
      }
      i = j + 1;
      top += " ";
    } else {
      // PostgreSQL's tag: empty, or an identifier (letter or underscore first, then digits too). `$1` is a parameter.
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        top += " ";
      } else top += sql[i++];
    }
  }
  return [...new Set(top.match(/\b(?:cron|vault)\.\w+|\bpg_cron\b/gi) ?? [])];
}
