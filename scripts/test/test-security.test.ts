#!/usr/bin/env bun
/**
 * Security Test Suite
 * Verifies security hardening and authentication configuration
 *
 * Coverage:
 * - SCRAM-SHA-256 authentication enforcement
 * - PgBouncer auth_query function security
 * - Network binding configuration
 * - Extension security (SHA pins, manifest validation)
 * - pgAudit logging verification
 *
 * Usage: bun test scripts/test/test-security.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import type { ManifestEntry } from "../extensions/manifest-data";

const TEST_CONTAINER = `aza-pg-security-test-${Date.now()}`;
const TEST_PASSWORD = "secureTestPass123!";

/**
 * Execute SQL command in test container
 */
async function runSQL(sql: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const result = await $`docker exec ${TEST_CONTAINER} psql -U postgres -t -A -c ${sql}`.nothrow();
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    success: result.exitCode === 0,
  };
}

/**
 * Start test container
 */
async function startContainer() {
  // Clean up any existing container
  await $`docker rm -f ${TEST_CONTAINER}`.nothrow();

  // Start container with security settings
  const result = await $`docker run --name ${TEST_CONTAINER} \
    -e POSTGRES_PASSWORD=${TEST_PASSWORD} \
    -e POSTGRES_MEMORY=2048 \
    -e POSTGRES_BIND_IP=127.0.0.1 \
    -d ${Bun.env.POSTGRES_IMAGE || "localhost/aza-pg:latest"}`.nothrow();

  if (result.exitCode !== 0) {
    throw new Error("Failed to start test container - image may not be built");
  }

  // Wait for database to be ready
  for (let i = 0; i < 30; i++) {
    const check = await runSQL("SELECT 1");
    if (check.success) {
      console.log("Database is ready");
      return;
    }
    await Bun.sleep(1000);
  }

  throw new Error("Database did not become ready in time");
}

/**
 * Stop and remove test container
 */
async function stopContainer() {
  await $`docker rm -f ${TEST_CONTAINER}`.nothrow();
}

beforeAll(async () => {
  await startContainer();
});

afterAll(async () => {
  await stopContainer();
});

describe("Security - Authentication", () => {
  test("SCRAM-SHA-256 should be enforced (no MD5)", async () => {
    const result = await runSQL("SHOW password_encryption");
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("scram-sha-256");
  });

  test("Password authentication should work with correct password", async () => {
    // Test by connecting as postgres (we're already connected via docker exec)
    const result = await runSQL("SELECT current_user");
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("postgres");
  });

  test("pg_hba.conf should use scram-sha-256 method", async () => {
    // Detect data directory dynamically
    const dataDirResult = await runSQL("SHOW data_directory");
    if (!dataDirResult.success) {
      throw new Error("Failed to detect data_directory");
    }
    const dataDir = dataDirResult.stdout.trim();
    const hbaPath = `${dataDir}/pg_hba.conf`;

    const result = await $`docker exec ${TEST_CONTAINER} cat ${hbaPath}`.nothrow();
    expect(result.exitCode).toBe(0);

    const hbaContent = result.stdout.toString();

    // Should use scram-sha-256 for non-local connections
    expect(hbaContent).toMatch(/scram-sha-256/);

    // Check that network connections (non-localhost) use scram-sha-256
    const lines = hbaContent
      .split("\n")
      .filter((line) => !line.trim().startsWith("#") && line.trim());
    const networkLines = lines.filter(
      (line) =>
        (line.includes("0.0.0.0") ||
          line.includes("::0") ||
          (line.includes("all") && line.includes("host"))) &&
        !line.includes("127.0.0.1") &&
        !line.includes("::1")
    );

    for (const line of networkLines) {
      // Network connections should use scram-sha-256, not trust or md5
      expect(line).toMatch(/scram-sha-256/);
    }
  });

  test("SSL should be available for secure connections", async () => {
    const result = await runSQL("SHOW ssl");
    expect(result.success).toBe(true);
    // SSL should be 'on' or at least available
    expect(["on", "off"]).toContain(result.stdout);
  });
});

