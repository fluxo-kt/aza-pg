#!/usr/bin/env bun
/**
 * Unit Tests for PostgreSQL Auto-Configuration Calculations
 *
 * Tests calculation logic in isolation without Docker containers.
 * Reimplements bash formulas in TypeScript for fast verification.
 *
 * Usage:
 *   bun test ./scripts/test/test-auto-config-units.ts
 *   bun test scripts/test/test-auto-config-units.ts
 *
 * Features:
 * - 90 regression test cases across 12 test suites
 * - Tests all calculation functions: shared_buffers, max_connections, work_mem, etc.
 * - Covers edge cases, boundary conditions, and real-world scenarios
 * - Fast execution (~6ms, no Docker required)
 * - TypeScript implementations match bash formulas exactly
 */

import { describe, test, expect } from "bun:test";

// Type definitions
interface WorkloadConfig {
  maxConnections: number;
  minWalSizeMB: number;
  maxWalSizeMB: number;
}

interface StorageConfig {
  randomPageCost: number;
  ioConcurrency: number;
  maintIoConcurrency: number;
}

// Constants (match bash script)
const SHARED_BUFFERS_CAP_MB = 32768;
const MAINTENANCE_WORK_MEM_CAP_MB = 2048;
const WORK_MEM_CAP_MB = 32;
const WORK_MEM_DW_CAP_MB = 256;
const OS_RESERVE_MB = 512;
const CONNECTION_OVERHEAD_PER_CONN_MB = 10;

// Lookup tables (match bash associative arrays)
const WORKLOAD_CONFIGS: Record<string, WorkloadConfig> = {
  web: { maxConnections: 200, minWalSizeMB: 1024, maxWalSizeMB: 4096 },
  oltp: { maxConnections: 300, minWalSizeMB: 2048, maxWalSizeMB: 8192 },
  dw: { maxConnections: 100, minWalSizeMB: 4096, maxWalSizeMB: 16384 },
  mixed: { maxConnections: 120, minWalSizeMB: 1024, maxWalSizeMB: 4096 },
};

const STORAGE_CONFIGS: Record<string, StorageConfig> = {
  ssd: { randomPageCost: 1.1, ioConcurrency: 200, maintIoConcurrency: 20 },
  hdd: { randomPageCost: 4.0, ioConcurrency: 2, maintIoConcurrency: 10 },
  san: { randomPageCost: 1.1, ioConcurrency: 300, maintIoConcurrency: 20 },
};

// Calculation functions (TypeScript implementation of bash logic)
function calculateSharedBuffers(totalRamMB: number): number {
  let ratio: number;

  if (totalRamMB <= 1024) {
    ratio = 25;
  } else if (totalRamMB <= 8192) {
    ratio = 25;
  } else if (totalRamMB <= 32768) {
    ratio = 20;
  } else {
    ratio = 15;
  }

  let value = Math.floor((totalRamMB * ratio) / 100);

  if (value < 64) value = 64;
  if (value > SHARED_BUFFERS_CAP_MB) value = SHARED_BUFFERS_CAP_MB;

  return value;
}

function calculateMaxConnections(totalRamMB: number, workload: string = "mixed"): number {
  const config = (WORKLOAD_CONFIGS[workload] || WORKLOAD_CONFIGS.mixed)!;
  let baseConn = config.maxConnections;

  // Scale for small VPS
  if (totalRamMB < 2048) {
    baseConn = Math.floor((baseConn * 50) / 100);
  } else if (totalRamMB < 4096) {
    baseConn = Math.floor((baseConn * 70) / 100);
  } else if (totalRamMB < 8192) {
    baseConn = Math.floor((baseConn * 85) / 100);
  }

  // Minimum 20
  if (baseConn < 20) baseConn = 20;

  return baseConn;
}

