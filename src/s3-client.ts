import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import {
  S3Client,
  ListObjectsV2Command,
  _Object,
} from "@aws-sdk/client-s3";
import { getInput, getInputAsInt, getInputAsBoolean } from "./input";

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
