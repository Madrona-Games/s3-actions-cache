/**
 * Worker-thread entry point for parallel S3 chunk downloads.
 *
 * The main thread spawns N of these workers, each responsible for a disjoint
 * set of byte-range chunks.  Because each worker has its own V8 isolate and
 * event loop, network I/O and buffer processing are spread across CPU cores,
 * allowing aggregate throughput to scale beyond the single-core event-loop
 * ceiling (~1 Gbps on typical hardware).
 *
 * Communication protocol (via MessagePort):
 *   Main → Worker:  WorkerInput  (sent as workerData at startup)
 *   Worker → Main:  { type: "progress", bytes: number }
 *                   { type: "done" }
 *                   { type: "error", message: string }
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import type { S3BaseConfig } from "./s3-client";

export interface ChunkRange {
  start: number;
  end: number;
}

export interface WorkerInput {
  clientConfig: S3BaseConfig;
  bucket: string;
  key: string;
  filePath: string;
  chunks: ChunkRange[];
  concurrency: number;
}

async function run() {
  const { clientConfig, bucket, key, filePath, chunks, concurrency } =
    workerData as WorkerInput;

  const workerCount = Math.min(concurrency, chunks.length);

  // Each in-worker "slot" gets its own S3Client / Agent / TCP stream.
  const clients = Array.from({ length: workerCount }, () =>
    makeClient(clientConfig),
  );

  const fd = await fs.promises.open(filePath, "r+");
  try {
    let chunkIndex = 0;
    const inFlight = new Set<Promise<void>>();

    const launchNext = (client: S3Client) => {
      if (chunkIndex >= chunks.length) return;
      const { start, end } = chunks[chunkIndex++];
      const p = downloadChunk({ client, bucket, key, start, end, fd })
        .then((bytes) => {
          parentPort!.postMessage({ type: "progress", bytes });
        })
        .finally(() => {
          inFlight.delete(p);
          launchNext(client);
        });
      inFlight.add(p);
    };

    for (const client of clients) {
      launchNext(client);
    }

    while (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  } finally {
    await fd.close();
    for (const c of clients) c.destroy();
  }

  parentPort!.postMessage({ type: "done" });
}

function makeClient(baseConfig: S3BaseConfig): S3Client {
  const isHttp = (baseConfig.endpoint as string | undefined)?.startsWith(
    "http://",
  );
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
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${start}-${end}`,
    }),
  );

  const body = response.Body as Readable;

  // Accumulate all stream pieces into one buffer, then do a single write.
  // This avoids thousands of tiny async fd.write() calls at 10 Gbps rates.
  const parts: Buffer[] = [];
  let totalBytes = 0;
  for await (const piece of body) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    parts.push(buf);
    totalBytes += buf.byteLength;
  }

  const combined =
    parts.length === 1 ? parts[0] : Buffer.concat(parts, totalBytes);
  await fd.write(combined, 0, combined.byteLength, start);

  return combined.byteLength;
}

run().catch((err) => {
  parentPort!.postMessage({ type: "error", message: String(err) });
  process.exit(1);
});