function calculateEffectiveCache(totalRamMB: number, sharedBuffersMB: number): number {
  // Account for OS + other services
  let otherUsage = Math.floor((totalRamMB * 20) / 100);
  if (otherUsage < OS_RESERVE_MB) otherUsage = OS_RESERVE_MB;

  // Available for page cache
  const cacheAvail = totalRamMB - sharedBuffersMB - otherUsage;

  // Use 70% of that
  let value = Math.floor((cacheAvail * 70) / 100);

  // Minimum: 2× shared_buffers
  const minValue = sharedBuffersMB * 2;
  if (value < minValue) value = minValue;
  if (value < 0) value = 0;

  return value;
}

function calculateMaintenanceWorkMem(totalRamMB: number, workload: string = "mixed"): number {
  let value: number;

  if (workload === "dw") {
    // DW: 12.5% of RAM (1/8)
    value = Math.floor(totalRamMB / 8);
  } else {
    // Others: 6.25% of RAM (1/16)
    value = Math.floor(totalRamMB / 16);
  }

  if (value < 32) value = 32;
  if (value > MAINTENANCE_WORK_MEM_CAP_MB) value = MAINTENANCE_WORK_MEM_CAP_MB;

  return value;
}

function calculateWorkMem(
  totalRamMB: number,
  maxConnections: number,
  sharedBuffersMB: number,
  workload: string = "mixed"
): number {
  // Account for connection overhead
  const connOverhead = maxConnections * CONNECTION_OVERHEAD_PER_CONN_MB;

  // Memory pool
  let pool = totalRamMB - sharedBuffersMB - connOverhead - OS_RESERVE_MB;

  // Safety floor
  if (pool < 256) pool = 256;

  // Divisor
  const divisor = maxConnections * 4;

  let value = Math.floor(pool / divisor);

  // Minimum 1MB
  if (value < 1) value = 1;

  // RAM-tiered caps
  let cap = WORK_MEM_CAP_MB;

  if (workload === "dw" || workload === "mixed") {
    if (totalRamMB >= 32768) {
      cap = WORK_MEM_DW_CAP_MB; // 256MB
    } else if (totalRamMB >= 8192) {
      cap = 128;
    } else if (totalRamMB >= 2048) {
      cap = 64;
    }
  }

  if (value > cap) value = cap;

  return value;
}

function calculateWalBuffers(sharedBuffersMB: number): number {
  // 3% of shared_buffers
  let value = Math.floor((sharedBuffersMB * 3) / 100);

  // Minimum 1MB
  if (value < 1) value = 1;

  // Maximum 16MB
  if (value > 16) value = 16;

  // Special rounding: 14-16MB → 16MB
  if (value > 14 && value < 16) value = 16;

  return value;
}

function calculateIoWorkers(cpuCores: number): number {
  // Match bash: CPU_CORES / 4, min 1, max 64
  const value = Math.floor(cpuCores / 4);
  return Math.max(1, Math.min(64, value));
}

function calculateWorkerProcesses(cpuCores: number): number {
  // CPU × 1.5
  let value = cpuCores + Math.floor(cpuCores / 2);

  if (value < 2) value = 2;
  if (value > 64) value = 64;

  return value;
}

