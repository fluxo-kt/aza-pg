/**
 * Single source of truth for all generated files
 *
 * Used by:
 * - pre-commit.ts: Auto-stage these files when manifest changes
 * - generate-all.ts: Could verify all outputs exist (future)
 *
 * When adding a new generator, add its output file(s) here.
 */

export const GENERATED_FILES = [
  // Docker artifacts
  "docker/postgres/Dockerfile",
  "docker/postgres/extensions.manifest.json",
  "docker/postgres/extensions.build-packages.txt",
  "docker/postgres/healthcheck.sh",
  "docker/postgres/docker-entrypoint-initdb.d/01-extensions.sql",
  "docker/postgres/IMAGE-CONTENTS.txt",

  // Documentation
  "docs/.generated/docs-data.json",
  "docs/EXTENSIONS.md",

  // PostgreSQL configs - base
  "docker/postgres/configs/postgresql-base.conf",

  // PostgreSQL configs - primary stack
  "stacks/primary/configs/postgresql-primary.conf",
  "stacks/primary/configs/pg_hba.conf",

  // PostgreSQL configs - replica stack
  "stacks/replica/configs/postgresql-replica.conf",
  "stacks/replica/configs/pg_hba.conf",

  // PostgreSQL configs - single stack
  "stacks/single/configs/postgresql.conf",
  "stacks/single/configs/pg_hba.conf",

  // Workflow configuration
  ".github/workflow-config.json",
] as const;

export type GeneratedFile = (typeof GENERATED_FILES)[number];
