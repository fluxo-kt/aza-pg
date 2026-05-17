import { describe, expect, test } from "bun:test";
import { findSecretFindingsInText } from "./secret-scan";

describe("secret scan", () => {
  test("flags quoted hardcoded secret-like assignments", () => {
    const findings = findSecretFindingsInText(
      "scripts/example.ts",
      'const config = { password: "abc123456789" };'
    );

    expect(findings).toHaveLength(1);
  });

  test("flags unquoted shell assignments with non-identifier values", () => {
    const findings = findSecretFindingsInText("scripts/example.sh", "TOKEN=abc123456789");

    expect(findings).toHaveLength(1);
  });

  test("ignores TypeScript function calls assigned to sensitive property names", () => {
    const findings = findSecretFindingsInText(
      "scripts/docker/setup-pgflow-container.ts",
      'password: requiredString(values.password, "--password"),'
    );

    expect(findings).toHaveLength(0);
  });

  test("ignores ternary branches that mention token identifiers", () => {
    const findings = findSecretFindingsInText(
      "scripts/pgflow/generate-schema.ts",
      "return exitCode === 0 && token ? token : undefined;"
    );

    expect(findings).toHaveLength(0);
  });

  test("ignores TypeScript member expressions assigned to sensitive variable names", () => {
    const findings = findSecretFindingsInText(
      "scripts/pgflow/generate-schema.ts",
      "const token = stdout.trim();"
    );

    expect(findings).toHaveLength(0);
  });

  test("ignores environment lookups", () => {
    const findings = findSecretFindingsInText(
      "scripts/pgflow/generate-schema.ts",
      "const envToken = Bun.env.GITHUB_TOKEN ?? Bun.env.GH_TOKEN;"
    );

    expect(findings).toHaveLength(0);
  });
});