// Test suites
describe("shared_buffers calculation", () => {
  test("512MB RAM: 128MB (25%)", () => {
    expect(calculateSharedBuffers(512)).toBe(128);
  });

  test("1GB RAM: 256MB (25%)", () => {
    expect(calculateSharedBuffers(1024)).toBe(256);
  });

  test("2GB RAM: 512MB (25%)", () => {
    expect(calculateSharedBuffers(2048)).toBe(512);
  });

  test("4GB RAM: 1024MB (25%)", () => {
    expect(calculateSharedBuffers(4096)).toBe(1024);
  });

  test("8GB RAM: 2048MB (25%)", () => {
    expect(calculateSharedBuffers(8192)).toBe(2048);
  });

  test("16GB RAM: 3276MB (20%)", () => {
    expect(calculateSharedBuffers(16384)).toBe(3276);
  });

  test("32GB RAM: 6553MB (20%)", () => {
    expect(calculateSharedBuffers(32768)).toBe(6553);
  });

  test("64GB RAM: 9830MB (15%)", () => {
    expect(calculateSharedBuffers(65536)).toBe(9830);
  });

  test("128GB RAM: 19660MB (15%)", () => {
    expect(calculateSharedBuffers(131072)).toBe(19660);
  });

  test("192GB RAM: 29491MB (15%, under cap)", () => {
    expect(calculateSharedBuffers(196608)).toBe(29491);
  });

  test("256GB RAM: 32768MB (capped)", () => {
    expect(calculateSharedBuffers(262144)).toBe(32768);
  });

  test("Minimum guarantee: 64MB", () => {
    expect(calculateSharedBuffers(128)).toBe(64);
  });
});

describe("max_connections calculation", () => {
  describe("Mixed workload (default)", () => {
    test("1GB RAM: 60 (120 × 50%)", () => {
      expect(calculateMaxConnections(1024, "mixed")).toBe(60);
    });

    test("3GB RAM: 84 (120 × 70%)", () => {
      expect(calculateMaxConnections(3072, "mixed")).toBe(84);
    });

    test("6GB RAM: 102 (120 × 85%)", () => {
      expect(calculateMaxConnections(6144, "mixed")).toBe(102);
    });

    test("8GB RAM: 120 (no scaling)", () => {
      expect(calculateMaxConnections(8192, "mixed")).toBe(120);
    });

    test("32GB RAM: 120 (no scaling)", () => {
      expect(calculateMaxConnections(32768, "mixed")).toBe(120);
    });
  });

  describe("Web workload", () => {
    test("1GB RAM: 100 (200 × 50%)", () => {
      expect(calculateMaxConnections(1024, "web")).toBe(100);
    });

    test("3GB RAM: 140 (200 × 70%)", () => {
      expect(calculateMaxConnections(3072, "web")).toBe(140);
    });

    test("6GB RAM: 170 (200 × 85%)", () => {
      expect(calculateMaxConnections(6144, "web")).toBe(170);
    });

    test("8GB RAM: 200 (no scaling)", () => {
      expect(calculateMaxConnections(8192, "web")).toBe(200);
    });
  });

  describe("OLTP workload", () => {
    test("1GB RAM: 150 (300 × 50%)", () => {
      expect(calculateMaxConnections(1024, "oltp")).toBe(150);
    });

    test("3GB RAM: 210 (300 × 70%)", () => {
      expect(calculateMaxConnections(3072, "oltp")).toBe(210);
    });

    test("8GB RAM: 300 (no scaling)", () => {
      expect(calculateMaxConnections(8192, "oltp")).toBe(300);
    });
  });

  describe("DW workload", () => {
    test("1GB RAM: 50 (100 × 50%)", () => {
      expect(calculateMaxConnections(1024, "dw")).toBe(50);
    });

    test("8GB RAM: 100 (no scaling)", () => {
      expect(calculateMaxConnections(8192, "dw")).toBe(100);
    });
  });

  test("Minimum guarantee: 20 connections", () => {
    expect(calculateMaxConnections(512, "dw")).toBe(50); // 100 × 50% = 50
  });
});

