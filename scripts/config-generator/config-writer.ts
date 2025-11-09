/**
 * Configuration Writer
 * Handles writing generated configuration files to disk
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Write content to a file, creating parent directories if needed
 * @param filePath - Absolute path to the file
 * @param content - Content to write
 * @throws Error if file cannot be written
 */
export function writeConfigFile(filePath: string, content: string): void {
  try {
    writeFileSync(filePath, content);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write file ${filePath}: ${errorMsg}`, { cause: error });
  }
}

/**
 * Create a directory, including parent directories if needed
 * @param dirPath - Path to the directory
 * @throws Error if directory cannot be created
 */
export function ensureDirectory(dirPath: string): void {
  try {
    mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create directory ${dirPath}: ${errorMsg}`, { cause: error });
  }
}

/**
 * Write a configuration file with automatic directory creation
 * @param dirPath - Directory path (will be created if it doesn't exist)
 * @param fileName - Name of the file
 * @param content - Content to write
 * @returns Full path of the written file
 * @throws Error if file or directory operations fail
 */
export function writeConfigWithDir(dirPath: string, fileName: string, content: string): string {
  ensureDirectory(dirPath);
  const filePath = join(dirPath, fileName);
  writeConfigFile(filePath, content);
  return filePath;
}
