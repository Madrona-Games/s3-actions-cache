import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import {
  S3Client,
  ListObjectsV2Command,
  _Object,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { State } from "./state";
import path from "node:path";
import fs from "node:fs";
import { createTar, listTar } from "@actions/cache/lib/internal/tar";
import * as cache from "@actions/cache";

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env["GITHUB_SERVER_URL"] || "https://github.com",
  );
  return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function getInput(key: string, envKey?: string) {
  let result;
  if (envKey) {
    result = process.env[envKey];
  }
  result ??= core.getInput(key);
  return result;
}

export function newS3Client({
  accessKey,
  secretKey,
  sessionToken,
  region,
}: {
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  region?: string;
} = {}): S3Client {
  const endPoint = core.getInput("endpoint");
  const port = getInputAsInt("port");
  const insecure = getInputAsBoolean("insecure");
  const protocol = insecure ? "http" : "https";
  const endpoint = port
    ? `${protocol}://${endPoint}:${port}`
    : `${protocol}://${endPoint}`;

  const resolvedRegion =
    region ?? (getInput("region", "AWS_REGION") || "us-east-1");

  return new S3Client({
    endpoint,
    region: resolvedRegion,
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKey ?? getInput("accessKey", "AWS_ACCESS_KEY_ID") ?? "",
      secretAccessKey:
        secretKey ?? getInput("secretKey", "AWS_SECRET_ACCESS_KEY") ?? "",
      sessionToken:
        sessionToken ?? (getInput("sessionToken", "AWS_SESSION_TOKEN") || undefined),
    },
  });
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

type FindObjectResult = {
  item: _Object;
  matchingKey: string;
};

export async function findObject(
  client: S3Client,
  bucket: string,
  key: string,
  restoreKeys: string[],
  compressionMethod: CompressionMethod,
): Promise<FindObjectResult> {
  core.debug("Key: " + JSON.stringify(key));
  core.debug("Restore keys: " + JSON.stringify(restoreKeys));

  core.debug(`Finding exact macth for: ${key}`);
  const exactMatch = await listObjects(client, bucket, key);
  core.debug(`Found ${JSON.stringify(exactMatch, null, 2)}`);
  if (exactMatch.length) {
    const result = { item: exactMatch[0], matchingKey: key };
    core.debug(`Using ${JSON.stringify(result)}`);
    return result;
  }

  for (const restoreKey of restoreKeys) {
    const fn = utils.getCacheFileName(compressionMethod);
    core.debug(`Finding object with prefix: ${restoreKey}`);
    let objects = await listObjects(client, bucket, restoreKey);
    objects = objects.filter((o) => o.Key!.includes(fn));
    core.debug(`Found ${JSON.stringify(objects, null, 2)}`);
    if (objects.length < 1) {
      continue;
    }
    const sorted = objects.toSorted(
      (a, b) =>
        (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
    );
    const result = { item: sorted[0], matchingKey: restoreKey };
    core.debug(`Using latest ${JSON.stringify(result)}`);
    return result;
  }
  throw new Error("Cache item not found");
}

export async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<_Object[]> {
  const results: _Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    if (response.Contents) {
      results.push(...response.Contents);
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return results;
}

export function saveMatchedKey(matchedKey: string) {
  return core.saveState(State.MatchedKey, matchedKey);
}

function getMatchedKey() {
  return core.getState(State.MatchedKey);
}

export function isExactKeyMatch(): boolean {
  const matchedKey = getMatchedKey();
  const inputKey = core.getState(State.PrimaryKey);
  const result = getMatchedKey() === inputKey;
  core.debug(
    `isExactKeyMatch: matchedKey=${matchedKey} inputKey=${inputKey}, result=${result}`,
  );
  return result;
}

export async function saveCache(standalone: boolean) {
  try {
    if (!standalone && isExactKeyMatch()) {
      core.info("Cache was exact key match, not saving");
      return;
    }

    const bucket = core.getInput("bucket", { required: true });
    // Inputs are re-evaluted before the post action, so we want the original key
    const key = standalone
      ? core.getInput("key", { required: true })
      : core.getState(State.PrimaryKey);
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");

    try {
      const client = newS3Client({
        // Inputs are re-evaluted before the post action, so we want the original keys & tokens
        accessKey: standalone
          ? getInput("accessKey", "AWS_ACCESS_KEY_ID")
          : core.getState(State.AccessKey),
        secretKey: standalone
          ? getInput("secretKey", "AWS_SECRET_ACCESS_KEY")
          : core.getState(State.SecretKey),
        sessionToken: standalone
          ? getInput("sessionToken", "AWS_SESSION_TOKEN")
          : core.getState(State.SessionToken),
        region: standalone
          ? getInput("region", "AWS_REGION")
          : core.getState(State.Region),
      });
      core.info("Created client");
      const compressionMethod = await utils.getCompressionMethod();
      const cachePaths = await utils.resolvePaths(paths);
      core.debug("Cache Paths:");
      core.debug(`${JSON.stringify(cachePaths)}`);

      const archiveFolder = await utils.createTempDirectory();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(archiveFolder, cacheFileName).replaceAll(
        "\\",
        "/",
      );

      core.debug(`Archive Path: ${archivePath}`);

      await createTar(archiveFolder, cachePaths, compressionMethod);
      if (core.isDebug()) {
        await listTar(archivePath, compressionMethod);
      }

      const object = path.join(key, cacheFileName).replaceAll("\\", "/");
      const partSize = (getInputAsInt("partSize") ?? 256) * 1024 * 1024;

      core.info(`Uploading tar to s3. Bucket: ${bucket}, Object: ${object}`);

      const fileStream = fs.createReadStream(archivePath);
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: object,
          Body: fileStream,
        },
        partSize,
        leavePartsOnError: false,
      });
      await upload.done();

      core.info("Cache saved to s3 successfully");
    } catch (e) {
      core.info("Save s3 cache failed: " + e.message + "\n" + e.stack);
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Saving cache using fallback");
          await cache.saveCache(paths, key);
          core.info("Save cache using fallback successfully");
        }
      } else {
        core.debug("skipped fallback cache");
      }
    }
  } catch (e) {
    core.info("warning: " + e.message + "\n" + e.stack);
  }
}
