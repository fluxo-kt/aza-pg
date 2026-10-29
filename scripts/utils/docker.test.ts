import { describe, expect, test } from "bun:test";

import {
  generateUniqueContainerName,
  generateUniqueProjectName,
  TEST_SCOPE_ENV,
  testResourceOwnerPid,
} from "./docker";

// testResourceOwnerPid decides what the orphan sweep DELETES: a name whose owner pid is dead is removed. The tests try
// to make it claim a name no test generated, or misread the owner of one that a test did.

describe("testResourceOwnerPid", () => {
  test("reads the creating pid from generated names and every name compose derives from them", () => {
    for (const scope of [undefined, "tsshx14"]) {
      if (scope) Bun.env[TEST_SCOPE_ENV] = scope;
      else delete Bun.env[TEST_SCOPE_ENV];
      for (const root of [
        generateUniqueContainerName("aza-pg-security-db"),
        generateUniqueProjectName("aza-pg-primary-test"),
      ])
        for (const name of [root, `${root}-postgres-1`, `${root}_postgres_data`, `${root}_default`])
          expect(testResourceOwnerPid(name)).toBe(process.pid);
    }
    delete Bun.env[TEST_SCOPE_ENV];
  });

  test("claims no operator, build or foreign name", () => {
    for (const name of [
      "aza-pg-network",
      "aza-pg-builder",
      "aza-pg-primary-test",
      "aza-pg_postgres_data",
      "primary_postgres_data",
      "buildx_buildkit_aza-pg-builder0_state",
      "my-aza-pg--ssk-x", // marker, but not an aza-pg name
      "04ad98f00db7f7e9dda912ffa58094ef9b4719c797b1b93da0dc9dcabf7c1b79",
    ])
      expect(testResourceOwnerPid(name)).toBeNull();
  });

  test("refuses a prefix that would hide the owner marker", () => {
    for (const prefix of ["aza-pg--x", "other-prefix", "aza-pg-Upper"])
      expect(() => generateUniqueContainerName(prefix)).toThrow();
  });
});