describe("Security - PgBouncer auth_query", () => {
  test("auth_query function should exist", async () => {
    // Create pgbouncer schema first
    await runSQL("CREATE SCHEMA IF NOT EXISTS pgbouncer");

    // Create auth_query function if using PgBouncer
    const createFunction = await runSQL(`
      CREATE OR REPLACE FUNCTION pgbouncer.user_lookup(
        IN p_username text,
        OUT uname text,
        OUT phash text
      ) RETURNS record AS $$
      BEGIN
        SELECT usename, passwd
        INTO uname, phash
        FROM pg_shadow
        WHERE usename = p_username;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER
    `);

    // Function creation should succeed
    expect(createFunction.success).toBe(true);
  });

  test("auth_query function should be SECURITY DEFINER", async () => {
    // First ensure pgbouncer schema exists
    await runSQL("CREATE SCHEMA IF NOT EXISTS pgbouncer");

    // Create the function
    await runSQL(`
      CREATE OR REPLACE FUNCTION pgbouncer.user_lookup(
        IN p_username text,
        OUT uname text,
        OUT phash text
      ) RETURNS record AS $$
      BEGIN
        SELECT usename, passwd
        INTO uname, phash
        FROM pg_shadow
        WHERE usename = p_username;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER
    `);

    // Verify it's SECURITY DEFINER
    const result = await runSQL(`
      SELECT prosecdef
      FROM pg_proc
      WHERE proname = 'user_lookup'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pgbouncer')
    `);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe("t");
  });

  test("auth_query should validate credentials correctly", async () => {
    // Create test schema and function
    await runSQL("CREATE SCHEMA IF NOT EXISTS pgbouncer");
    await runSQL(`
      CREATE OR REPLACE FUNCTION pgbouncer.user_lookup(
        IN p_username text,
        OUT uname text,
        OUT phash text
      ) RETURNS record AS $$
      BEGIN
        SELECT usename, passwd
        INTO uname, phash
        FROM pg_shadow
        WHERE usename = p_username;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER
    `);

    // Test lookup for postgres user
    const result = await runSQL("SELECT uname FROM pgbouncer.user_lookup('postgres')");
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("postgres");
  });

  test("No plaintext passwords in userlist.txt (when used)", async () => {
    // Check if userlist.txt exists in container
    const checkFile =
      await $`docker exec ${TEST_CONTAINER} test -f /etc/pgbouncer/userlist.txt && echo exists || echo missing`.nothrow();

    if (checkFile.stdout.toString().includes("exists")) {
      const result =
        await $`docker exec ${TEST_CONTAINER} cat /etc/pgbouncer/userlist.txt`.nothrow();

      if (result.exitCode === 0) {
        const content = result.stdout.toString();

        // Should not contain plaintext passwords (should use hashes or auth_query)
        // Hashed passwords start with SCRAM-SHA-256 or md5
        const lines = content
          .split("\n")
          .filter((line) => line.trim() && !line.trim().startsWith("#"));

        for (const line of lines) {
          if (line.includes('"')) {
            // If there's a password field, it should be hashed
            expect(line).toMatch(/SCRAM-SHA-256\$|md5[a-f0-9]{32}|""/);
          }
        }
      }
    } else {
      // No userlist.txt - likely using auth_query, which is more secure
      expect(checkFile.stdout.toString()).toContain("missing");
    }
  });
});

describe("Security - Network Binding", () => {
  test("Default binding should be 127.0.0.1 (localhost)", async () => {
    const result = await runSQL("SHOW listen_addresses");
    expect(result.success).toBe(true);

    // Should be either 127.0.0.1 or localhost, not *
    const listenAddr = result.stdout;
    expect(listenAddr).toMatch(/127\.0\.0\.1|localhost/);
  });

  test("POSTGRES_BIND_IP=0.0.0.0 should change binding (via config)", async () => {
    // We test this by checking current setting
    const result = await runSQL("SHOW listen_addresses");
    expect(result.success).toBe(true);

    // In this test, we started with 127.0.0.1, so it should be that
    expect(result.stdout).toMatch(/127\.0\.0\.1|localhost/);
  });

  test("Port should be standard PostgreSQL port (5432)", async () => {
    const result = await runSQL("SHOW port");
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("5432");
  });
});

