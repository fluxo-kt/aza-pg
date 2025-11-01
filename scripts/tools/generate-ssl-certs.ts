#!/usr/bin/env bun
/**
 * Generate self-signed SSL certificates for PostgreSQL
 * For production, replace with real certificates from a CA
 *
 * Usage:
 *   bun run scripts/tools/generate-ssl-certs.ts <cert-directory> [days-valid]
 *   Example: bun run scripts/tools/generate-ssl-certs.ts stacks/primary/certs 3650
 */

import { $ } from "bun";
import { info, success, error, warning } from "../utils/logger.ts";

interface CertConfig {
  certDir: string;
  daysValid: number;
  hostname: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): CertConfig | null {
  const certDir = Bun.argv[2];
  const daysValidArg = Bun.argv[3];

  if (!certDir) {
    console.log("Usage: generate-ssl-certs.ts <cert-directory> [days-valid]");
    console.log("Example: generate-ssl-certs.ts stacks/primary/certs 3650");
    console.log("");
    console.log("Generates self-signed certificates for PostgreSQL TLS/SSL.");
    console.log("Default validity: 3650 days (10 years)");
    return null;
  }

  const daysValid = daysValidArg ? parseInt(daysValidArg, 10) : 3650;

  if (isNaN(daysValid) || daysValid <= 0) {
    error(`Invalid days-valid value: ${daysValidArg} (must be a positive integer)`);
    return null;
  }

  const hostname = Bun.env.POSTGRES_HOSTNAME || "postgres.local";

  return {
    certDir,
    daysValid,
    hostname,
  };
}

/**
 * Check if certificates already exist
 */
async function certificatesExist(certDir: string): Promise<boolean> {
  const keyFile = Bun.file(`${certDir}/server.key`);
  const certFile = Bun.file(`${certDir}/server.crt`);

  const [keyExists, certExists] = await Promise.all([keyFile.exists(), certFile.exists()]);

  return keyExists || certExists;
}

/**
 * Prompt user for confirmation
 */
async function promptConfirmation(message: string): Promise<boolean> {
  process.stdout.write(`${message} (y/N) `);

  // Read a single character from stdin
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();

  reader.releaseLock();

  if (!value || value.length === 0) {
    return false;
  }

  const response = String.fromCharCode(value[0]!).toLowerCase();
  console.log(""); // Print newline

  return response === "y";
}

/**
 * Remove existing certificate files
 */
async function removeExistingCerts(certDir: string): Promise<void> {
  try {
    await $`rm -f ${certDir}/server.key ${certDir}/server.crt ${certDir}/ca.crt`.quiet();
  } catch {
    // Ignore errors if files don't exist
  }
}

/**
 * Generate SSL certificates using OpenSSL
 */
async function generateCertificates(config: CertConfig): Promise<void> {
  const { certDir, daysValid, hostname } = config;

  info("Generating private key...");

  try {
    await $`openssl req -new -x509 -days ${daysValid.toString()} -nodes -text -out ${certDir}/server.crt -keyout ${certDir}/server.key -subj /CN=${hostname}/O=PostgreSQL/C=US`;
  } catch (err) {
    error("Failed to generate certificates");
    throw err;
  }

  // Verify that the key file was created
  const keyFile = Bun.file(`${certDir}/server.key`);
  if (!(await keyFile.exists())) {
    error("Failed to generate certificates");
    throw new Error("Certificate key file not created");
  }
}

/**
 * Set proper file permissions
 */
async function setPermissions(certDir: string): Promise<void> {
  await $`chmod 600 ${certDir}/server.key`;
  await $`chmod 644 ${certDir}/server.crt`;
}

/**
 * Copy certificate as CA certificate
 */
async function createCACert(certDir: string): Promise<void> {
  await $`cp ${certDir}/server.crt ${certDir}/ca.crt`;
}

/**
 * Print success message with next steps
 */
function printSuccess(certDir: string): void {
  success("Certificates generated successfully!");
  console.log("");
  console.log("Files created:");
  console.log(`  - ${certDir}/server.key  (private key, 600 permissions)`);
  console.log(`  - ${certDir}/server.crt  (certificate)`);
  console.log(`  - ${certDir}/ca.crt      (CA certificate, copy of server.crt)`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Uncomment SSL lines in postgresql.conf");
  console.log("  2. Mount certs in compose.yml volumes section");
  console.log("  3. Restart PostgreSQL stack");
  console.log("");
  console.log("For production, replace these self-signed certificates with real ones from a CA.");
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const config = parseArgs();

  if (!config) {
    process.exit(1);
  }

  const { certDir, daysValid } = config;

  info(`Generating certificates in: ${certDir}`);
  info(`Validity period: ${daysValid} days`);

  // Create certificate directory
  await $`mkdir -p ${certDir}`;

  // Check if certificates already exist
  if (await certificatesExist(certDir)) {
    warning(`Certificates already exist in ${certDir}`);
    const shouldOverwrite = await promptConfirmation("Overwrite existing certificates?");

    if (!shouldOverwrite) {
      info("Aborted");
      process.exit(0);
    }

    await removeExistingCerts(certDir);
  }

  // Generate certificates
  await generateCertificates(config);

  // Set file permissions
  await setPermissions(certDir);

  // Create CA certificate (copy of server cert)
  await createCACert(certDir);

  // Print success message
  printSuccess(certDir);
}

// Run main function
try {
  await main();
} catch (err) {
  if (err instanceof Error) {
    error(err.message);
  } else {
    error("Unknown error occurred");
  }
  process.exit(1);
}
