# deployments/ — hand-written VPS deployment examples

These compose files, scripts and runbooks copy the stacks' setup by hand, and no test suite boots them, so they drift from the image silently. Only `validate`'s `Image Runtime Contract` check and your own proof stand between a change here and an operator's broken deployment.

phase1 stays its own compose file rather than including `stacks/primary`: its monitoring is a different design — its own exporter query file (the Grafana dashboard needs those metrics), a dedicated `monitoring` login with database auto-discovery, and PgBouncer from `pgbouncer/pgbouncer` with `userlist.txt`. An include would also split its settings across two `.env` files, because the stack's `env_file: .env` resolves in `stacks/primary/`. Merging the two means choosing one monitoring design for every stack first.

- **Prove a change by booting it and connecting the way its consumers do**: from a sibling container on the compose network, over TCP, with a password — that is how pgbouncer, the exporters and a phase2 replica reach PostgreSQL. A query through `docker exec <postgres> psql` uses the container's Unix socket and proves nothing about them (the image listens on 127.0.0.1 unless `POSTGRES_BIND_IP` is set).
- **A runbook command is proven only by running it** against a real primary/replica, substituting only IPs, names and the image. Before/after controls read the pre-fix file from a commit hash, never `HEAD` (after your commit, `HEAD` is the fix).
- **Commands that run inside the container use `"$PGDATA"`**, single-quoted so the container expands it; pgBackRest config cannot expand variables, so it names `/var/lib/postgresql/18/docker`. Mount the data volume at `/var/lib/postgresql`: PG18 refuses to start on the pre-18 `/var/lib/postgresql/data` mount.
- **A fix here belongs in `stacks/` and `docs/` too, and the reverse**: `rg` the setting across all three before committing.
