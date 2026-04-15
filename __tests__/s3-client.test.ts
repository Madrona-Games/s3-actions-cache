import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import { findObject, listObjects, newS3Client } from "../src/s3-client";
import { setInput } from "./testUtils";

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return {
    ...actual,
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setFailed: vi.fn(),
    saveState: vi.fn(),
    getState: vi.fn().mockReturnValue(""),
    setOutput: vi.fn(),
    isDebug: vi.fn().mockReturnValue(false),
  };
});
const s3ClientConstructorSpy = vi.fn();
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class MockS3Client {
      constructor(config: any) {
        s3ClientConstructorSpy(config);
      }
      send = vi.fn();
    },
  };
});

describe("s3-client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("newS3Client", () => {
    beforeEach(() => {
      setInput("endpoint", "s3.amazonaws.com");
      setInput("accessKey", "test-access-key");
      setInput("secretKey", "test-secret-key");
    });

    it("creates client with default https when insecure is not set", () => {
      setInput("insecure", "false");
      setInput("port", "");
      newS3Client();
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "https://s3.amazonaws.com",
          forcePathStyle: true,
        }),
      );
    });

    it("creates client with http when insecure is true", () => {
      setInput("insecure", "true");
      setInput("port", "");
      newS3Client();
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "http://s3.amazonaws.com",
        }),
      );
    });

    it("includes port in endpoint when provided", () => {
      setInput("insecure", "false");
      setInput("port", "9000");
      newS3Client();
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "https://s3.amazonaws.com:9000",
        }),
      );
    });

    it("uses explicit credentials when provided", () => {
      setInput("insecure", "false");
      setInput("port", "");
      newS3Client({
        accessKey: "explicit-access",
        secretKey: "explicit-secret",
        sessionToken: "explicit-token",
        region: "eu-west-1",
      });
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "eu-west-1",
          credentials: {
            accessKeyId: "explicit-access",
            secretAccessKey: "explicit-secret",
            sessionToken: "explicit-token",
          },
        }),
      );
    });

    it("uses env var for region when not explicitly provided", () => {
      setInput("insecure", "false");
      setInput("port", "");
      setInput("region", "");
      process.env["AWS_REGION"] = "ap-southeast-1";
      newS3Client();
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "ap-southeast-1",
        }),
      );
    });

    it("defaults region to us-east-1 when nothing is set", () => {
      setInput("insecure", "false");
      setInput("port", "");
      setInput("region", "");
      delete process.env["AWS_REGION"];
      newS3Client();
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "us-east-1",
        }),
      );
    });

    it("uses env vars for credentials when not explicitly provided", () => {
      setInput("insecure", "false");
      setInput("port", "");
      setInput("accessKey", "");
      setInput("secretKey", "");
      process.env["AWS_ACCESS_KEY_ID"] = "env-access";
      process.env["AWS_SECRET_ACCESS_KEY"] = "env-secret";
      process.env["AWS_SESSION_TOKEN"] = "env-token";
      newS3Client();
      expect(s3ClientConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: {
            accessKeyId: "env-access",
            secretAccessKey: "env-secret",
            sessionToken: "env-token",
          },
        }),
      );
    });
  });

  describe("listObjects", () => {
    it("returns objects from a single page", async () => {
      const mockObjects = [
        { Key: "prefix/file1.tar.zst", LastModified: new Date(), Size: 100 },
        { Key: "prefix/file2.tar.zst", LastModified: new Date(), Size: 200 },
      ];
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          Contents: mockObjects,
          IsTruncated: false,
        }),
      } as unknown as S3Client;

      const result = await listObjects(mockClient, "test-bucket", "prefix/");
      expect(result).toEqual(mockObjects);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it("handles pagination with continuation token", async () => {
      const page1Objects = [{ Key: "prefix/file1.tar.zst", Size: 100 }];
      const page2Objects = [{ Key: "prefix/file2.tar.zst", Size: 200 }];
      const mockClient = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            Contents: page1Objects,
            IsTruncated: true,
            NextContinuationToken: "token123",
          })
          .mockResolvedValueOnce({
            Contents: page2Objects,
            IsTruncated: false,
          }),
      } as unknown as S3Client;

      const result = await listObjects(mockClient, "test-bucket", "prefix/");
      expect(result).toEqual([...page1Objects, ...page2Objects]);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it("returns empty array when no contents", async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          IsTruncated: false,
        }),
      } as unknown as S3Client;

      const result = await listObjects(mockClient, "test-bucket", "prefix/");
      expect(result).toEqual([]);
    });
  });

  describe("findObject", () => {
    const compressionMethod = CompressionMethod.Zstd;

    it("returns exact match when found", async () => {
      const exactObj = {
        Key: "my-key/cache.tzst",
        LastModified: new Date(),
        Size: 500,
      };
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          Contents: [exactObj],
          IsTruncated: false,
        }),
      } as unknown as S3Client;

      const result = await findObject(
        mockClient,
        "test-bucket",
        "my-key",
        ["restore-1"],
        compressionMethod,
      );
      expect(result).toEqual({ item: exactObj, matchingKey: "my-key" });
    });

    it("falls back to restore keys when no exact match", async () => {
      const restoreObj = {
        Key: "restore-1/cache.tzst",
        LastModified: new Date("2024-01-02"),
        Size: 300,
      };
      const mockClient = {
        send: vi
          .fn()
          // exact match returns empty
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
          // restore key search returns result
          .mockResolvedValueOnce({
            Contents: [restoreObj],
            IsTruncated: false,
          }),
      } as unknown as S3Client;

      const result = await findObject(
        mockClient,
        "test-bucket",
        "my-key",
        ["restore-1"],
        compressionMethod,
      );
      expect(result).toEqual({ item: restoreObj, matchingKey: "restore-1" });
    });

    it("returns latest object when multiple matches for restore key", async () => {
      const olderObj = {
        Key: "restore-1/cache.tzst",
        LastModified: new Date("2024-01-01"),
        Size: 200,
      };
      const newerObj = {
        Key: "restore-1/v2/cache.tzst",
        LastModified: new Date("2024-06-01"),
        Size: 400,
      };
      const mockClient = {
        send: vi
          .fn()
          // exact match returns empty
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
          // restore key search returns multiple results
          .mockResolvedValueOnce({
            Contents: [olderObj, newerObj],
            IsTruncated: false,
          }),
      } as unknown as S3Client;

      const result = await findObject(
        mockClient,
        "test-bucket",
        "my-key",
        ["restore-1"],
        compressionMethod,
      );
      expect(result.item).toEqual(newerObj);
    });

    it("tries multiple restore keys in order", async () => {
      const restoreObj = {
        Key: "restore-2/cache.tzst",
        LastModified: new Date(),
        Size: 100,
      };
      const mockClient = {
        send: vi
          .fn()
          // exact match empty
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
          // first restore key empty
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
          // second restore key has result
          .mockResolvedValueOnce({
            Contents: [restoreObj],
            IsTruncated: false,
          }),
      } as unknown as S3Client;

      const result = await findObject(
        mockClient,
        "test-bucket",
        "my-key",
        ["restore-1", "restore-2"],
        compressionMethod,
      );
      expect(result).toEqual({ item: restoreObj, matchingKey: "restore-2" });
    });

    it("throws error when no match found", async () => {
      const mockClient = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false }),
      } as unknown as S3Client;

      await expect(
        findObject(
          mockClient,
          "test-bucket",
          "my-key",
          ["restore-1"],
          compressionMethod,
        ),
      ).rejects.toThrow("Cache item not found");
    });

    it("throws error when no restore keys and no exact match", async () => {
      const mockClient = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false }),
      } as unknown as S3Client;

      await expect(
        findObject(mockClient, "test-bucket", "my-key", [], compressionMethod),
      ).rejects.toThrow("Cache item not found");
    });

    it("filters restore key results by cache file name", async () => {
      const matchingObj = {
        Key: "restore-1/cache.tzst",
        LastModified: new Date(),
        Size: 300,
      };
      const nonMatchingObj = {
        Key: "restore-1/other-file.txt",
        LastModified: new Date(),
        Size: 100,
      };
      const mockClient = {
        send: vi
          .fn()
          .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
          .mockResolvedValueOnce({
            Contents: [matchingObj, nonMatchingObj],
            IsTruncated: false,
          }),
      } as unknown as S3Client;

      const result = await findObject(
        mockClient,
        "test-bucket",
        "my-key",
        ["restore-1"],
        compressionMethod,
      );
      expect(result.item).toEqual(matchingObj);
    });
  });
});
