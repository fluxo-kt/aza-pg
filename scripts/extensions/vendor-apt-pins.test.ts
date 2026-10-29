import { describe, expect, test } from "bun:test";
import { MANIFEST_ENTRIES } from "./manifest-data";
import { vendorAptPins } from "./vendor-apt-pins";

describe("vendorAptPins", () => {
  test("pins the Timescale loader at the extension's version", () => {
    const pins = vendorAptPins([
      {
        name: "timescaledb",
        install_via: "timescale",
        timescalePackage: "timescaledb-2-postgresql-18",
        timescaleVersion: "2.31.0~debian13-1806",
      },
    ]);
    expect(pins.map((p) => `${p.aptPackage}=${p.version}`)).toEqual([
      "timescaledb-2-postgresql-18=2.31.0~debian13-1806",
      "timescaledb-2-loader-postgresql-18=2.31.0~debian13-1806",
    ]);
  });

  test("skips disabled and non-vendor entries", () => {
    expect(
      vendorAptPins([
        {
          name: "a",
          enabled: false,
          install_via: "percona",
          perconaPackage: "p",
          perconaVersion: "1",
        },
        { name: "b", install_via: "pgdg" },
      ])
    ).toEqual([]);
  });

  test("an unpinned vendor package throws", () => {
    expect(() =>
      vendorAptPins([{ name: "x", install_via: "percona", perconaPackage: "percona-x" }])
    ).toThrow(/perconaVersion/);
  });

  // The real manifest must resolve: generate and check-vendor-apt both depend on it.
  test("the manifest yields one pin per vendor package", () => {
    const pins = vendorAptPins(MANIFEST_ENTRIES);
    expect(new Set(pins.map((p) => p.aptPackage)).size).toBe(pins.length);
  });
});
