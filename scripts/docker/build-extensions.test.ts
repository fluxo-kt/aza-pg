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
    const plan = `${cc} -I. -O0 ${inc} -c -o src/aead.o src/aead.c`;
    expect(unoptimisedCompileLine(plan)).toBe(plan);
  });

  test("an -O0 overridden by a later -O2 is optimised", () => {
    expect(unoptimisedCompileLine(`gcc -O0 -fPIC -O2 ${inc} -c -o a.o a.c`)).toBeUndefined();
  });

  test("the plain PostgreSQL flags pass", () => {
    expect(unoptimisedCompileLine(`${cc} -I. ${inc} -c -o src/x.o src/x.c`)).toBeUndefined();
  });

  test("only compile lines count: a link or echo line carrying -O0 is ignored", () => {
    const plan = [
      `${cc} -I. ${inc} -c -o src/x.o src/x.c`,
      "gcc -shared -o x.so src/x.o -O0 -L/usr/lib",
      "echo building with -O0 -c x.c",
    ].join("\n");
    expect(unoptimisedCompileLine(plan)).toBeUndefined();
  });

  test("cross and wrapped compilers are recognised", () => {
    for (const compiler of ["x86_64-linux-gnu-gcc-14", "/usr/bin/clang", "ccache gcc", "cc"]) {
      expect(unoptimisedCompileLine(`${compiler} -O2 -O0 ${inc} -c -o a.o a.c`)).toBeDefined();
    }
  });

  test("-O0 must be a whole flag: -O0x is not -O0", () => {
    expect(unoptimisedCompileLine(`gcc -O0x ${inc} -c -o a.o a.c`)).toBeUndefined();
  });
});
