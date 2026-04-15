import * as core from "@actions/core";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import type { ChunkRange, WorkerInput } from "./download-worker";
import { S3BaseConfig } from "./s3-client";

const PROGRESS_INTERVAL_MS = 5000;

/**
 * Downloads an S3 object in parallel using byte-range requests distributed
 * across multiple worker threads.
 *
 * WHY WORKER THREADS:
 * Node.js has a single-threaded event loop.  Even with many concurrent HTTP
 * requests, all network I/O callbacks, buffer copies, and SDK middleware run
 * on ONE core.  On a 10 Gbps local link this saturates that core at ~1 Gbps.
 *
 * By spawning N worker threads (one per CPU core) each with its own V8 isolate
 * and event loop, all network processing runs in parallel across cores, allowing
 * aggregate throughput to scale linearly toward line rate.
 *
 * Each worker owns `concurrency / threadCount` S3 clients (each with an
 * independent http(s).Agent and TCP stream), ensuring full connection isolation.
 *
 * Falls back to a single-stream download when the object size is unknown.
 */
export async function parallelDownload({
  clientConfig,
  bucket,
  key,
  filePath,
  fileSize,
  chunkSizeMB = 64,
  concurrency = 16,
}: {
  clientConfig: S3BaseConfig;
  bucket: string;
  key: string;
  filePath: string;
  fileSize: number | undefined;
  chunkSizeMB?: number;
  concurrency?: number;
}): Promise<void> {
  // If size is unknown we can't do range requests — fall back to streaming.
  if (!fileSize || fileSize <= 0) {
    core.debug("Object size unknown, falling back to single-stream download");
    const client = makeClient(clientConfig);
    try {
      await singleStreamDownload({ client, bucket, key, filePath });
    } finally {
      client.destroy();
    }
    return;
  }

  const chunkSize = chunkSizeMB * 1024 * 1024;
  const allChunks = buildChunks(fileSize, chunkSize);

  // Number of worker threads: one per logical CPU, but no more than the
  // number of chunks (no point spawning idle workers).
  const threadCount = Math.min(os.cpus().length, allChunks.length, concurrency);

  // Streams per worker: divide concurrency evenly, giving at least 1.
  const streamsPerWorker = Math.max(1, Math.floor(concurrency / threadCount));

  core.info(
    `Downloading ${allChunks.length} chunks (${chunkSizeMB} MB each) across ` +
      `${threadCount} worker threads × ${streamsPerWorker} streams each`,
  );

  // Pre-allocate the file so all workers can write at arbitrary offsets.
  await preallocateFile(filePath, fileSize);

  // Divide chunks evenly across workers.
  const workerChunks = partition(allChunks, threadCount);

  let bytesDownloaded = 0;
  const progressTimer = setInterval(() => {
    const pct = ((bytesDownloaded / fileSize) * 100).toFixed(1);
    core.info(
      `Download progress: ${formatBytes(bytesDownloaded)} / ${formatBytes(fileSize)} (${pct}%)`,
    );
  }, PROGRESS_INTERVAL_MS);

  try {
    await Promise.all(
      workerChunks.map((chunks) =>
        runWorker({
          clientConfig,
          bucket,
          key,
          filePath,
          chunks,
          concurrency: streamsPerWorker,
          onProgress: (bytes) => {
            bytesDownloaded += bytes;
          },
        }),
      ),
    );
  } finally {
    clearInterval(progressTimer);
  }

  core.info(`Download complete: ${formatBytes(fileSize)}`);
}

// ---------------------------------------------------------------------------
// Worker management
// ---------------------------------------------------------------------------

/**
 * Resolves the path to the bundled download-worker script.
 *
 * In production (esbuild bundle) the worker is emitted alongside this file as
 * `../download-worker/index.js`.  In tests (ts-node / vitest) the TypeScript
 * source is used directly.
 */
function resolveWorkerPath(): string {
  // __filename in CJS bundle is the bundle's absolute path.
  // Walk up one directory (dist/restore/ → dist/) then into download-worker/.
  const distWorker = path.resolve(
    path.dirname(__filename),
    "..",
    "download-worker",
    "index.js",
  );
  if (fs.existsSync(distWorker)) return distWorker;

  // Development / test: resolve TypeScript source relative to this file.
  return path.resolve(__dirname, "download-worker.ts");
}

function runWorker({
  clientConfig,
  bucket,
  key,
  filePath,
  chunks,
  concurrency,
  onProgress,
}: WorkerInput & { onProgress: (bytes: number) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerInput: WorkerInput = {
      clientConfig,
      bucket,
      key,
      filePath,
      chunks,
      concurrency,
    };

    const worker = new Worker(resolveWorkerPath(), {
      workerData: workerInput,
      // Allow ts-node / tsx to execute TypeScript worker sources in dev/test.
      execArgv: resolveWorkerPath().endsWith(".ts")
        ? ["--require", "ts-node/register"]
        : [],
    });

    worker.on("message", (msg: { type: string; bytes?: number; message?: string }) => {
      if (msg.type === "progress" && msg.bytes !== undefined) {
        onProgress(msg.bytes);
      } else if (msg.type === "done") {
        resolve();
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers shared with fallback / single-stream path
// ---------------------------------------------------------------------------

function makeClient(baseConfig: S3BaseConfig): S3Client {
  const isHttp = (baseConfig.endpoint as string | undefined)?.startsWith("http://");
  const AgentClass = isHttp ? http.Agent : https.Agent;
  const agent = new AgentClass({ keepAlive: true, maxSockets: 1 });

  return new S3Client({
    ...baseConfig,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 10_000,
      requestTimeout: 600_000,
      ...(isHttp ? { httpAgent: agent } : { httpsAgent: agent }),
    }),
  });
}

async function singleStreamDownload({
  client,
  bucket,
  key,
  filePath,
}: {
  client: S3Client;
  bucket: string;
  key: string;
  filePath: string;
}): Promise<void> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const writeStream = fs.createWriteStream(filePath);
  await pipeline(response.Body as Readable, writeStream);
}

async function preallocateFile(filePath: string, size: number): Promise<void> {
  const fd = await fs.promises.open(filePath, "w");
  try {
    await fd.truncate(size);
  } finally {
    await fd.close();
  }
}

function buildChunks(
  fileSize: number,
  chunkSize: number,
): ChunkRange[] {
  const chunks: ChunkRange[] = [];
  let start = 0;
  while (start < fileSize) {
    const end = Math.min(start + chunkSize - 1, fileSize - 1);
    chunks.push({ start, end });
    start = end + 1;
  }
  return chunks;
}

/** Splits `items` into `n` roughly-equal sub-arrays (round-robin). */
function partition<T>(items: T[], n: number): T[][] {
  const buckets: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => buckets[i % n].push(item));
  return buckets.filter((b) => b.length > 0);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + " KB";
  return bytes + " B";
}
