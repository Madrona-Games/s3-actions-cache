describe("save", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls saveCache with standalone=false", async () => {
    const saveCacheMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/save-cache", () => ({
      saveCache: saveCacheMock,
    }));
    vi.doMock("@actions/core", () => ({
      info: vi.fn(),
    }));

    await import("../src/save");

    // saveCache(false) returns a promise - give it a tick to resolve
    await vi.waitFor(() => {
      expect(saveCacheMock).toHaveBeenCalledWith(false);
    });
  });

  it("registers uncaughtException handler", async () => {
    const processOnSpy = vi.spyOn(process, "on");

    vi.doMock("../src/save-cache", () => ({
      saveCache: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@actions/core", () => ({
      info: vi.fn(),
    }));

    await import("../src/save");

    expect(processOnSpy).toHaveBeenCalledWith(
      "uncaughtException",
      expect.any(Function),
    );

    processOnSpy.mockRestore();
  });
});
