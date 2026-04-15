import * as core from "@actions/core";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PROGRESS_INTERVAL_MS = 5000;

/**
 * Downloads an S3 object in parallel using byte-range requests, writing each
 * chunk directly to its correct offset in the output file.  This saturates
 * high-bandwidth networks (10 Gbps+) that a single TCP stream cannot fully
 * utilise due to congestion-window limits.
 *
 * Falls back to a single-stream download when the object size is unknown.
 */
export async function parallelDownload({
  client,
  bucket,
  key,
  filePath,
  fileSize,
  chunkSizeMB = 256,
  concurrency = 16,
}: {
  client: S3Client;
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
    await singleStreamDownload({ client, bucket, key, filePath });
    return;
  }

  const chunkSize = chunkSizeMB * 1024 * 1024;
  const chunks = buildChunks(fileSize, chunkSize);

  core.info(
    `Downloading ${chunks.length} chunks of ${chunkSizeMB} MB each with concurrency ${concurrency}`,
  );

  // Pre-allocate the file so concurrent writers don't need to extend it.
  await preallocateFile(filePath, fileSize);

  let bytesDownloaded = 0;
  const progressTimer = setInterval(() => {
    const pct = ((bytesDownloaded / fileSize) * 100).toFixed(1);
    core.info(
      `Download progress: ${formatBytes(bytesDownloaded)} / ${formatBytes(fileSize)} (${pct}%)`,
    );
  }, PROGRESS_INTERVAL_MS);

  try {
    // Process chunks in a sliding window of `concurrency` parallel requests.
    const fd = await fs.promises.open(filePath, "r+");
    try {
      let chunkIndex = 0;
      const inFlight = new Set<Promise<void>>();

      const launchNext = () => {
        if (chunkIndex >= chunks.length) return;
        const { start, end } = chunks[chunkIndex++];
        const p = downloadChunk({ client, bucket, key, start, end, fd })
          .then((bytes) => {
            bytesDownloaded += bytes;
          })
          .finally(() => {
            inFlight.delete(p);
            launchNext();
          });
        inFlight.add(p);
      };

      // Seed the initial batch.
      for (let i = 0; i < concurrency && i < chunks.length; i++) {
        launchNext();
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
  }

  core.info(`Download complete: ${formatBytes(fileSize)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