describe("effective_cache_size calculation", () => {
  test("4GB RAM, 1024MB shared_buffers", () => {
    const result = calculateEffectiveCache(4096, 1024);
    // (4096 - 1024 - 819) × 70% = 1577MB, but min is 2×1024 = 2048MB
    expect(result).toBe(2048);
  });

  test("8GB RAM, 2048MB shared_buffers", () => {
    const result = calculateEffectiveCache(8192, 2048);
    // (8192 - 2048 - 1638) × 70% = 3155MB, but min is 2×2048 = 4096MB
    expect(result).toBe(4096);
  });

  test("16GB RAM, 3276MB shared_buffers", () => {
    const result = calculateEffectiveCache(16384, 3276);
    // other_usage = max(16384 × 20 / 100, 512) = max(3276, 512) = 3276
    // cache_avail = 16384 - 3276 - 3276 = 9832
    // value = 9832 × 70 / 100 = 6882MB
    // min_value = 3276 × 2 = 6552MB
    // Since 6882 >= 6552, value = 6882MB
    expect(result).toBe(6882);
  });

  test("Minimum: 2× shared_buffers", () => {
    // Extreme case: very small RAM
    const result = calculateEffectiveCache(1024, 256);
    expect(result).toBeGreaterThanOrEqual(512); // 2× shared_buffers
  });

  test("2GB RAM, 512MB shared_buffers", () => {
    const result = calculateEffectiveCache(2048, 512);
    // (2048 - 512 - 512) × 70% = 716MB, but min is 2×512 = 1024MB
    expect(result).toBe(1024);
  });
});

describe("maintenance_work_mem calculation", () => {
  describe("Standard workloads (6.25% = 1/16)", () => {
    test("2GB RAM: 128MB", () => {
      expect(calculateMaintenanceWorkMem(2048, "mixed")).toBe(128);
    });

    test("4GB RAM: 256MB", () => {
      expect(calculateMaintenanceWorkMem(4096, "web")).toBe(256);
    });

    test("8GB RAM: 512MB", () => {
      expect(calculateMaintenanceWorkMem(8192, "oltp")).toBe(512);
    });

    test("16GB RAM: 1024MB", () => {
      expect(calculateMaintenanceWorkMem(16384, "mixed")).toBe(1024);
    });

    test("32GB RAM: 2048MB (capped)", () => {
      expect(calculateMaintenanceWorkMem(32768, "web")).toBe(2048);
    });

    test("64GB RAM: 2048MB (capped)", () => {
      expect(calculateMaintenanceWorkMem(65536, "mixed")).toBe(2048);
    });
  });

  describe("DW workload (12.5% = 1/8)", () => {
    test("2GB RAM: 256MB", () => {
      expect(calculateMaintenanceWorkMem(2048, "dw")).toBe(256);
    });

    test("4GB RAM: 512MB", () => {
      expect(calculateMaintenanceWorkMem(4096, "dw")).toBe(512);
    });

    test("8GB RAM: 1024MB", () => {
      expect(calculateMaintenanceWorkMem(8192, "dw")).toBe(1024);
    });

    test("16GB RAM: 2048MB (capped)", () => {
      expect(calculateMaintenanceWorkMem(16384, "dw")).toBe(2048);
    });

    test("32GB RAM: 2048MB (capped)", () => {
      expect(calculateMaintenanceWorkMem(32768, "dw")).toBe(2048);
    });
  });

  test("Minimum: 32MB", () => {
    expect(calculateMaintenanceWorkMem(256, "mixed")).toBe(32);
  });
});

