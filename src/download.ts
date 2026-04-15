import * as core from "@actions/core";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3BaseConfig } from "./s3-client";

const PROGRESS_INTERVAL_MS = 5000;

/**
 * Downloads an S3 object in parallel using byte-range requests.
 *
 * Each concurrent worker gets its **own** S3Client instance backed by its own
 * NodeHttpHandler (and therefore its own https.Agent).  This is critical on
 * 10 Gbps networks: a shared Agent means shared TCP congestion-window bookkeeping,
 * so adding more concurrency to a single client does not increase throughput.
 * Separate Agents each establish their own TCP streams with independent cwnd,
 * allowing aggregate bandwidth to scale linearly with concurrency.
 *
 * Falls back to a single-stream download when the object size is unknown.
 */
export async function parallelDownload({
  clientConfig,
  bucket,
  key,
  filePath,
  fileSize,
  chunkSizeMB = 256,
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
    const client = makeWorkerClient(clientConfig);
    try {
      await singleStreamDownload({ client, bucket, key, filePath });
    } finally {
      client.destroy();
    }
    return;
  }

  const chunkSize = chunkSizeMB * 1024 * 1024;
  const chunks = buildChunks(fileSize, chunkSize);
  const workerCount = Math.min(concurrency, chunks.length);

  core.info(
    `Downloading ${chunks.length} chunks (${chunkSizeMB} MB each) with ${workerCount} independent TCP streams`,
  );

  // Pre-allocate the file so concurrent writers don't need to extend it.
  await preallocateFile(filePath, fileSize);

  // Create one S3Client per worker slot — each gets its own NodeHttpHandler
  // and https.Agent, giving it an independent TCP stream / congestion window.
  const workerClients = Array.from({ length: workerCount }, () =>
    makeWorkerClient(clientConfig),
  );

  let bytesDownloaded = 0;
  const progressTimer = setInterval(() => {
    const pct = ((bytesDownloaded / fileSize) * 100).toFixed(1);
    core.info(
      `Download progress: ${formatBytes(bytesDownloaded)} / ${formatBytes(fileSize)} (${pct}%)`,
    );
  }, PROGRESS_INTERVAL_MS);

  try {
    const fd = await fs.promises.open(filePath, "r+");
    try {
      let chunkIndex = 0;
      const inFlight = new Set<Promise<void>>();

      const launchNext = (workerClient: S3Client) => {
        if (chunkIndex >= chunks.length) return;
        const { start, end } = chunks[chunkIndex++];
        const p = downloadChunk({
          client: workerClient,
          bucket,
          key,
          start,
          end,
          fd,
        })
          .then((bytes) => {
            bytesDownloaded += bytes;
          })
          .finally(() => {
            inFlight.delete(p);
            launchNext(workerClient);
          });
        inFlight.add(p);
      };

      // Seed one chunk per worker.
      for (const workerClient of workerClients) {
        launchNext(workerClient);
      }

      // Wait for all in-flight promises to complete.
      while (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    } finally {
      await fd.close();
    }
  } finally {
    clearInterval(progressTimer);
    for (const c of workerClients) {
      c.destroy();
    }
  }

  core.info(`Download complete: ${formatBytes(fileSize)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a dedicated S3Client with its own NodeHttpHandler.
 * Each client maintains its own connection pool (https.Agent), so its TCP
 * streams evolve independently — critical for 10 Gbps throughput.
 */
function makeWorkerClient(baseConfig: S3BaseConfig): S3Client {
  return new S3Client({
    ...baseConfig,
    requestHandler: new NodeHttpHandler({
      // Each worker only ever sends one request at a time, so 1 socket is enough.
      // The OS assigns a distinct TCP 4-tuple per client → independent cwnd.
      connectionTimeout: 10_000,
      requestTimeout: 600_000, // 10 min – accommodate large chunks on slow links
    }),
  });
}

async function downloadChunk({
  client,
  bucket,
  key,
  start,
  end,
  fd,
}: {
  client: S3Client;
  bucket: string;
  key: string;
  start: number;
  end: number;
  fd: fs.promises.FileHandle;
}): Promise<number> {
  const range = `bytes=${start}-${end}`;
  core.debug(`Fetching range ${range}`);

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range,
    }),
  );

  const body = response.Body as Readable;
  let offset = start;

  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await fd.write(buf, 0, buf.byteLength, offset);
    offset += buf.byteLength;
  }

  return offset - start;
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
): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  let start = 0;
  while (start < fileSize) {
    const end = Math.min(start + chunkSize - 1, fileSize - 1);
    chunks.push({ start, end });
    start = end + 1;
  }
  return chunks;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + " KB";
  return bytes + " B";
}
