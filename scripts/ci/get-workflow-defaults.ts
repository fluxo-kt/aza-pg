#!/usr/bin/env bun
import { extensionDefaults } from "../extension-defaults";

// Extract semantic version from Debian package version
// Example: "0.8.1-2.pgdg13+1" → "0.8.1"
function extractVersion(debianVersion: string): string {
  const match = debianVersion.match(/^(\d+\.\d+\.\d+)/);
  if (!match || !match[1]) {
    throw new Error(`Could not extract version from: ${debianVersion}`);
  }
  return match[1];
}

const pgvectorVersion = extractVersion(extensionDefaults.pgdgVersions.pgvector);
console.log(pgvectorVersion);