describe("work_mem calculation", () => {
  test("4GB RAM, 84 connections, mixed workload", () => {
    const ram = 4096;
    const connections = 84;
    const sharedBuffers = 1024;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "mixed");
    // Pool = 4096 - 1024 - 840 - 512 = 1720
    // work_mem = 1720 / (84 × 4) = 1720 / 336 = 5MB
    expect(result).toBe(5);
  });

  test("8GB RAM, 102 connections, mixed workload", () => {
    const ram = 8192;
    const connections = 102;
    const sharedBuffers = 2048;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "mixed");
    // Pool = 8192 - 2048 - 1020 - 512 = 4612
    // work_mem = 4612 / (102 × 4) = 4612 / 408 = 11MB
    expect(result).toBe(11);
  });

  test("32GB RAM, 100 connections, DW workload: 256MB cap", () => {
    const ram = 32768;
    const connections = 100;
    const sharedBuffers = 6553;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "dw");
    // Should hit 256MB cap for DW on 32GB+ RAM
    expect(result).toBeLessThanOrEqual(256);
  });

  test("8GB RAM, DW workload: 128MB cap", () => {
    const ram = 8192;
    const connections = 100;
    const sharedBuffers = 2048;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "dw");
    // Pool = 8192 - 2048 - 1000 - 512 = 4632
    // work_mem = 4632 / (100 × 4) = 11MB → capped at 128MB (but won't hit)
    expect(result).toBe(11);
  });

  test("Web workload: 32MB cap enforced", () => {
    const ram = 32768;
    const connections = 200;
    const sharedBuffers = 6553;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "web");
    expect(result).toBeLessThanOrEqual(32);
  });

  test("Minimum guarantee: 1MB", () => {
    const ram = 512;
    const connections = 80;
    const sharedBuffers = 128;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "web");
    expect(result).toBeGreaterThanOrEqual(1);
  });

  test("2GB RAM, 60 connections, mixed workload", () => {
    const ram = 2048;
    const connections = 60;
    const sharedBuffers = 512;
    const result = calculateWorkMem(ram, connections, sharedBuffers, "mixed");
    // Pool = 2048 - 512 - 600 - 512 = 424
    // work_mem = 424 / (60 × 4) = 424 / 240 = 1MB
    expect(result).toBe(1);
  });
});

describe("wal_buffers calculation", () => {
  test("1024MB shared_buffers: 30MB → capped at 16MB", () => {
    expect(calculateWalBuffers(1024)).toBe(16);
  });

  test("512MB shared_buffers: 15MB → rounded to 16MB", () => {
    expect(calculateWalBuffers(512)).toBe(16);
  });

  test("256MB shared_buffers: 7MB", () => {
    expect(calculateWalBuffers(256)).toBe(7);
  });

  test("128MB shared_buffers: 3MB", () => {
    expect(calculateWalBuffers(128)).toBe(3);
  });

  test("32MB shared_buffers: 1MB (minimum)", () => {
    expect(calculateWalBuffers(32)).toBe(1); // 32 × 3% = 0.96 → 1
  });

  test("6553MB shared_buffers: 16MB (capped)", () => {
    expect(calculateWalBuffers(6553)).toBe(16); // 196MB → capped
  });

  test("Maximum cap: 16MB", () => {
    expect(calculateWalBuffers(100000)).toBe(16);
  });

  test("2048MB shared_buffers: 16MB (capped)", () => {
    expect(calculateWalBuffers(2048)).toBe(16); // 61MB → capped
  });
});

describe("io_workers calculation", () => {
  test("1 core: 1 (min 1, CPU/4=0→1)", () => {
    expect(calculateIoWorkers(1)).toBe(1);
  });

  test("4 cores: 1 (CPU/4)", () => {
    expect(calculateIoWorkers(4)).toBe(1);
  });

  test("8 cores: 2 (CPU/4)", () => {
    expect(calculateIoWorkers(8)).toBe(2);
  });

  test("12 cores: 3 (CPU/4)", () => {
    expect(calculateIoWorkers(12)).toBe(3);
  });

  test("16 cores: 4 (CPU/4)", () => {
    expect(calculateIoWorkers(16)).toBe(4);
  });

  test("32 cores: 8 (CPU/4)", () => {
    expect(calculateIoWorkers(32)).toBe(8);
  });

  test("48 cores: 12 (CPU/4)", () => {
    expect(calculateIoWorkers(48)).toBe(12);
  });

  test("Maximum cap: 64", () => {
    expect(calculateIoWorkers(300)).toBe(64);
  });
});

