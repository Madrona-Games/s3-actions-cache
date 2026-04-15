import * as core from "@actions/core";
import { getInput, getInputAsBoolean, getInputAsArray, getInputAsInt } from "../src/input";
import { setInput } from "./testUtils";

describe("input", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getInput", () => {
    it("returns core.getInput value when no envKey provided", () => {
      setInput("testKey", "core-value");
      expect(getInput("testKey")).toBe("core-value");
    });

    it("returns env var when envKey is provided and env var exists", () => {
      setInput("testKey", "core-value");
      process.env["MY_ENV_KEY"] = "env-value";
      expect(getInput("testKey", "MY_ENV_KEY")).toBe("env-value");
    });

    it("falls back to core.getInput when envKey is provided but env var is not set", () => {
      setInput("testKey", "core-value");
      delete process.env["MY_ENV_KEY"];
      expect(getInput("testKey", "MY_ENV_KEY")).toBe("core-value");
    });

    it("env var takes precedence over core.getInput", () => {
      setInput("testKey", "core-value");
      process.env["MY_ENV_KEY"] = "env-value";
      const result = getInput("testKey", "MY_ENV_KEY");
      expect(result).toBe("env-value");
    });

    it("returns empty string when neither env var nor input is set", () => {
      expect(getInput("nonexistent")).toBe("");
    });
  });

  describe("getInputAsBoolean", () => {
    it('returns true when input is "true"', () => {
      setInput("boolInput", "true");
      expect(getInputAsBoolean("boolInput")).toBe(true);
    });

    it('returns false when input is "false"', () => {
      setInput("boolInput", "false");
      expect(getInputAsBoolean("boolInput")).toBe(false);
    });

    it("returns false when input is empty", () => {
      setInput("boolInput", "");
      expect(getInputAsBoolean("boolInput")).toBe(false);
    });

    it('returns false for non-"true" strings', () => {
      setInput("boolInput", "yes");
      expect(getInputAsBoolean("boolInput")).toBe(false);
    });

    it('returns false for "True" (case sensitive)', () => {
      setInput("boolInput", "True");
      expect(getInputAsBoolean("boolInput")).toBe(false);
    });
  });

  describe("getInputAsArray", () => {
    it("splits input on newlines", () => {
      setInput("arrayInput", "foo\nbar\nbaz");
      expect(getInputAsArray("arrayInput")).toEqual(["foo", "bar", "baz"]);
    });

    it("trims whitespace from entries", () => {
      setInput("arrayInput", "  foo  \n  bar  ");
      expect(getInputAsArray("arrayInput")).toEqual(["foo", "bar"]);
    });

    it("filters out empty entries", () => {
      setInput("arrayInput", "foo\n\n\nbar\n");
      expect(getInputAsArray("arrayInput")).toEqual(["foo", "bar"]);
    });

    it("returns empty array for empty input", () => {
      setInput("arrayInput", "");
      expect(getInputAsArray("arrayInput")).toEqual([]);
    });

    it("handles single-line input", () => {
      setInput("arrayInput", "single-value");
      expect(getInputAsArray("arrayInput")).toEqual(["single-value"]);
    });
  });

  describe("getInputAsInt", () => {
    it("parses a valid positive integer", () => {
      setInput("intInput", "42");
      expect(getInputAsInt("intInput")).toBe(42);
    });

    it("parses zero", () => {
      setInput("intInput", "0");
      expect(getInputAsInt("intInput")).toBe(0);
    });

    it("returns undefined for negative numbers", () => {
      setInput("intInput", "-5");
      expect(getInputAsInt("intInput")).toBeUndefined();
    });

    it("returns undefined for non-numeric strings", () => {
      setInput("intInput", "abc");
      expect(getInputAsInt("intInput")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      setInput("intInput", "");
      expect(getInputAsInt("intInput")).toBeUndefined();
    });

    it("parses integer from float string (parseInt behavior)", () => {
      setInput("intInput", "3.14");
      expect(getInputAsInt("intInput")).toBe(3);
    });
  });
});
