import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findObject, listObjects } from "../../src/s3-client";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import { setInput } from "../testUtils";

/**
 * Integration tests against a real S3-compatible service (RustFS).
 *
 * Prerequisites:
 *   docker compose up -d
 *   Wait for RustFS to be healthy on port 9000
 */

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const TEST_BUCKET = "integration-test-cache";
const TEST_REGION = "us-east-1";

function createTestClient(): S3Client {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: TEST_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: "rustfsadmin",
      secretAccessKey: "rustfsadmin",
    },
  });
}

async function emptyBucket(client: S3Client, bucket: string) {
  try {
    const listResponse = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    if (listResponse.Contents) {
      for (const obj of listResponse.Contents) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key! }),
        );
      }
    }
  } catch {
    // Bucket may not exist, that's fine
  }
}

async function deleteBucketIfExists(client: S3Client, bucket: string) {
  try {
    await emptyBucket(client, bucket);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch {
    // Bucket may not exist
  }
}

describe("S3 Integration Tests", () => {
  let client: S3Client;

  beforeAll(async () => {
    client = createTestClient();

    // Clean up and create bucket
    await deleteBucketIfExists(client, TEST_BUCKET);
    await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  });

  afterAll(async () => {
    await deleteBucketIfExists(client, TEST_BUCKET);
    client.destroy();
  });

  afterEach(async () => {
    // Clean objects between tests but keep bucket
    await emptyBucket(client, TEST_BUCKET);
  });

  describe("basic S3 operations", () => {
    it("can put and get an object", async () => {
      const key = "test-basic/hello.txt";
      const body = "Hello, RustFS!";

      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: key,
          Body: body,
        }),
      );

      const response = await client.send(
        new GetObjectCommand({
          Bucket: TEST_BUCKET,
          Key: key,
        }),
      );

      const bodyStr = await response.Body!.transformToString();
      expect(bodyStr).toBe(body);
    });

    it("can upload using @aws-sdk/lib-storage Upload", async () => {
      const key = "test-upload/large-file.bin";
      const content = Buffer.alloc(1024 * 1024, "x"); // 1MB of 'x'

      const upload = new Upload({
        client,
        params: {
          Bucket: TEST_BUCKET,
          Key: key,
          Body: Readable.from(content),
        },
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      });

      await upload.done();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: TEST_BUCKET,
          Key: key,
        }),
      );

      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const downloaded = Buffer.concat(chunks);
      expect(downloaded.length).toBe(content.length);
      expect(downloaded.equals(content)).toBe(true);
    });
  });

  describe("listObjects", () => {
    it("lists objects with a prefix", async () => {
      // Upload several objects
      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: "prefix-a/file1.txt",
          Body: "file1",
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: "prefix-a/file2.txt",
          Body: "file2",
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: "prefix-b/file3.txt",
          Body: "file3",
        }),
      );

      const results = await listObjects(client, TEST_BUCKET, "prefix-a/");
      expect(results.length).toBe(2);
      expect(results.map((r) => r.Key).sort()).toEqual([
        "prefix-a/file1.txt",
        "prefix-a/file2.txt",
      ]);
    });

    it("returns empty array for non-existent prefix", async () => {
      const results = await listObjects(
        client,
        TEST_BUCKET,
        "nonexistent-prefix/",
      );
      expect(results).toEqual([]);
    });
  });

  describe("findObject", () => {
    it("finds exact match by key", async () => {
      const key = "exact-key";
      const objectKey = `${key}/cache.tzst`;
      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: objectKey,
          Body: "cache-content",
        }),
      );

      const result = await findObject(
        client,
        TEST_BUCKET,
        key,
        [],
        CompressionMethod.Zstd,
      );

      expect(result.matchingKey).toBe(key);
      expect(result.item.Key).toBe(objectKey);
    });

    it("falls back to restore key when exact match not found", async () => {
      const restoreKey = "restore-prefix";
      const objectKey = `${restoreKey}-v2/cache.tzst`;
      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: objectKey,
          Body: "cached-data",
        }),
      );

      const result = await findObject(
        client,
        TEST_BUCKET,
        "nonexistent-exact-key",
        [restoreKey],
        CompressionMethod.Zstd,
      );

      expect(result.matchingKey).toBe(restoreKey);
      expect(result.item.Key).toBe(objectKey);
    });

    it("returns most recent object when multiple restore key matches", async () => {
      // Upload two objects with the same prefix, different timestamps
      // We'll upload them sequentially - second one should be newer
      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: "restore-multi/v1/cache.tzst",
          Body: "old-data",
        }),
      );

      // Small delay to ensure different LastModified
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: "restore-multi/v2/cache.tzst",
          Body: "new-data",
        }),
      );

      const result = await findObject(
        client,
        TEST_BUCKET,
        "no-exact-match",
        ["restore-multi"],
        CompressionMethod.Zstd,
      );

      expect(result.matchingKey).toBe("restore-multi");
      expect(result.item.Key).toBe("restore-multi/v2/cache.tzst");
    });

    it("throws when no object found anywhere", async () => {
      await expect(
        findObject(
          client,
          TEST_BUCKET,
          "totally-missing",
          ["also-missing"],
          CompressionMethod.Zstd,
        ),
      ).rejects.toThrow("Cache item not found");
    });
  });

  describe("save and restore roundtrip", () => {
    it("can upload a file and download it back identically", async () => {
      // Create a temp file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-test-"));
      const sourceFile = path.join(tmpDir, "test-data.bin");
      const downloadFile = path.join(tmpDir, "downloaded.bin");

      try {
        // Write random-ish content
        const content = Buffer.from(
          "This is test content for the roundtrip integration test.\n".repeat(
            100,
          ),
        );
        fs.writeFileSync(sourceFile, content);

        // Upload
        const key = "roundtrip-test/data.bin";
        const fileStream = fs.createReadStream(sourceFile);
        const upload = new Upload({
          client,
          params: {
            Bucket: TEST_BUCKET,
            Key: key,
            Body: fileStream,
          },
          partSize: 5 * 1024 * 1024,
          leavePartsOnError: false,
        });
        await upload.done();

        // Download
        const response = await client.send(
          new GetObjectCommand({
            Bucket: TEST_BUCKET,
            Key: key,
          }),
        );

        const writeStream = fs.createWriteStream(downloadFile);
        await pipeline(response.Body as Readable, writeStream);

        // Verify
        const downloaded = fs.readFileSync(downloadFile);
        expect(downloaded.equals(content)).toBe(true);
        expect(downloaded.length).toBe(content.length);
      } finally {
        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("can upload multiple files and list them all", async () => {
      const prefix = "multi-file-test";
      const files = ["a.txt", "b.txt", "c.txt"];

      for (const file of files) {
        await client.send(
          new PutObjectCommand({
            Bucket: TEST_BUCKET,
            Key: `${prefix}/${file}`,
            Body: `content of ${file}`,
          }),
        );
      }

      const objects = await listObjects(client, TEST_BUCKET, `${prefix}/`);
      expect(objects.length).toBe(3);

      const keys = objects.map((o) => o.Key).sort();
      expect(keys).toEqual([
        `${prefix}/a.txt`,
        `${prefix}/b.txt`,
        `${prefix}/c.txt`,
      ]);

      // Verify each file's content
      for (const file of files) {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: TEST_BUCKET,
            Key: `${prefix}/${file}`,
          }),
        );
        const body = await response.Body!.transformToString();
        expect(body).toBe(`content of ${file}`);
      }
    });
  });
});