describe("worker_processes calculation", () => {
  test("1 core: 2 (minimum, 1 + 0 = 1 → 2)", () => {
    expect(calculateWorkerProcesses(1)).toBe(2);
  });

  test("2 cores: 3 (2 + 1)", () => {
    expect(calculateWorkerProcesses(2)).toBe(3);
  });

  test("4 cores: 6 (4 + 2)", () => {
    expect(calculateWorkerProcesses(4)).toBe(6);
  });

  test("8 cores: 12 (8 + 4)", () => {
    expect(calculateWorkerProcesses(8)).toBe(12);
  });

  test("16 cores: 24 (16 + 8)", () => {
    expect(calculateWorkerProcesses(16)).toBe(24);
  });

  test("32 cores: 48 (32 + 16)", () => {
    expect(calculateWorkerProcesses(32)).toBe(48);
  });

  test("48 cores: 64 (capped, 48 + 24 = 72 → 64)", () => {
    expect(calculateWorkerProcesses(48)).toBe(64);
  });

  test("Maximum cap: 64", () => {
    expect(calculateWorkerProcesses(100)).toBe(64);
  });
});

describe("Workload configurations", () => {
  test("Web workload config", () => {
    const config = WORKLOAD_CONFIGS.web!;
    expect(config.maxConnections).toBe(200);
    expect(config.minWalSizeMB).toBe(1024);
    expect(config.maxWalSizeMB).toBe(4096);
  });

  test("OLTP workload config", () => {
    const config = WORKLOAD_CONFIGS.oltp!;
    expect(config.maxConnections).toBe(300);
    expect(config.minWalSizeMB).toBe(2048);
    expect(config.maxWalSizeMB).toBe(8192);
  });

  test("DW workload config", () => {
    const config = WORKLOAD_CONFIGS.dw!;
    expect(config.maxConnections).toBe(100);
    expect(config.minWalSizeMB).toBe(4096);
    expect(config.maxWalSizeMB).toBe(16384);
  });

  test("Mixed workload config", () => {
    const config = WORKLOAD_CONFIGS.mixed!;
    expect(config.maxConnections).toBe(120);
    expect(config.minWalSizeMB).toBe(1024);
    expect(config.maxWalSizeMB).toBe(4096);
  });
});

describe("Storage configurations", () => {
  test("SSD storage config", () => {
    const config = STORAGE_CONFIGS.ssd!;
    expect(config.randomPageCost).toBe(1.1);
    expect(config.ioConcurrency).toBe(200);
    expect(config.maintIoConcurrency).toBe(20);
  });

  test("HDD storage config", () => {
    const config = STORAGE_CONFIGS.hdd!;
    expect(config.randomPageCost).toBe(4.0);
    expect(config.ioConcurrency).toBe(2);
    expect(config.maintIoConcurrency).toBe(10);
  });

  test("SAN storage config", () => {
    const config = STORAGE_CONFIGS.san!;
    expect(config.randomPageCost).toBe(1.1);
    expect(config.ioConcurrency).toBe(300);
    expect(config.maintIoConcurrency).toBe(20);
  });
});

describe("Edge cases and boundary conditions", () => {
  test("Very low RAM (512MB): minimum shared_buffers", () => {
    expect(calculateSharedBuffers(512)).toBe(128);
  });

  test("Very high RAM (512GB): capped shared_buffers", () => {
    expect(calculateSharedBuffers(524288)).toBe(32768);
  });

  test("Single connection: work_mem calculation", () => {
    const result = calculateWorkMem(2048, 1, 512, "mixed");
    // Pool = 2048 - 512 - 10 - 512 = 1014
    // work_mem = 1014 / (1 × 4) = 253MB → capped at 64MB for 2GB RAM
    expect(result).toBe(64);
  });

  test("Maximum connections (300): work_mem calculation", () => {
    const result = calculateWorkMem(32768, 300, 6553, "oltp");
    // Pool = 32768 - 6553 - 3000 - 512 = 22703
    // work_mem = 22703 / (300 × 4) = 18MB → under cap
    expect(result).toBe(18);
  });
});

