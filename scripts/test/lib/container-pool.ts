/**
 * Container Pool for Test Isolation
 *
 * Maintains a pool of pre-warmed PostgreSQL containers to speed up test execution.
 * Instead of starting/stopping containers per test (~10-15s overhead), tests acquire
 * containers from the pool and use schema isolation for independence.
 *
 * Schema Isolation Pattern:
 * - Each test gets a unique schema (test_<timestamp>_<random>)
 * - search_path is set to the test schema
 * - Schema is dropped on release (CASCADE removes all objects)
 *
 * Usage:
 *   const pool = new ContainerPool({ poolSize: 3 });
 *   await pool.initialize();
 *
 *   // In test
 *   const container = await pool.acquire();
 *   try {
 *     await container.execute('CREATE TABLE foo (id int)');
 *     // ... test logic
 *   } finally {
 *     await pool.release(container);
 *   }
 *
 *   await pool.shutdown();
 */

import { $ } from "bun";

export interface PoolConfig {
  /** Number of containers to pre-warm (default: 2) */
  poolSize?: number;
  /** Docker image to use (default: auto-detect) */
  image?: string;
  /** Container startup timeout in seconds (default: 60) */
  startupTimeout?: number;
  /** Postgres password (default: generated) */
  password?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Shared preload libraries */
  sharedPreloadLibraries?: string;
}

export interface PooledContainer {
  /** Container name */
  name: string;
  /** Unique schema for this acquisition */
  schema: string;
  /** Execute SQL in the container's schema */
  execute: (sql: string) => Promise<string>;
  /** Execute SQL and return rows as objects */
  query: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
}

interface ContainerInfo {
  name: string;
  inUse: boolean;
  currentSchema: string | null;
}

/**
 * Manages a pool of PostgreSQL containers for test isolation
 */
export class ContainerPool {
  private readonly config: Required<PoolConfig>;
  private containers: ContainerInfo[] = [];
  private initialized = false;
  private shuttingDown = false;

  constructor(config: PoolConfig = {}) {
    this.config = {
      poolSize: config.poolSize ?? 2,
      image: config.image ?? this.detectImage(),
      startupTimeout: config.startupTimeout ?? 60,
      password: config.password ?? `test_pool_${Date.now()}`,
      env: config.env ?? {},
      sharedPreloadLibraries:
        config.sharedPreloadLibraries ??
        "auto_explain,pg_cron,pg_stat_monitor,pg_stat_statements,pgaudit,safeupdate,timescaledb",
    };
  }

  /**
   * Auto-detect the Docker image to use
   */
  private detectImage(): string {
    // Check for POSTGRES_IMAGE env var first
    if (process.env.POSTGRES_IMAGE) {
      return process.env.POSTGRES_IMAGE;
    }
    // Default to testing image
    return "ghcr.io/fluxo-kt/aza-pg-testing:testing-main";
  }

  /**
   * Initialize the pool by starting all containers
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new Error("Pool already initialized");
    }

    console.log(`Initializing container pool (size: ${this.config.poolSize})...`);

    // Start containers in parallel
    const startPromises = Array.from({ length: this.config.poolSize }, (_, i) =>
      this.startContainer(i)
    );

    await Promise.all(startPromises);
    this.initialized = true;

    console.log(`Container pool ready (${this.containers.length} containers)`);
  }

  /**
   * Start a single container and add to pool
   */
  private async startContainer(index: number): Promise<void> {
    const name = `test-pool-${Date.now()}-${process.pid}-${index}`;

    const envArgs = [
      `-e POSTGRES_PASSWORD=${this.config.password}`,
      `-e POSTGRES_SHARED_PRELOAD_LIBRARIES=${this.config.sharedPreloadLibraries}`,
      ...Object.entries(this.config.env).map(([k, v]) => `-e ${k}=${v}`),
    ].join(" ");

    try {
      // Start container
      await $`docker run -d --name ${name} ${envArgs.split(" ")} ${this.config.image}`.quiet();

      // Wait for ready
      await this.waitForReady(name);

      this.containers.push({
        name,
        inUse: false,
        currentSchema: null,
      });

      console.log(`  Container ${index + 1}/${this.config.poolSize} ready: ${name}`);
    } catch (error) {
      // Clean up on failure
      await $`docker rm -f ${name}`.quiet().nothrow();
      throw error;
    }
  }

  /**
   * Wait for container to be ready
   */
  private async waitForReady(name: string): Promise<void> {
    const startTime = Date.now();
    const timeout = this.config.startupTimeout * 1000;

    while (Date.now() - startTime < timeout) {
      try {
        const result = await $`docker exec ${name} pg_isready -U postgres -d postgres`
          .quiet()
          .nothrow();
        if (result.exitCode === 0) {
          // Additional stability check
          await Bun.sleep(1000);
          const check = await $`docker exec ${name} psql -U postgres -d postgres -tAc "SELECT 1"`
            .quiet()
            .nothrow();
          if (check.exitCode === 0 && check.stdout.toString().trim() === "1") {
            return;
          }
        }
      } catch {
        // Container not ready yet
      }
      await Bun.sleep(500);
    }

    throw new Error(
      `Container ${name} failed to become ready within ${this.config.startupTimeout}s`
    );
  }

