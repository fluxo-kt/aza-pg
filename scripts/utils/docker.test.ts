import { describe, expect, test } from "bun:test";

import {
  generateUniqueContainerName,
  generateUniqueProjectName,
  TEST_SCOPE_ENV,
  testResourceOwner,
} from "./docker";

// testResourceOwner decides what the orphan sweep DELETES: a name it parses whose pid is dead is removed. The tests
// try to make it select something that is not a test resource, or to misread the owner of one that is.

describe("testResourceOwner", () => {
  test("finds the creating pid in generated names and every name compose derives from them", () => {
    for (const scope of [undefined, "tsshx14"]) {
      if (scope) Bun.env[TEST_SCOPE_ENV] = scope;
      else delete Bun.env[TEST_SCOPE_ENV];
      // An 8-letter word ("security") in the prefix must not be read as the stamp.
      for (const root of [
        generateUniqueContainerName("aza-pg-security-db"),
        generateUniqueProjectName("aza-pg-primary-test"),
      ]) {
        for (const name of [
          root,
          `${root}-postgres-primary`,
          `${root}_postgres_data`,
          `${root}_default`,
        ])
          expect(testResourceOwner(name)).toEqual({ root, pid: process.pid });
      }
    }
    delete Bun.env[TEST_SCOPE_ENV];
  });

  test("leaves operator, build and foreign names alone", () => {
    for (const name of [
      "aza-pg-network",
      "aza-pg-builder",
      "aza-pg_postgres_data",
      "primary_postgres_data",
      "buildx_buildkit_aza-pg-builder0_state",
      "aza-pg-backup-2026-ssk", // no 8-character stamp
      "aza-pg-security-db-ssk", // "security" decodes to a time after now
      "04ad98f00db7f7e9dda912ffa58094ef9b4719c797b1b93da0dc9dcabf7c1b79",
    ])
      expect(testResourceOwner(name)).toBeNull();
  });
});