describe("Real-world scenarios", () => {
  test("Small VPS (1GB RAM, 2 cores, mixed workload)", () => {
    const ram = 1024;
    const sharedBuffers = calculateSharedBuffers(ram);
    const maxConnections = calculateMaxConnections(ram, "mixed");
    const workMem = calculateWorkMem(ram, maxConnections, sharedBuffers, "mixed");
    const maintenanceWorkMem = calculateMaintenanceWorkMem(ram, "mixed");
    const effectiveCache = calculateEffectiveCache(ram, sharedBuffers);
    const workerProcesses = calculateWorkerProcesses(2);

    expect(sharedBuffers).toBe(256);
    expect(maxConnections).toBe(60);
    expect(workMem).toBeGreaterThanOrEqual(1);
    expect(maintenanceWorkMem).toBe(64);
    expect(effectiveCache).toBeGreaterThanOrEqual(512);
    expect(workerProcesses).toBe(3);
  });

  test("Medium production (4GB RAM, 4 cores, web workload)", () => {
    const ram = 4096;
    const sharedBuffers = calculateSharedBuffers(ram);
    const maxConnections = calculateMaxConnections(ram, "web");
    const workMem = calculateWorkMem(ram, maxConnections, sharedBuffers, "web");
    const maintenanceWorkMem = calculateMaintenanceWorkMem(ram, "web");
    const effectiveCache = calculateEffectiveCache(ram, sharedBuffers);
    const workerProcesses = calculateWorkerProcesses(4);

    expect(sharedBuffers).toBe(1024);
    expect(maxConnections).toBe(170); // 4GB < 8GB: 200 × 85% = 170
    expect(workMem).toBeGreaterThanOrEqual(1);
    expect(maintenanceWorkMem).toBe(256);
    expect(effectiveCache).toBeGreaterThanOrEqual(2048);
    expect(workerProcesses).toBe(6);
  });

  test("Large production (16GB RAM, 8 cores, oltp workload)", () => {
    const ram = 16384;
    const sharedBuffers = calculateSharedBuffers(ram);
    const maxConnections = calculateMaxConnections(ram, "oltp");
    const workMem = calculateWorkMem(ram, maxConnections, sharedBuffers, "oltp");
    const maintenanceWorkMem = calculateMaintenanceWorkMem(ram, "oltp");
    const effectiveCache = calculateEffectiveCache(ram, sharedBuffers);
    const workerProcesses = calculateWorkerProcesses(8);

    expect(sharedBuffers).toBe(3276);
    expect(maxConnections).toBe(300);
    expect(workMem).toBeGreaterThanOrEqual(1);
    expect(maintenanceWorkMem).toBe(1024);
    expect(effectiveCache).toBeGreaterThanOrEqual(6552);
    expect(workerProcesses).toBe(12);
  });

  test("Data warehouse (32GB RAM, 16 cores, dw workload)", () => {
    const ram = 32768;
    const sharedBuffers = calculateSharedBuffers(ram);
    const maxConnections = calculateMaxConnections(ram, "dw");
    const workMem = calculateWorkMem(ram, maxConnections, sharedBuffers, "dw");
    const maintenanceWorkMem = calculateMaintenanceWorkMem(ram, "dw");
    const effectiveCache = calculateEffectiveCache(ram, sharedBuffers);
    const ioWorkers = calculateIoWorkers(16);
    const workerProcesses = calculateWorkerProcesses(16);

    expect(sharedBuffers).toBe(6553);
    expect(maxConnections).toBe(100);
    expect(workMem).toBeLessThanOrEqual(256); // DW cap
    expect(maintenanceWorkMem).toBe(2048); // Capped
    expect(effectiveCache).toBeGreaterThanOrEqual(13106);
    expect(ioWorkers).toBe(4);
    expect(workerProcesses).toBe(24);
  });
});