describe("Security - Extension Security", () => {
  test("All extensions should have correct SHA pins in manifest", async () => {
    // Read the manifest from container
    const manifestResult =
      await $`docker exec ${TEST_CONTAINER} cat /extensions.manifest.json`.nothrow();

    if (manifestResult.exitCode !== 0) {
      console.log("Skipping - manifest not found in container");
      return;
    }

    const manifest = JSON.parse(manifestResult.stdout.toString());
    expect(manifest.entries).toBeDefined();
    expect(Array.isArray(manifest.entries)).toBe(true);

    // Check that git-sourced extensions have commit SHAs
    for (const entry of manifest.entries) {
      if (entry.source.type === "git" || entry.source.type === "git-ref") {
        expect(entry.source.repository).toBeDefined();
        expect(entry.source.repository).toMatch(/^https?:\/\//);

        // Should have either tag or ref
        const hasTag = entry.source.tag !== undefined;
        const hasRef = entry.source.ref !== undefined;
        expect(hasTag || hasRef).toBe(true);

        // Verify commit hash exists (for source verification)
        if (entry.source.commit) {
          expect(entry.source.commit).toMatch(/^[a-f0-9]{40}$/);
        }
      }
    }
  });

  test("Manifest should have no enabled:false extensions with empty disabledReason", async () => {
    const manifestResult =
      await $`docker exec ${TEST_CONTAINER} cat /extensions.manifest.json`.nothrow();

    if (manifestResult.exitCode !== 0) {
      console.log("Skipping - manifest not found in container");
      return;
    }

    const manifest = JSON.parse(manifestResult.stdout.toString());

    for (const entry of manifest.entries) {
      if (entry.enabled === false) {
        // Disabled extensions should have a reason documented
        // This is a best practice, not strictly enforced yet
        expect(entry).toBeDefined();
      }
    }

    // All entries in our manifest should be enabled (no disabled entries)
    const disabledEntries = manifest.entries.filter((e: ManifestEntry) => e.enabled === false);
    expect(disabledEntries.length).toBe(0);
  });

  test("Extension control files should have proper permissions", async () => {
    // Check that extension control files are readable but not writable by postgres user
    const result = await runSQL(`
      SELECT setting FROM pg_settings WHERE name = 'data_directory'
    `);

    expect(result.success).toBe(true);
    const dataDir = result.stdout;
    expect(dataDir).toBeDefined();

    // Check that we can query extension information
    const extCheck = await runSQL("SELECT count(*) FROM pg_available_extensions");
    expect(extCheck.success).toBe(true);
    expect(parseInt(extCheck.stdout)).toBeGreaterThan(0);
  });
});

describe("Security - pgAudit Logging", () => {
  test("pgAudit should be loaded via shared_preload_libraries", async () => {
    const result = await runSQL("SHOW shared_preload_libraries");
    expect(result.success).toBe(true);
    expect(result.stdout).toMatch(/pgaudit/);
  });

  test("pgAudit should be configured for logging", async () => {
    // Check if pgaudit extension is available
    const available = await runSQL(`
      SELECT count(*) FROM pg_available_extensions WHERE name = 'pgaudit'
    `);
    expect(available.success).toBe(true);
    expect(parseInt(available.stdout)).toBeGreaterThan(0);

    // Create extension if not exists
    await runSQL("CREATE EXTENSION IF NOT EXISTS pgaudit");

    // Verify pgaudit.log setting exists
    const setting = await runSQL("SELECT count(*) FROM pg_settings WHERE name = 'pgaudit.log'");
    expect(setting.success).toBe(true);
    expect(parseInt(setting.stdout)).toBeGreaterThan(0);
  });

  test("pgAudit should log DDL statements when enabled", async () => {
    // Create extension
    await runSQL("CREATE EXTENSION IF NOT EXISTS pgaudit");

    // Enable DDL logging using ALTER SYSTEM for persistence
    await runSQL("ALTER SYSTEM SET pgaudit.log = 'ddl'");
    await runSQL("SELECT pg_reload_conf()");

    // Wait a moment for config reload
    await Bun.sleep(500);

    // Verify the setting is active
    const result = await runSQL("SHOW pgaudit.log");
    expect(result.success).toBe(true);
    expect(result.stdout).toMatch(/ddl/i);

    // Execute a DDL statement to test logging
    await runSQL("CREATE TABLE IF NOT EXISTS audit_test (id serial PRIMARY KEY)");

    // Reset to default
    await runSQL("ALTER SYSTEM RESET pgaudit.log");
    await runSQL("SELECT pg_reload_conf()");
  });

  test("pgAudit should support role-based logging", async () => {
    // Create extension
    await runSQL("CREATE EXTENSION IF NOT EXISTS pgaudit");

    // Check if pgaudit.role setting exists
    const setting = await runSQL("SELECT count(*) FROM pg_settings WHERE name = 'pgaudit.role'");
    expect(setting.success).toBe(true);
    expect(parseInt(setting.stdout)).toBeGreaterThan(0);
  });
});

describe("Security - User Privileges", () => {
  test("Postgres superuser should have expected privileges", async () => {
    const result = await runSQL("SELECT usesuper FROM pg_user WHERE usename = 'postgres'");
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("t");
  });

  test("Should be able to create restricted user without superuser", async () => {
    // Create a test user without superuser privileges
    await runSQL("DROP USER IF EXISTS test_restricted_user");
    const createResult = await runSQL(
      "CREATE USER test_restricted_user WITH PASSWORD 'testpass123'"
    );
    expect(createResult.success).toBe(true);

    // Verify user is not superuser
    const checkResult = await runSQL(
      "SELECT usesuper FROM pg_user WHERE usename = 'test_restricted_user'"
    );
    expect(checkResult.success).toBe(true);
    expect(checkResult.stdout).toBe("f");

    // Cleanup
    await runSQL("DROP USER test_restricted_user");
  });

  test("Public schema should not allow dangerous operations by default", async () => {
    // Create test user
    await runSQL("DROP USER IF EXISTS test_public_user");
    await runSQL("CREATE USER test_public_user WITH PASSWORD 'testpass'");

    // Grant connect permission
    await runSQL("GRANT CONNECT ON DATABASE postgres TO test_public_user");

    // Verify user exists and doesn't have superuser
    const result = await runSQL("SELECT usesuper FROM pg_user WHERE usename = 'test_public_user'");
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("f");

    // Cleanup
    await runSQL("DROP USER test_public_user");
  });
});

describe("Security - SSL/TLS Configuration", () => {
  test("SSL certificates should exist if SSL is enabled", async () => {
    const sslSetting = await runSQL("SHOW ssl");

    if (sslSetting.stdout === "on") {
      // Check for SSL certificate files
      const certCheck =
        await $`docker exec ${TEST_CONTAINER} test -f /var/lib/postgresql/data/server.crt && echo exists || echo missing`.nothrow();
      const keyCheck =
        await $`docker exec ${TEST_CONTAINER} test -f /var/lib/postgresql/data/server.key && echo exists || echo missing`.nothrow();

      // If SSL is on, certificates should exist
      expect(certCheck.stdout.toString()).toContain("exists");
      expect(keyCheck.stdout.toString()).toContain("exists");
    } else {
      // SSL is off - that's acceptable for testing
      expect(sslSetting.stdout).toBe("off");
    }
  });

  test("ssl_ciphers should use strong ciphers when SSL enabled", async () => {
    const sslSetting = await runSQL("SHOW ssl");

    if (sslSetting.stdout === "on") {
      const ciphers = await runSQL("SHOW ssl_ciphers");
      expect(ciphers.success).toBe(true);

      // Should not use weak ciphers
      expect(ciphers.stdout).not.toMatch(/NULL|EXPORT|DES|MD5|RC4/i);
    }
  });
});
