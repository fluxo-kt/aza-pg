import { describe, expect, test } from "bun:test";
import { PGFLOW_VERSION } from "./version";

// The TypeScript client and DSL speak the SQL schema the image installs, so their pins in package.json must
// equal the manifest's pgflow tag; a mismatch means the tests exercise a client the image's schema does not serve.
describe("pgflow version", () => {
  test("package.json @pgflow/client and @pgflow/dsl equal the pgflow tag in manifest-data.ts (bump them together)", async () => {
    const pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =
      await Bun.file("package.json").json();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect({ client: deps["@pgflow/client"], dsl: deps["@pgflow/dsl"] }).toEqual({
      client: PGFLOW_VERSION,
      dsl: PGFLOW_VERSION,
    });
  });
});
