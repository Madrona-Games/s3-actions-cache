import { parallelDownload } from "../src/download";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
}));

// We need to spy on fs.promises so we can control open/truncate/write/close
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

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

function makeFileHandleMock() {
  return {
    write: vi.fn().mockResolvedValue({ bytesWritten: 0, buffer: Buffer.alloc(0) }),
    close: vi.fn().mockResolvedValue(undefined),
    truncate: vi.fn().mockResolvedValue(undefined),
  };
}

function makeS3ClientMock(bodyData: Buffer = Buffer.from("chunk-data")) {
  const send = vi.fn().mockImplementation(async (cmd: any) => {
    if (cmd instanceof GetObjectCommand) {
      return { Body: Readable.from(bodyData) };
    }
    throw new Error("Unexpected command");
  });
  return { send } as unknown as S3Client;
}

describe("parallelDownload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when fileSize is unknown", () => {
    it("falls back to single-stream download via pipeline", async () => {
      const client = makeS3ClientMock();
      const writeStreamMock = {
        on: vi.fn(),
        once: vi.fn(),
        emit: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };
      vi.mocked(fs.createWriteStream).mockReturnValue(writeStreamMock as any);

      await parallelDownload({
        client,
        bucket: "my-bucket",
        key: "my-key",
        filePath: "/tmp/out.tzst",
        fileSize: undefined,
      });

      expect(pipeline).toHaveBeenCalled();
    });

    it("falls back when fileSize is 0", async () => {
      const client = makeS3ClientMock();
      const writeStreamMock = { on: vi.fn(), once: vi.fn(), emit: vi.fn(), write: vi.fn(), end: vi.fn() };
      vi.mocked(fs.createWriteStream).mockReturnValue(writeStreamMock as any);

      await parallelDownload({
        client,
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

      // First open() call = prealloc (write mode), second = parallel writes (r+ mode)
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      const client = makeS3ClientMock(Buffer.from("hello"));

      await parallelDownload({
        client,
        bucket: "my-bucket",
        key: "my-key",
        filePath: "/tmp/out.tzst",
        fileSize: 5,
        chunkSizeMB: 1,
        concurrency: 2,
      });

      // Pre-alloc: opened with "w" then truncated to fileSize
      expect(vi.mocked(fs.promises.open)).toHaveBeenNthCalledWith(1, "/tmp/out.tzst", "w");
      expect(preallocHandle.truncate).toHaveBeenCalledWith(5);
      expect(preallocHandle.close).toHaveBeenCalled();

      // Parallel write: opened with "r+"
      expect(vi.mocked(fs.promises.open)).toHaveBeenNthCalledWith(2, "/tmp/out.tzst", "r+");
      expect(writeHandle.close).toHaveBeenCalled();
    });

    it("issues a Range header for each chunk", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      const client = makeS3ClientMock(Buffer.from("A".repeat(1024 * 1024)));

      const fileSize = 3 * 1024 * 1024; // 3 MB → 3 chunks of 1 MB
      await parallelDownload({
        client,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize,
        chunkSizeMB: 1,
        concurrency: 3,
      });

      const calls = vi.mocked(client.send).mock.calls;
      const ranges = calls.map((c: any) => (c[0] as any).input.Range);

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

      // Single 4-byte chunk so we can check the write offset precisely
      const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const client = makeS3ClientMock(data);

      await parallelDownload({
        client,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      // The write should start at offset 0 for the only chunk
      expect(writeHandle.write).toHaveBeenCalledWith(
        expect.any(Buffer),
        0,
        4,
        0,
      );
    });

    it("respects the concurrency limit", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const client = {
        send: vi.fn().mockImplementation(async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          // Yield to allow other promises to start
          await new Promise((r) => setTimeout(r, 10));
          currentConcurrent--;
          return { Body: Readable.from(Buffer.from("x")) };
        }),
      } as unknown as S3Client;

      const fileSize = 10 * 1024 * 1024; // 10 chunks of 1 MB
      await parallelDownload({
        client,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize,
        chunkSizeMB: 1,
        concurrency: 4,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(4);
      expect(maxConcurrent).toBeGreaterThan(1); // actually ran in parallel
    });

    it("does not use pipeline (single-stream) when size is known", async () => {
      const preallocHandle = makeFileHandleMock();
      const writeHandle = makeFileHandleMock();
      vi.mocked(fs.promises.open)
        .mockResolvedValueOnce(preallocHandle as any)
        .mockResolvedValueOnce(writeHandle as any);

      const client = makeS3ClientMock(Buffer.from("data"));

      await parallelDownload({
        client,
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
