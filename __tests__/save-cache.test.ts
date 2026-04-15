import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as tar from "@actions/cache/lib/internal/tar";
import { saveCache, isExactKeyMatch, saveMatchedKey } from "../src/save-cache";
import { State } from "../src/state";
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
vi.mock("@actions/cache");
vi.mock("@actions/cache/lib/internal/cacheUtils", () => ({
  getCompressionMethod: vi.fn().mockResolvedValue("zstd"),
  resolvePaths: vi.fn().mockResolvedValue(["/resolved/path"]),
  createTempDirectory: vi.fn().mockResolvedValue("/tmp/cache-dir"),
  getCacheFileName: vi.fn().mockReturnValue("cache.tzst"),
}));
vi.mock("@actions/cache/lib/internal/tar", () => ({
  createTar: vi.fn().mockResolvedValue(undefined),
  listTar: vi.fn().mockResolvedValue(undefined),
}));

const mockUploadDone = vi.fn().mockResolvedValue(undefined);
vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class MockUpload {
    constructor(public config: any) {}
    done = mockUploadDone;
  },
}));

const mockNewS3Client = vi.fn().mockReturnValue({});
vi.mock("../src/s3-client", () => ({
  newS3Client: (...args: any[]) => mockNewS3Client(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      createReadStream: vi.fn().mockReturnValue("mock-read-stream"),
    },
  };
});

describe("save-cache", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    mockNewS3Client.mockReturnValue({});

    // Default inputs
    setInput("bucket", "test-bucket");
    setInput("key", "test-key");
    setInput("path", "src");
    setInput("use-fallback", "false");
    setInput("partSize", "256");
    setInput("endpoint", "s3.amazonaws.com");
    setInput("accessKey", "test-access");
    setInput("secretKey", "test-secret");
    setInput("insecure", "false");
    setInput("port", "");
    setInput("region", "us-east-1");
    setInput("sessionToken", "");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("saveMatchedKey", () => {
    it("saves the matched key to state", () => {
      saveMatchedKey("my-matched-key");
      expect(core.saveState).toHaveBeenCalledWith(
        State.MatchedKey,
        "my-matched-key",
      );
    });
  });

  describe("isExactKeyMatch", () => {
    it("returns true when matched key equals primary key", () => {
      vi.mocked(core.getState).mockImplementation((name: string) => {
        if (name === State.MatchedKey) return "my-key";
        if (name === State.PrimaryKey) return "my-key";
        return "";
      });
      expect(isExactKeyMatch()).toBe(true);
    });

    it("returns false when matched key differs from primary key", () => {
      vi.mocked(core.getState).mockImplementation((name: string) => {
        if (name === State.MatchedKey) return "restore-key-1";
        if (name === State.PrimaryKey) return "my-key";
        return "";
      });
      expect(isExactKeyMatch()).toBe(false);
    });

    it("returns false when matched key is empty", () => {
      vi.mocked(core.getState).mockImplementation((name: string) => {
        if (name === State.MatchedKey) return "";
        if (name === State.PrimaryKey) return "my-key";
        return "";
      });
      expect(isExactKeyMatch()).toBe(false);
    });
  });

  describe("saveCache", () => {
    it("skips save when non-standalone and exact key match", async () => {
      vi.mocked(core.getState).mockImplementation((name: string) => {
        if (name === State.MatchedKey) return "test-key";
        if (name === State.PrimaryKey) return "test-key";
        return "";
      });

      await saveCache(false);
      expect(core.info).toHaveBeenCalledWith(
        "Cache was exact key match, not saving",
      );
      expect(mockUploadDone).not.toHaveBeenCalled();
    });

    it("uploads cache to S3 in standalone mode", async () => {
      await saveCache(true);
      expect(mockUploadDone).toHaveBeenCalled();
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Uploading tar to s3"),
      );
      expect(core.info).toHaveBeenCalledWith("Cache saved to s3 successfully");
    });

    it("uploads cache to S3 in non-standalone mode when no exact match", async () => {
      vi.mocked(core.getState).mockImplementation((name: string) => {
        if (name === State.MatchedKey) return "different-key";
        if (name === State.PrimaryKey) return "test-key";
        if (name === State.AccessKey) return "test-access";
        if (name === State.SecretKey) return "test-secret";
        if (name === State.SessionToken) return "";
        if (name === State.Region) return "us-east-1";
        return "";
      });

      await saveCache(false);
      expect(mockUploadDone).toHaveBeenCalled();
      expect(core.info).toHaveBeenCalledWith("Cache saved to s3 successfully");
    });

    it("uses state values for credentials in non-standalone mode", async () => {
      vi.mocked(core.getState).mockImplementation((name: string) => {
        if (name === State.MatchedKey) return "";
        if (name === State.PrimaryKey) return "state-key";
        if (name === State.AccessKey) return "state-access";
        if (name === State.SecretKey) return "state-secret";
        if (name === State.SessionToken) return "state-token";
        if (name === State.Region) return "state-region";
        return "";
      });

      await saveCache(false);
      expect(mockNewS3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          accessKey: "state-access",
          secretKey: "state-secret",
          sessionToken: "state-token",
          region: "state-region",
        }),
      );
    });

    it("falls back to actions/cache when S3 upload fails and use-fallback is true", async () => {
      setInput("use-fallback", "true");
      mockNewS3Client.mockImplementation(() => {
        throw new Error("S3 connection failed");
      });

      await saveCache(true);
      expect(cache.saveCache).toHaveBeenCalled();
      expect(core.info).toHaveBeenCalledWith("Saving cache using fallback");
    });

    it("does not fall back when S3 fails and use-fallback is false", async () => {
      setInput("use-fallback", "false");
      mockNewS3Client.mockImplementation(() => {
        throw new Error("S3 connection failed");
      });

      await saveCache(true);
      expect(cache.saveCache).not.toHaveBeenCalled();
    });

    it("warns about GHES when fallback is attempted on enterprise", async () => {
      setInput("use-fallback", "true");
      process.env["GITHUB_SERVER_URL"] = "https://github.mycompany.com";
      mockNewS3Client.mockImplementation(() => {
        throw new Error("S3 connection failed");
      });

      await saveCache(true);
      expect(core.warning).toHaveBeenCalledWith(
        "Cache fallback is not supported on Github Enterpise.",
      );
      expect(cache.saveCache).not.toHaveBeenCalled();
    });

    it("creates tar archive before uploading", async () => {
      await saveCache(true);
      expect(tar.createTar).toHaveBeenCalled();
    });
  });
});
