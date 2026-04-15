import { parallelDownload } from "../src/download";
import { Readable } from "node:stream";
import type { S3BaseConfig } from "../src/s3-client";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockWorkerInstances, mockFsExistsSync } = vi.hoisted(() => ({
  mockWorkerInstances: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    _emit: (event: string, ...args: any[]) => void;
  }>,
  mockFsExistsSync: vi.fn().mockReturnValue(true), // default: bundled worker exists
}));

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { cpus: () => [1, 2, 3, 4] }, // 4 logical CPUs
  cpus: () => [1, 2, 3, 4],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockFsExistsSync,
      createWriteStream: vi.fn(),
      promises: {
        open: vi.fn().mockResolvedValue({
          truncate: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          write: vi.fn().mockResolvedValue({ bytesWritten: 0, buffer: Buffer.alloc(0) }),
        }),
      },
    },
  };
});

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: class MockNodeHttpHandler {
    constructor(_opts?: any) {}
  },
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class MockS3Client {
      send = vi.fn().mockResolvedValue({
        Body: Readable.from(Buffer.from("data")),
      });
      destroy = vi.fn();
    },
  };
});

// Mock Worker so tests never spawn real threads.
// Each constructed Worker is stored in mockWorkerInstances so tests can
// drive its lifecycle by calling _emit().
vi.mock("node:worker_threads", () => ({
  Worker: class MockWorker {
    private handlers: Record<string, ((...args: any[]) => void)[]> = {};

    constructor(_script: string, _opts?: any) {
      const self = this;
      mockWorkerInstances.push({
        on: vi.fn((event: string, cb: (...args: any[]) => void) => {
          self.handlers[event] = self.handlers[event] ?? [];
          self.handlers[event].push(cb);
        }),
        _emit: (event: string, ...args: any[]) => {
          (self.handlers[event] ?? []).forEach((cb) => cb(...args));
        },
      });
    }

    on(event: string, cb: (...args: any[]) => void) {
      const instance = mockWorkerInstances[mockWorkerInstances.length - 1];
      instance.on(event, cb);
      return this;
    }
  },
  workerData: {},
  parentPort: { postMessage: vi.fn() },
}));

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

// Helper: resolve the Worker created at index i and make it emit "done".
function resolveWorker(index: number) {
  // Use setImmediate so the Worker constructor has time to register handlers.
  setImmediate(() => {
    mockWorkerInstances[index]._emit("message", { type: "done" });
  });
}

describe("parallelDownload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkerInstances.length = 0;
    mockFsExistsSync.mockReturnValue(true);
  });

  // -------------------------------------------------------------------------
  // Fallback (unknown file size)
  // -------------------------------------------------------------------------
  describe("when fileSize is unknown", () => {
    it("falls back to single-stream download via pipeline", async () => {
      const writeStreamMock = {
        on: vi.fn(), once: vi.fn(), emit: vi.fn(), write: vi.fn(), end: vi.fn(),
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

  // -------------------------------------------------------------------------
  // Parallel path (known file size)
  // -------------------------------------------------------------------------
  describe("when fileSize is known", () => {
    it("pre-allocates the file before spawning workers", async () => {
      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        write: vi.fn(),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 5,
        chunkSizeMB: 1,
        concurrency: 2,
      });

      // Resolve the single worker that gets spawned.
      resolveWorker(0);
      await downloadPromise;

      expect(vi.mocked(fs.promises.open)).toHaveBeenCalledWith("/out", "w");
      expect(preallocHandle.truncate).toHaveBeenCalledWith(5);
      expect(preallocHandle.close).toHaveBeenCalled();
    });

    it("does not use pipeline (single-stream) when size is known", async () => {
      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      resolveWorker(0);
      await downloadPromise;

      expect(pipeline).not.toHaveBeenCalled();
    });

    it("spawns at most os.cpus().length worker threads", async () => {
      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      // 32 chunks, 8 concurrency, 4 CPUs → 4 workers
      const fileSize = 32 * 1024 * 1024;
      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize,
        chunkSizeMB: 1,
        concurrency: 8,
      });

      // Resolve all workers (up to 4 because os.cpus() returns 4).
      for (let i = 0; i < 4; i++) resolveWorker(i);
      await downloadPromise;

      expect(mockWorkerInstances.length).toBeLessThanOrEqual(4);
    });

    it("accumulates progress reported by workers", async () => {
      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      setImmediate(() => {
        mockWorkerInstances[0]._emit("message", { type: "progress", bytes: 4 });
        mockWorkerInstances[0]._emit("message", { type: "done" });
      });

      // Should not throw
      await expect(downloadPromise).resolves.toBeUndefined();
    });

    it("rejects if a worker emits an error message", async () => {
      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      setImmediate(() => {
        mockWorkerInstances[0]._emit("message", { type: "error", message: "boom" });
      });

      await expect(downloadPromise).rejects.toThrow("boom");
    });

    it("rejects if a worker exits with non-zero code", async () => {
      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      setImmediate(() => {
        mockWorkerInstances[0]._emit("exit", 1);
      });

      await expect(downloadPromise).rejects.toThrow("Worker exited with code 1");
    });

    it("uses the bundled worker path when dist file exists", async () => {
      mockFsExistsSync.mockReturnValue(true);

      const preallocHandle = {
        truncate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(fs.promises.open).mockResolvedValueOnce(preallocHandle as any);

      const downloadPromise = parallelDownload({
        clientConfig: baseConfig,
        bucket: "b",
        key: "k",
        filePath: "/out",
        fileSize: 4,
        chunkSizeMB: 1,
        concurrency: 1,
      });

      resolveWorker(0);
      await downloadPromise;

      // Worker was constructed — path resolution didn't throw.
      expect(mockWorkerInstances.length).toBe(1);
    });
  });
});
