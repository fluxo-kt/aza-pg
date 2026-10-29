/**
 * The newest `## [v<pg>-<UTC yyyymmddHHMM>] - <yyyy-mm-dd>` heading in CHANGELOG.md is the release a
 * commit ships. /release writes it into the release commit (date-changelog.ts); publish.yml takes the
 * tag name (generate-version-tags.ts) and the GitHub notes (generate-release-notes.ts) from it, so the
 * heading, the tag and the notes can never disagree, and every branch shows the release dated.
 */

const RELEASE_HEADING = /^## \[v(\d+\.\d+)-(\d{12})\] - \d{4}-\d{2}-\d{2}$/;

export type Release = {
  /** Tag without the leading `v`, e.g. `18.6-202611101530`. */
  version: string;
  pgVersion: string;
  timestamp: string;
  /** Section body between this heading and the next `## [` heading or `---`, trimmed. */
  notes: string;
};

/** The first release heading below `[Unreleased]`, or null when the changelog has none. */
export function newestRelease(changelog: string): Release | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## [v"));
  const match = start === -1 ? null : RELEASE_HEADING.exec(lines[start] ?? "");
  if (!match) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## [") || line.startsWith("---"));
  const [, pgVersion = "", timestamp = ""] = match;
  return {
    version: `${pgVersion}-${timestamp}`,
    pgVersion,
    timestamp,
    notes: (end === -1 ? rest : rest.slice(0, end)).join("\n").trim(),
  };
}
