import { describe, expect, test } from "bun:test";
import { pgdgAptPackageName } from "./pgdg-package";

describe("pgdgAptPackageName", () => {
  test("extension installs under its pgdgPackage suffix", () => {
    expect(
      pgdgAptPackageName({ name: "vector", kind: "extension", pgdgPackage: "pgvector" }, "18")
    ).toBe("postgresql-18-pgvector");
  });

  test("tool without pgdgPackage installs under its own name", () => {
    expect(pgdgAptPackageName({ name: "pgbackrest", kind: "tool" }, "18")).toBe("pgbackrest");
  });

  // wal2json is a tool (no CREATE EXTENSION) yet PGDG packages it per PostgreSQL major.
  test("tool with pgdgPackage installs the per-major package", () => {
    expect(
      pgdgAptPackageName({ name: "wal2json", kind: "tool", pgdgPackage: "wal2json" }, "18")
    ).toBe("postgresql-18-wal2json");
  });

  test("extension without pgdgPackage throws instead of guessing", () => {
    expect(() => pgdgAptPackageName({ name: "vector", kind: "extension" }, "18")).toThrow(
      /no pgdgPackage/
    );
  });
});
