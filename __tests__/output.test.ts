import * as core from "@actions/core";
import { isGhes, formatSize, setCacheHitOutput, setCacheSizeOutput } from "../src/output";

vi.mock("@actions/core");

describe("output", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isGhes", () => {
    it("returns false for github.com", () => {
      process.env["GITHUB_SERVER_URL"] = "https://github.com";
      expect(isGhes()).toBe(false);
    });

    it("returns false when GITHUB_SERVER_URL is not set (defaults to github.com)", () => {
      delete process.env["GITHUB_SERVER_URL"];
      expect(isGhes()).toBe(false);
    });

    it("returns true for enterprise GitHub URL", () => {
      process.env["GITHUB_SERVER_URL"] = "https://github.mycompany.com";
      expect(isGhes()).toBe(true);
    });

    it("returns true for custom enterprise domain", () => {
      process.env["GITHUB_SERVER_URL"] = "https://git.internal.corp";
      expect(isGhes()).toBe(true);
    });

    it("is case-insensitive for github.com check", () => {
      process.env["GITHUB_SERVER_URL"] = "https://GITHUB.COM";
      expect(isGhes()).toBe(false);
    });
  });

  describe("formatSize", () => {
    it('returns empty string for undefined', () => {
      expect(formatSize(undefined)).toBe("");
    });

    it('returns empty string for 0', () => {
      expect(formatSize(0)).toBe("");
    });

    it("formats bytes correctly", () => {
      expect(formatSize(500)).toBe("500bytes");
    });

    it("formats 1 byte correctly", () => {
      expect(formatSize(1)).toBe("1byte");
    });

    it("formats kilobytes correctly", () => {
      const result = formatSize(1500);
      expect(result).toBe("1.5kB");
    });

    it("formats megabytes correctly", () => {
      const result = formatSize(1500000);
      expect(result).toBe("1.5MB");
    });

    it("formats gigabytes correctly", () => {
      const result = formatSize(1500000000);
      expect(result).toBe("1.5GB");
    });
  });

  describe("setCacheHitOutput", () => {
    it('sets output "cache-hit" to "true" when hit is true', () => {
      setCacheHitOutput(true);
      expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "true");
    });

    it('sets output "cache-hit" to "false" when hit is false', () => {
      setCacheHitOutput(false);
      expect(core.setOutput).toHaveBeenCalledWith("cache-hit", "false");
    });
  });

  describe("setCacheSizeOutput", () => {
    it('sets output "cache-size" to string value', () => {
      setCacheSizeOutput(12345);
      expect(core.setOutput).toHaveBeenCalledWith("cache-size", "12345");
    });

    it('sets output "cache-size" for zero', () => {
      setCacheSizeOutput(0);
      expect(core.setOutput).toHaveBeenCalledWith("cache-size", "0");
    });
  });
});
