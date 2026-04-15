declare module "@actions/cache/lib/internal/constants" {
  export enum CompressionMethod {
    Gzip = "gzip",
    ZstdWithoutLong = "zstd-without-long",
    Zstd = "zstd",
  }
}

declare module "@actions/cache/lib/internal/cacheUtils" {
  import { CompressionMethod } from "@actions/cache/lib/internal/constants";
  export function createTempDirectory(): Promise<string>;
  export function resolvePaths(patterns: string[]): Promise<string[]>;
  export function getCompressionMethod(): Promise<CompressionMethod>;
  export function getCacheFileName(
    compressionMethod: CompressionMethod,
  ): string;
}

declare module "@actions/cache/lib/internal/tar" {
  import { CompressionMethod } from "@actions/cache/lib/internal/constants";
  export function listTar(
    archivePath: string,
    compressionMethod: CompressionMethod,
  ): Promise<void>;
  export function extractTar(
    archivePath: string,
    compressionMethod: CompressionMethod,
  ): Promise<void>;
  export function createTar(
    archiveFolder: string,
    sourceDirectories: string[],
    compressionMethod: CompressionMethod,
  ): Promise<void>;
}