  /**
   * Acquire a container from the pool
   */
  async acquire(): Promise<PooledContainer> {
    if (!this.initialized) {
      throw new Error("Pool not initialized. Call initialize() first.");
    }

    if (this.shuttingDown) {
      throw new Error("Pool is shutting down");
    }

    // Find an available container
    const container = this.containers.find((c) => !c.inUse);

    if (!container) {
      // All containers in use - wait for one to become available
      console.log("All containers in use, waiting...");
      await this.waitForAvailable();
      return this.acquire();
    }

    // Create unique schema for this acquisition
    const schema = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Create schema and set search_path
    // Include pg_catalog to ensure system tables are accessible
    await this.executeRaw(
      container.name,
      `CREATE SCHEMA IF NOT EXISTS "${schema}"; SET search_path TO "${schema}", public, pg_catalog;`
    );

    container.inUse = true;
    container.currentSchema = schema;

    return {
      name: container.name,
      schema,
      execute: (sql: string) => this.executeInSchema(container.name, schema, sql),
      query: <T>(sql: string) => this.queryInSchema<T>(container.name, schema, sql),
    };
  }

  /**
   * Release a container back to the pool
   */
  async release(pooled: PooledContainer): Promise<void> {
    const container = this.containers.find((c) => c.name === pooled.name);
    if (!container) {
      throw new Error(`Container ${pooled.name} not found in pool`);
    }

    // Drop the schema to clean up all test objects
    if (container.currentSchema) {
      try {
        await this.executeRaw(
          container.name,
          `DROP SCHEMA IF EXISTS "${container.currentSchema}" CASCADE;`
        );
      } catch (error) {
        console.warn(`Warning: Failed to drop schema ${container.currentSchema}:`, error);
      }
    }

    container.inUse = false;
    container.currentSchema = null;
  }

  /**
   * Wait for a container to become available
   */
  private async waitForAvailable(): Promise<void> {
    while (!this.containers.some((c) => !c.inUse)) {
      if (this.shuttingDown) {
        throw new Error("Pool is shutting down while waiting for container");
      }
      await Bun.sleep(100);
    }
  }

  /**
   * Execute raw SQL without schema prefix
   */
  private async executeRaw(containerName: string, sql: string): Promise<string> {
    const result = await $`docker exec ${containerName} psql -U postgres -d postgres -c ${sql}`
      .quiet()
      .nothrow();

    if (result.exitCode !== 0) {
      throw new Error(`SQL execution failed: ${result.stderr.toString()}`);
    }

    return result.stdout.toString();
  }

  /**
   * Execute SQL in a specific schema
   */
  private async executeInSchema(
    containerName: string,
    schema: string,
    sql: string
  ): Promise<string> {
    // Include pg_catalog to ensure system tables are accessible
    const wrappedSql = `SET search_path TO "${schema}", public, pg_catalog; ${sql}`;
    return this.executeRaw(containerName, wrappedSql);
  }

  /**
   * Query SQL and return parsed results
   */
  private async queryInSchema<T = Record<string, unknown>>(
    containerName: string,
    schema: string,
    sql: string
  ): Promise<T[]> {
    // Build the SQL with proper separation: SET cannot be in a subquery
    // Include pg_catalog to ensure system tables are accessible
    const cleanSql = sql.replace(/;$/, "");
    const wrappedSql = `SET search_path TO "${schema}", public, pg_catalog; SELECT json_agg(t) FROM (${cleanSql}) t`;

    // Use JSON output format for easier parsing
    // -q: quiet mode (suppress NOTICE messages and SET output)
    // -A: unaligned output
    // -t: tuples only (no headers)
    const result =
      await $`docker exec ${containerName} psql -U postgres -d postgres -qAt -c ${wrappedSql}`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) {
      throw new Error(`Query failed: ${result.stderr.toString()}`);
    }

    const output = result.stdout.toString().trim();
    if (!output || output === "" || output === "null") {
      return [];
    }

    try {
      return JSON.parse(output) as T[];
    } catch {
      // If JSON parsing fails, the query probably wasn't a SELECT
      return [];
    }
  }

  /**
   * Shutdown the pool and clean up all containers
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    console.log("Shutting down container pool...");

    // Stop all containers in parallel
    const stopPromises = this.containers.map(async (container) => {
      try {
        await $`docker rm -f ${container.name}`.quiet();
      } catch (error) {
        console.warn(`Warning: Failed to stop container ${container.name}:`, error);
      }
    });

    await Promise.all(stopPromises);
    this.containers = [];
    this.initialized = false;

    console.log("Container pool shutdown complete");
  }

  /**
   * Get pool statistics
   */
  getStats(): { total: number; inUse: number; available: number } {
    const inUse = this.containers.filter((c) => c.inUse).length;
    return {
      total: this.containers.length,
      inUse,
      available: this.containers.length - inUse,
    };
  }
}

/**
 * Create a singleton pool instance for sharing across tests
 */
let globalPool: ContainerPool | null = null;

export async function getGlobalPool(config?: PoolConfig): Promise<ContainerPool> {
  if (!globalPool) {
    globalPool = new ContainerPool(config);
    await globalPool.initialize();

    // Register cleanup on process exit
    const cleanup = async () => {
      if (globalPool) {
        await globalPool.shutdown();
        globalPool = null;
      }
    };

    process.on("exit", () => cleanup());
    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(143);
    });
  }

  return globalPool;
}

export async function shutdownGlobalPool(): Promise<void> {
  if (globalPool) {
    await globalPool.shutdown();
    globalPool = null;
  }
}
