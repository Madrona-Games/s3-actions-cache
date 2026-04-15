import * as core from "@actions/core";

export function getInput(key: string, envKey?: string) {
  let result;
  if (envKey) {
    result = process.env[envKey];
  }
  result ??= core.getInput(key);
  return result;
}

export function getInputAsBoolean(
  name: string,
  options?: core.InputOptions,
): boolean {
  return core.getInput(name, options) === "true";
}

export function getInputAsArray(
  name: string,
  options?: core.InputOptions,
): string[] {
  return core
    .getInput(name, options)
    .split("\n")
    .map((s) => s.trim())
    .filter((x) => x !== "");
}

export function getInputAsInt(
  name: string,
  options?: core.InputOptions,
): number | undefined {
  const value = Number.parseInt(core.getInput(name, options));
  if (Number.isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}
