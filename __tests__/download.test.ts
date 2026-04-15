import { parallelDownload } from "../src/download";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { S3BaseConfig } from "../src/s3-client";

// Hoist mocks so they are available inside vi.mock factories (which are hoisted too)
const { mockSend, mockDestroy, s3ClientInstances } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
  s3ClientInstances: { count: 0 },
}));

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      createWriteStream: vi.fn(),
      promises: {
        open: vi.fn(),
      },
    },
  };
});

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

// Mock NodeHttpHandler so we don't make real HTTP connections in tests
vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: class MockNodeHttpHandler {
    constructor(_opts?: any) {}
  },
}));

// Mock S3Client as a class — mockSend/mockDestroy/s3ClientInstances are hoisted so available here
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class MockS3Client {
      constructor(_config?: any) {
        s3ClientInstances.count++;
      }
      send = mockSend;
      destroy = mockDestroy;
    },
  };
});

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

const baseConfig: S3BaseConfig = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
  },
};

function makeFileHandleMock() {
  return {
    write: vi.fn().mockResolvedValue({ bytesWritten: 0, buffer: Buffer.alloc(0) }),
    close: vi.fn().mockResolvedValue(undefined),
    truncate: vi.fn().mockResolvedValue(undefined),
  };
}

describe("parallelDownload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3ClientInstances.count = 0;
    // Default: return a readable body for GetObjectCommand
    mockSend.mockImplementation(async (cmd: any) => {
      if (cmd instanceof GetObjectCommand) {
        return { Body: Readable.from(Buffer.from("chunk-data")) };
      }
      throw new Error("Unexpected command");
    });
  });

  describe("when fileSize is unknown", () => {
    it("falls back to single-stream download via pipeline", async () => {
      const writeStreamMock = {
        on: vi.fn(),
        once: vi.fn(),
        emit: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };
      vi.mocked(fs.createWriteStream).mockReturnValue(writeStreamMock as any);

      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "my-bucket",
        key: "my-key",
        filePath: "/tmp/out.tzst",
        fileSize: undefined,
      });

      expect(pipeline).toHaveBeenCalled();
    });

    it("falls back when fileSize is 0", async () => {
      const writeStreamMock = {
        on: vi.fn(), once: vi.fn(), emit: vi.fn(), write: vi.fn(), end: vi.fn(),
      };
      vi.mocked(fs.createWriteStream).mockReturnValue(writeStreamMock as any);

      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "my-bucket",
        key: "my-key",
        filePath: "/tmp/out.tzst",
        fileSize: 0,
      });

      expect(pipeline).toHaveBeenCalled();
    });
  });

  describe("when fileSize is known", () => {
    it("pre-allocates the file then opens it for writing", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();

      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      mockSend.mockResolvedValue({ Body: Readable.from(Buffer.from("hello")) });

      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "my-bucket",
        key: "my-key",
        filePath: "/tmp/out.tzst",
        fileSize: 5,
        chunkSizeMB: 1,
        concurrency: 2,
      });

      expect(vi.mocked(fs.promises.open)).toHaveBeenNthCalledWith(1, "/tmp/out.tzst", "w");
      expect(preallocHandle.truncate).toHaveBeenCalledWith(5);
      expect(preallocHandle.close).toHaveBeenCalled();
      expect(vi.mocked(fs.promises.open)).toHaveBeenNthCalledWith(2, "/tmp/out.tzst", "r+");
      expect(writeHandle.close).toHaveBeenCalled();
    });

    it("issues a Range header for each chunk", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      mockSend.mockResolvedValue({
        Body: Readable.from(Buffer.from("A".repeat(1024 * 1024))),
      });

      const fileSize = 3 * 1024 * 1024;
      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize,
        chunkSizeMB: 1,
        concurrency: 3,
      });

      const ranges = mockSend.mock.calls.map((c: any) => c[0].input.Range);
      expect(ranges).toContain("bytes=0-1048575");
      expect(ranges).toContain("bytes=1048576-2097151");
      expect(ranges).toContain("bytes=2097152-3145727");
    });

    it("writes chunk data at the correct file offset", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      mockSend.mockResolvedValue({ Body: Readable.from(data) });

      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      expect(writeHandle.write).toHaveBeenCalledWith(
        expect.any(Buffer),
        0,
        4,
        0,
      );
    });

    it("creates one S3Client per worker slot", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      mockSend.mockResolvedValue({ Body: Readable.from(Buffer.from("x")) });

      const fileSize = 4 * 1024 * 1024; // 4 chunks of 1 MB
      const concurrency = 4;
      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize,
        chunkSizeMB: 1,
        concurrency,
      });

      // S3Client constructor should have been called once per worker slot
      expect(s3ClientInstances.count).toBe(concurrency);
    });

    it("destroys all worker clients after download", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      mockSend.mockResolvedValue({ Body: Readable.from(Buffer.from("x")) });

      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      expect(mockDestroy).toHaveBeenCalled();
    });

    it("does not use pipeline (single-stream) when size is known", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      mockSend.mockResolvedValue({ Body: Readable.from(Buffer.from("data")) });

      await parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      expect(pipeline).not.toHaveBeenCalled();
    });
  });
});
