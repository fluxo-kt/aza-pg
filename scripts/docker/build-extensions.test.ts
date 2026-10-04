/**
 * Pure helpers of docker/postgres/build-extensions.ts (the builder-stage build driver).
 */

import { describe, expect, test } from "bun:test";
import { unoptimisedCompileLine } from "../../docker/postgres/build-extensions";

// Compile lines as `make -n` prints them for a PGXS module: CFLAGS (with PostgreSQL's -O2), then
// CPPFLAGS, where an upstream PG_CPPFLAGS lands.
const cc = "gcc -Wall -Wmissing-prototypes -O2 -fPIC -fvisibility=hidden";
const inc = "-I/usr/include/postgresql/18/server -D_GNU_SOURCE";

describe("unoptimisedCompileLine", () => {
  test("PG_CPPFLAGS = -O0 after PostgreSQL's -O2 is caught (pgsodium <= 3.1.11)", () => {
    const plan = [
      "/bin/mkdir -p '/usr/share/postgresql/18/extension'",
      `${cc} -I. -O0 ${inc} -c -o src/aead.o src/aead.c`,
    ].join("\n");
    expect(unoptimisedCompileLine(plan)).toBe(`${cc} -I. -O0 ${inc} -c -o src/aead.o src/aead.c`);
  });

  test("an -O0 overridden by a later -O2 is optimised", () => {
    expect(unoptimisedCompileLine(`gcc -O0 -fPIC -O2 ${inc} -c -o a.o a.c`)).toBeUndefined();
  });

  test("lines without -O, such as install-sh -c, do not match", () => {
    const plan = [
      `${cc} -I. ${inc} -c -o src/x.o src/x.c`,
      "/bin/sh /usr/lib/postgresql/18/lib/pgxs/config/install-sh -c -m 755 x.so '/usr/lib/postgresql/18/lib/'",
    ].join("\n");
    expect(unoptimisedCompileLine(plan)).toBeUndefined();
  });

  test("-O0 must be a whole flag: -O0x and -fno-O0 are not -O0", () => {
    expect(unoptimisedCompileLine(`gcc -O2 -O0x -fno-O0 ${inc} -c -o a.o a.c`)).toBeUndefined();
  });
});
