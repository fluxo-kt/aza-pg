# Extension Regression Tests (Tier 2)

Each `{extension}/sql/basic.sql` runs through `psql -X -a -q` against the image, and its output must equal `{extension}/expected/basic.out` after normalization (`scripts/test/lib/regression-runner.ts`).

`scripts/test/test-extension-regression.ts` runs every directory here whose manifest entry is not `enabled: false`; a directory whose name matches no manifest entry fails the run. Directories of disabled extensions stay so they run again when the extension is re-enabled.

## Run

```bash
bun scripts/test/test-extension-regression.ts                      # all enabled, default preloads
bun scripts/test/test-extension-regression.ts --mode=regression    # comprehensive preload list
bun scripts/test/test-extension-regression.ts --extensions=vector,pgmq
```

## Add or update a test

1. Write `{extension}/sql/basic.sql` (directory name = manifest entry `name`). Assert behaviour with exact values; never select `extversion` or other version strings — `scripts/test/test-extension-versions.ts` owns versions, and a version in an expected file breaks on every bump.
2. `bun scripts/test/test-extension-regression.ts --extensions={extension} --generate-expected`
3. Review the generated `expected/basic.out` diff line by line before committing: generation records whatever the image does, including a bug.

All files run in the `postgres` database (pg_cron and pg_net work only there), so each file must create uniquely named objects and drop them at the end. Avoid `random()` and `now()` in selected output.
