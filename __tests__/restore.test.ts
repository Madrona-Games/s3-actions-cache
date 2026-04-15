import { setInput } from "./testUtils";

describe("restore", () => {
  const originalEnv = process.env;

  function setupInputs() {
    setInput("bucket", "test-bucket");
    setInput("key", "test-key");
    setInput("path", "src");
    setInput("restore-keys", "");
    setInput("use-fallback", "false");
    setInput("endpoint", "s3.amazonaws.com");
    setInput("accessKey", "test-access");
    setInput("secretKey", "test-secret");
    setInput("insecure", "false");
    setInput("port", "");
    setInput("region", "us-east-1");
    setInput("sessionToken", "");
    setInput("partSize", "256");
    setInput("downloadConcurrency", "16");
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    setupInputs();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createCoreMock() {
    return {
      getInput: vi.fn().mockImplementation((name: string) => {
        return (
          process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || ""
        );
      }),
      saveState: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      setFailed: vi.fn(),
      setOutput: vi.fn(),
      isDebug: vi.fn().mockReturnValue(false),
    };
  }

  function createBaseMocks(overrides: {
    findObjectResult?: any;
    findObjectError?: Error;
    sendResult?: any;
    coreMock?: ReturnType<typeof createCoreMock>;
    restoreCacheMock?: ReturnType<typeof vi.fn>;
    parallelDownloadMock?: ReturnType<typeof vi.fn>;
  } = {}) {
    const coreMock = overrides.coreMock ?? createCoreMock();
    const mockSend = vi.fn().mockResolvedValue(overrides.sendResult ?? {});
    const findObjectMock = overrides.findObjectError
      ? vi.fn().mockRejectedValue(overrides.findObjectError)
      : vi.fn().mockResolvedValue(
          overrides.findObjectResult ?? {
            item: {
              Key: "test-key/cache.tzst",
              LastModified: new Date(),
              Size: 1024,
            },
            matchingKey: "test-key",
          },
        );
    const saveMatchedKeyMock = vi.fn();
    const restoreCacheMock = overrides.restoreCacheMock ?? vi.fn();
    const parallelDownloadMock =
      overrides.parallelDownloadMock ??
      vi.fn().mockResolvedValue(undefined);

    vi.doMock("@actions/core", () => coreMock);
    vi.doMock("@actions/cache", () => ({
      restoreCache: restoreCacheMock,
    }));
    vi.doMock("@actions/cache/lib/internal/cacheUtils", () => ({
      getCompressionMethod: vi.fn().mockResolvedValue("zstd"),
      getCacheFileName: vi.fn().mockReturnValue("cache.tzst"),
      createTempDirectory: vi.fn().mockResolvedValue("/tmp/cache-dir"),
    }));
    vi.doMock("@actions/cache/lib/internal/tar", () => ({
      extractTar: vi.fn().mockResolvedValue(undefined),
      listTar: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../src/s3-client", () => ({
      newS3Client: vi.fn().mockReturnValue({ send: mockSend }),
      newS3ClientConfig: vi.fn().mockReturnValue({
        endpoint: "https://s3.amazonaws.com",
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
      }),
      findObject: findObjectMock,
    }));
    vi.doMock("../src/save-cache", () => ({
      saveMatchedKey: saveMatchedKeyMock,
    }));
    vi.doMock("../src/download", () => ({
      parallelDownload: parallelDownloadMock,
    }));

    return { coreMock, mockSend, findObjectMock, saveMatchedKeyMock, restoreCacheMock, parallelDownloadMock };
  }

  it("saves state for primary key and credentials on successful restore", async () => {
    const { coreMock } = createBaseMocks();

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.saveState).toHaveBeenCalledWith("primary-key", "test-key");
      expect(coreMock.saveState).toHaveBeenCalledWith("access-key", "test-access");
      expect(coreMock.saveState).toHaveBeenCalledWith("secret-key", "test-secret");
      expect(coreMock.saveState).toHaveBeenCalledWith("session-token", "");
      expect(coreMock.saveState).toHaveBeenCalledWith("region", "us-east-1");
    });
  });

  it("downloads and extracts cache from s3 using parallelDownload", async () => {
    const { coreMock, parallelDownloadMock } = createBaseMocks();

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(parallelDownloadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: "test-bucket",
          key: "test-key/cache.tzst",
          fileSize: 1024,
          chunkSizeMB: 256,
          concurrency: 16,
        }),
      );
      expect(coreMock.info).toHaveBeenCalledWith(
        expect.stringContaining("Downloading cache from s3"),
      );
      expect(coreMock.info).toHaveBeenCalledWith(
        "Cache restored from s3 successfully",
      );
    });
  });

  it("passes downloadConcurrency input to parallelDownload", async () => {
    setInput("downloadConcurrency", "8");
    const { parallelDownloadMock } = createBaseMocks();

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(parallelDownloadMock).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 8 }),
      );
    });
  });

  it("passes partSize input as chunkSizeMB to parallelDownload", async () => {
    setInput("partSize", "128");
    const { parallelDownloadMock } = createBaseMocks();

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(parallelDownloadMock).toHaveBeenCalledWith(
        expect.objectContaining({ chunkSizeMB: 128 }),
      );
    });
  });

  it("sets cache-hit output to true on exact key match", async () => {
    const { coreMock } = createBaseMocks({
      findObjectResult: {
        item: {
          Key: "test-key/cache.tzst",
          LastModified: new Date(),
          Size: 1024,
        },
        matchingKey: "test-key",
      },
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.setOutput).toHaveBeenCalledWith("cache-hit", "true");
    });
  });

  it("sets cache-hit output to false on partial key match", async () => {
    const { coreMock } = createBaseMocks({
      findObjectResult: {
        item: {
          Key: "restore-prefix/cache.tzst",
          LastModified: new Date(),
          Size: 512,
        },
        matchingKey: "restore-prefix",
      },
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    });
  });

  it("sets cache-size output", async () => {
    const { coreMock } = createBaseMocks({
      findObjectResult: {
        item: {
          Key: "test-key/cache.tzst",
          LastModified: new Date(),
          Size: 2048,
        },
        matchingKey: "test-key",
      },
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.setOutput).toHaveBeenCalledWith("cache-size", "2048");
    });
  });

  it("calls saveMatchedKey with the matching key", async () => {
    const { saveMatchedKeyMock } = createBaseMocks();

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(saveMatchedKeyMock).toHaveBeenCalledWith("test-key");
    });
  });

  it("lists tar when debug is enabled", async () => {
    const coreMock = createCoreMock();
    coreMock.isDebug.mockReturnValue(true);
    createBaseMocks({ coreMock });

    await import("../src/restore");

    const { listTar } = await import("@actions/cache/lib/internal/tar");
    await vi.waitFor(() => {
      expect(listTar).toHaveBeenCalled();
    });
  });

  it("sets cache-hit to false when findObject fails", async () => {
    const { coreMock } = createBaseMocks({
      findObjectError: new Error("Cache item not found"),
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.setOutput).toHaveBeenCalledWith("cache-hit", "false");
      expect(coreMock.info).toHaveBeenCalledWith(
        expect.stringContaining("Restore s3 cache failed"),
      );
    });
  });

  it("sets cache-hit to false when parallelDownload fails", async () => {
    const { coreMock } = createBaseMocks({
      parallelDownloadMock: vi.fn().mockRejectedValue(new Error("download failed")),
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.setOutput).toHaveBeenCalledWith("cache-hit", "false");
      expect(coreMock.info).toHaveBeenCalledWith(
        expect.stringContaining("Restore s3 cache failed"),
      );
    });
  });

  it("uses fallback cache when enabled and s3 restore fails", async () => {
    setInput("use-fallback", "true");

    // Ensure not GHES
    process.env["GITHUB_SERVER_URL"] = "https://github.com";

    const { coreMock, restoreCacheMock } = createBaseMocks({
      findObjectError: new Error("Cache item not found"),
      restoreCacheMock: vi.fn().mockResolvedValue("test-key"),
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(restoreCacheMock).toHaveBeenCalled();
      expect(coreMock.info).toHaveBeenCalledWith(
        "Restore cache using fallback cache",
      );
    });
  });

  it("sets cache-hit true when fallback matches exact key", async () => {
    setInput("use-fallback", "true");
    process.env["GITHUB_SERVER_URL"] = "https://github.com";

    const { coreMock } = createBaseMocks({
      findObjectError: new Error("Cache item not found"),
      restoreCacheMock: vi.fn().mockResolvedValue("test-key"),
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      // First call sets false (s3 failure), second sets true (fallback exact match)
      expect(coreMock.setOutput).toHaveBeenCalledWith("cache-hit", "true");
    });
  });

  it("reports fallback cache failure when no match found", async () => {
    setInput("use-fallback", "true");
    process.env["GITHUB_SERVER_URL"] = "https://github.com";

    const { coreMock } = createBaseMocks({
      findObjectError: new Error("Cache item not found"),
      restoreCacheMock: vi.fn().mockResolvedValue(undefined),
    });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.info).toHaveBeenCalledWith("Fallback cache restore failed");
    });
  });

  it("warns when fallback is used on GHES", async () => {
    setInput("use-fallback", "true");
    process.env["GITHUB_SERVER_URL"] = "https://ghes.example.com";

    const { coreMock } = createBaseMocks({
      findObjectError: new Error("Cache item not found"),
    });

    // Need to add warning to the core mock
    coreMock.warning = vi.fn();

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.warning).toHaveBeenCalledWith(
        "Cache fallback is not supported on Github Enterpise.",
      );
    });
  });

  it("registers uncaughtException handler", async () => {
    const processOnSpy = vi.spyOn(process, "on");

    createBaseMocks();

    await import("../src/restore");

    expect(processOnSpy).toHaveBeenCalledWith(
      "uncaughtException",
      expect.any(Function),
    );

    processOnSpy.mockRestore();
  });

  it("calls setFailed when bucket input is missing and throws", async () => {
    // Remove the bucket input to trigger the outer catch
    delete process.env["INPUT_BUCKET"];

    const coreMock = createCoreMock();
    // Make getInput throw for required inputs
    coreMock.getInput.mockImplementation((name: string, opts?: { required?: boolean }) => {
      if (opts?.required && name === "bucket") {
        throw new Error("Input required and not supplied: bucket");
      }
      return (
        process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || ""
      );
    });

    createBaseMocks({ coreMock });

    await import("../src/restore");

    await vi.waitFor(() => {
      expect(coreMock.setFailed).toHaveBeenCalledWith(
        "Input required and not supplied: bucket",
      );
    });
  });
});
