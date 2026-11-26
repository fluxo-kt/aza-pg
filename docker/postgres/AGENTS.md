# docker/postgres/: entrypoint, upgrade and container scripts

Rules for the shell that runs inside the image. Root `AGENTS.md` applies too; the entrypoint is generated from its `.template` (`bun run generate`), so edit the template.

- **Branch on a tool's exit code, not its messages**: text matched from the one message you saw misses the tool's other messages for the same outcome. When only text carries the answer, read every message shape from the tool's source or a probe of each case, and treat an unknown shape as failure (`scripts/AGENTS.md` "Subprocess verdicts").
- **Select files by kind as well as name**: a name pattern written for directories (`pg_*`) also matches files (`pg_hba.conf`). Test `-d`/`-f` with the pattern.
- **Upgrade logic runs on both sides of a future upgrade**: what this image does beside another major's cluster also runs when the next major's release has upgraded the volume and the operator rolls back to this image. `test-major-upgrade.ts` runs only the already published previous release on that side, so a new check is never exercised there: place a newer-major cluster in the suite (as its major-99 case does) for any check that scans other clusters.
