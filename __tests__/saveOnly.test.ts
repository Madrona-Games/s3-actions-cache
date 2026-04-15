describe("saveOnly", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls saveCache with standalone=true", async () => {
    const saveCacheMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/save-cache", () => ({
      saveCache: saveCacheMock,
    }));
    vi.doMock("@actions/core", () => ({
      info: vi.fn(),
    }));

    await import("../src/saveOnly");

    await vi.waitFor(() => {
      expect(saveCacheMock).toHaveBeenCalledWith(true);
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

    await import("../src/saveOnly");

    expect(processOnSpy).toHaveBeenCalledWith(
      "uncaughtException",
      expect.any(Function),
    );

    processOnSpy.mockRestore();
  });
});
