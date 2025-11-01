/**
 * Docker Image Metrics - Shared utilities for extracting image size and layer information
 *
 * Provides functions to query Docker for image metrics without code duplication.
 * Used by both validation scripts and release tooling.
 */

import { $ } from "bun";
import { getErrorMessage } from "../utils/errors";

/**
 * Docker image metadata from `docker image inspect`
 */
export interface ImageData {
  Id: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Created: string;
  Size: number;
  Architecture: string;
  Os: string;
  Config: {
    ExposedPorts?: Record<string, object>;
    User?: string;
    WorkingDir?: string;
    Entrypoint?: string[];
    Cmd?: string[];
    Labels?: Record<string, string>;
  };
  RootFS?: {
    Type: string;
    Layers: string[];
  };
}

/**
 * Base image information from OCI labels
 */
export interface BaseImageInfo {
  name: string; // e.g., "postgres:18.1-trixie"
  digest: string; // e.g., "sha256:abc..."
}

/**
 * Complete image metrics
 */
export interface ImageMetrics {
  compressedBytes: number;
  uncompressedBytes: number;
  layerCount: number;
  compressedFormatted: string;
  uncompressedFormatted: string;
  baseImage: BaseImageInfo | null;
}

/**
 * Format bytes as human-readable size (MB or GB)
 */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  } else {
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
}

/**
 * Inspect Docker image and return metadata
 */
export async function inspectImage(imageTag: string): Promise<ImageData | null> {
  try {
    const result = await $`docker image inspect ${imageTag}`.nothrow().json();

    if (!result || !Array.isArray(result) || result.length === 0) {
      return null;
    }

    return result[0] as ImageData;
  } catch (err) {
    throw new Error(`Failed to inspect image: ${getErrorMessage(err)}`);
  }
}

/**
 * Get uncompressed image size from image data
 */
export function getUncompressedSize(imageData: ImageData): number {
  return imageData.Size;
}

/**
 * Get layer count from image data
 */
export function getLayerCount(imageData: ImageData): number {
  const layers = imageData.RootFS?.Layers || [];
  return layers.length;
}

/**
 * Get base image information from OCI labels
 */
export function getBaseImageInfo(imageData: ImageData): BaseImageInfo | null {
  const labels = imageData.Config.Labels || {};

  const baseName = labels["org.opencontainers.image.base.name"];
  const baseDigest = labels["org.opencontainers.image.base.digest"];

  if (!baseName || !baseDigest) {
    return null;
  }

  return {
    name: baseName,
    digest: baseDigest,
  };
}

/**
 * Calculate compressed (wire) size from manifest
 * Handles both single-arch and multi-arch manifests
 */
export async function getCompressedSize(
  imageTag: string,
  imageData: ImageData
): Promise<number | null> {
  try {
    // Get the digest from the inspected image data
    const digest = imageData.RepoDigests?.[0]?.split("@")[1];

    if (!digest) {
      return null; // Local image without digest
    }

    // Extract repository from image tag
    const repo = imageTag.includes("/") ? imageTag.split(":")[0] : imageTag;
    const manifestUrl = `${repo}@${digest}`;

    // Get manifest to calculate compressed size
    const manifestResult = await $`docker manifest inspect ${manifestUrl}`.nothrow().json();

    if (!manifestResult || typeof manifestResult !== "object") {
      return null;
    }

    // Check if this is a manifest index (multi-arch)
    const manifest = manifestResult as any;
    if (manifest.manifests && Array.isArray(manifest.manifests)) {
      // Multi-arch image - find the current platform's manifest
      const platformArch = imageData.Architecture;
      const platformManifest = manifest.manifests.find(
        (m: any) => m.platform?.architecture === platformArch
      );

      if (!platformManifest) {
        return null; // Platform not found
      }

      // Fetch platform-specific manifest
      const platformResult = await $`docker manifest inspect ${repo}@${platformManifest.digest}`
        .nothrow()
        .json();

      if (!platformResult || typeof platformResult !== "object") {
        return null;
      }

      const platformData = platformResult as any;
      const configSize = platformData.config?.size || 0;
      const layersSize = (platformData.layers || []).reduce(
        (sum: number, layer: any) => sum + (layer.size || 0),
        0
      );
      return configSize + layersSize;
    }

    // Single-arch manifest
    const configSize = manifest.config?.size || 0;
    const layersSize = (manifest.layers || []).reduce(
      (sum: number, layer: any) => sum + (layer.size || 0),
      0
    );
    return configSize + layersSize;
  } catch (err) {
    throw new Error(`Failed to calculate compressed size: ${getErrorMessage(err)}`);
  }
}

/**
 * Get all image metrics in one call
 */
export async function getImageMetrics(imageTag: string): Promise<ImageMetrics> {
  // Inspect image
  const imageData = await inspectImage(imageTag);
  if (!imageData) {
    throw new Error(`Image not found: ${imageTag}`);
  }

  // Extract metrics
  const uncompressedBytes = getUncompressedSize(imageData);
  const layerCount = getLayerCount(imageData);
  const compressedBytes = (await getCompressedSize(imageTag, imageData)) || 0;
  const baseImage = getBaseImageInfo(imageData);

  return {
    compressedBytes,
    uncompressedBytes,
    layerCount,
    compressedFormatted: formatSize(compressedBytes),
    uncompressedFormatted: formatSize(uncompressedBytes),
    baseImage,
  };
}
