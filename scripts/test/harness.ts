#!/usr/bin/env bun
import { $ } from "bun";

/**
 * Unified Test Harness for aza-pg tests
 * Provides consistent container management, cleanup, and isolation
 */
export class TestHarness {
  private readonly image: string;
  private readonly prefix: string;
  private containers: string[] = [];

  constructor() {
    this.image = Bun.env.POSTGRES_IMAGE || "ghcr.io/fluxo-kt/aza-pg:pg18";
    this.prefix = `test-${Date.now()}-${process.pid}`;

    // Ensure cleanup on exit
    process.on("SIGINT", () => this.cleanupAll());
    process.on("SIGTERM", () => this.cleanupAll());
    process.on("exit", () => this.cleanupAll());
  }

  getImage(): string {
    return this.image;
  }

  getContainerName(suffix: string): string {
    return `${this.prefix}-${suffix}`;
  }

  async startContainer(name: string, env: Record<string, string> = {}): Promise<string> {
    const containerName = this.getContainerName(name);
    this.containers.push(containerName);

    // Build env args
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    await $`docker run -d --name ${containerName} ${envArgs} ${this.image}`.quiet();
    return containerName;
  }

  async waitForReady(containerName: string, timeout = 60): Promise<void> {
    const start = Date.now();
    while ((Date.now() - start) / 1000 < timeout) {
      try {
        const result = await $`docker exec ${containerName} pg_isready -U postgres`
          .quiet()
          .nothrow();
        if (result.exitCode === 0) {
          // Wait additional 5s for extensions to initialize
          await Bun.sleep(5000);
          return;
        }
      } catch {
        // Ignore errors
      }
      await Bun.sleep(2000);
    }
    throw new Error(`Container ${containerName} not ready after ${timeout}s`);
  }

  async cleanup(containerName: string): Promise<void> {
    try {
      await $`docker rm -f ${containerName}`.quiet();
    } catch {
      // Ignore errors
    }
  }

  async cleanupAll(): Promise<void> {
    for (const container of this.containers) {
      await this.cleanup(container);
    }
    this.containers = [];
  }

  async runSQL(containerName: string, sql: string): Promise<string> {
    const result = await $`docker exec ${containerName} psql -U postgres -tAc ${sql}`.text();
    return result.trim();
  }
}
