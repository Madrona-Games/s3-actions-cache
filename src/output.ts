import * as core from "@actions/core";

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env["GITHUB_SERVER_URL"] || "https://github.com",
  );
  return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function formatSize(value?: number, format = "bi") {
  if (!value) return "";
  const [multiple, k, suffix] = (
    format === "bi" ? [1000, "k", "B"] : [1024, "K", "iB"]
  ) as [number, string, string];
  const exp = Math.trunc(Math.log(value) / Math.log(multiple));
  const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
  return (
    size +
    (exp ? (k + "MGTPEZY")[exp - 1] + suffix : "byte" + (size !== 1 ? "s" : ""))
  );
}

export function setCacheHitOutput(isCacheHit: boolean): void {
  core.setOutput("cache-hit", isCacheHit.toString());
}

export function setCacheSizeOutput(cacheSize: number): void {
  core.setOutput("cache-size", cacheSize.toString());
}
