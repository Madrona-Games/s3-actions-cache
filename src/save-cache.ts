import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import { Upload } from "@aws-sdk/lib-storage";
import { createTar, listTar } from "@actions/cache/lib/internal/tar";
import * as cache from "@actions/cache";
import path from "node:path";
import fs from "node:fs";
import { State } from "./state";
import { newS3Client } from "./s3-client";
import { getInput, getInputAsArray, getInputAsBoolean, getInputAsInt } from "./input";
import { isGhes } from "./output";

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
      const uploadConcurrency = getInputAsInt("uploadConcurrency") ?? 16;

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
        queueSize: uploadConcurrency,
        leavePartsOnError: false,
      });

      upload.on("httpUploadProgress", (progress) => {
        if (progress.loaded != null && progress.total != null) {
          const pct = ((progress.loaded / progress.total) * 100).toFixed(1);
          core.info(
            `Upload progress: ${progress.loaded} / ${progress.total} bytes (${pct}%)`,
          );
        }
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
