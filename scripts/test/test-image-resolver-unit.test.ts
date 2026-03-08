#!/usr/bin/env bun
/**
 * Unit tests for image-resolver.ts
 * Verifies image tag resolution logic works correctly
 */

import { describe, test, expect } from "bun:test";
import {
  resolveImageTag,
  parseContainerName,
  validateImageTag,
  resolveImageWithSource,
} from "./image-resolver";

describe("resolveImageTag", () => {
  test("uses positional argument when provided", () => {
    const result = resolveImageTag({
      argv: ["bun", "script.ts", "custom:tag"],
    });
    expect(result).toBe("custom:tag");
  });

  test("uses --image flag when provided", () => {
    const result = resolveImageTag({
      argv: ["bun", "script.ts", "--image=flagged:tag"],
    });
    expect(result).toBe("flagged:tag");
  });

  test("prefers positional over flag", () => {
    const result = resolveImageTag({
      argv: ["bun", "script.ts", "positional:tag", "--image=flagged:tag"],
    });
    expect(result).toBe("positional:tag");
  });

  test("uses environment variable when no CLI args", () => {
    // Save original
    const orig = Bun.env.POSTGRES_IMAGE;

    try {
      // Set test env var
      Bun.env.POSTGRES_IMAGE = "env:tag";

      const result = resolveImageTag({
        argv: ["bun", "script.ts"],
      });
      expect(result).toBe("env:tag");
    } finally {
      // Restore
      if (orig === undefined) {
        delete Bun.env.POSTGRES_IMAGE;
      } else {
        Bun.env.POSTGRES_IMAGE = orig;
      }
    }
  });

  test("uses default when nothing provided", () => {
    const result = resolveImageTag({
      argv: ["bun", "script.ts"],
      envKey: "NONEXISTENT_VAR",
    });
    expect(result).toBe("ghcr.io/fluxo-kt/aza-pg:pg18");
  });

  test("uses custom default", () => {
    const result = resolveImageTag({
      argv: ["bun", "script.ts"],
      envKey: "NONEXISTENT_VAR",
      defaultImage: "aza-pg:custom",
    });
    expect(result).toBe("aza-pg:custom");
  });

  test("skips flags when looking for positional arg", () => {
    const result = resolveImageTag({
      argv: ["bun", "script.ts", "--some-flag", "actual:image"],
    });
    expect(result).toBe("actual:image");
  });

  test("handles digest references", () => {
    const digest = "ghcr.io/org/repo@sha256:abc123";
    const result = resolveImageTag({
      argv: ["bun", "script.ts", digest],
    });
    expect(result).toBe(digest);
  });
});

describe("parseContainerName", () => {
  test("parses container name from flag", () => {
    const result = parseContainerName(["bun", "script.ts", "--container=mycontainer"]);
    expect(result).toBe("mycontainer");
  });

  test("returns undefined when no container flag", () => {
    const result = parseContainerName(["bun", "script.ts"]);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty container flag", () => {
    const result = parseContainerName(["bun", "script.ts", "--container="]);
    expect(result).toBeUndefined();
  });
});

describe("validateImageTag", () => {
  test("accepts valid image tags", () => {
    expect(() => validateImageTag("aza-pg:pg18")).not.toThrow();
    expect(() => validateImageTag("ghcr.io/user/repo:tag")).not.toThrow();
  });

  test("rejects empty string", () => {
    expect(() => validateImageTag("")).toThrow("cannot be empty");
  });

  test("rejects whitespace-only string", () => {
    expect(() => validateImageTag("  ")).toThrow("cannot be empty");
  });

  test("rejects malformed digest reference", () => {
    expect(() => validateImageTag("repo:sha256:abc")).toThrow("Invalid digest reference");
  });

  test("accepts correct digest reference", () => {
    expect(() => validateImageTag("repo@sha256:abc123")).not.toThrow();
  });
});

describe("resolveImageWithSource", () => {
  test("reports correct source for positional arg", () => {
    const result = resolveImageWithSource({
      argv: ["bun", "script.ts", "image:tag"],
    });
    expect(result.image).toBe("image:tag");
    expect(result.source).toBe("CLI positional argument");
  });

  test("reports correct source for flag", () => {
    const result = resolveImageWithSource({
      argv: ["bun", "script.ts", "--image=image:tag"],
    });
    expect(result.image).toBe("image:tag");
    expect(result.source).toBe("CLI flag (--image=...)");
  });

  test("reports correct source for env var", () => {
    const orig = Bun.env.POSTGRES_IMAGE;
    try {
      Bun.env.POSTGRES_IMAGE = "env:tag";
      const result = resolveImageWithSource({
        argv: ["bun", "script.ts"],
      });
      expect(result.image).toBe("env:tag");
      expect(result.source).toBe("Environment variable (POSTGRES_IMAGE)");
    } finally {
      if (orig === undefined) {
        delete Bun.env.POSTGRES_IMAGE;
      } else {
        Bun.env.POSTGRES_IMAGE = orig;
      }
    }
  });

  test("reports correct source for default", () => {
    const result = resolveImageWithSource({
      argv: ["bun", "script.ts"],
      envKey: "NONEXISTENT_VAR",
    });
    expect(result.image).toBe("ghcr.io/fluxo-kt/aza-pg:pg18");
    expect(result.source).toBe("Default fallback");
  });
});
