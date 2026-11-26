# docker/postgres/: entrypoint, upgrade and container scripts

Rules for the shell that runs inside the image. Root `AGENTS.md` applies too; the entrypoint is generated from its `.template` (`bun run generate`), so edit the template.

- **Branch on a tool's exit code, not its messages**: text matched from the one message you saw misses the tool's other messages for the same outcome. When only text carries the answer, read every message shape from the tool's source or a probe of each case, and treat an unknown shape as failure (`scripts/AGENTS.md` "Subprocess verdicts").
- **Select files by kind as well as name**: a name pattern written for directories (`pg_*`) also matches files (`pg_hba.conf`). Test `-d`/`-f` with the pattern.
