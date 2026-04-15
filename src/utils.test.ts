import { getCompressionMethod } from "@actions/cache/lib/internal/cacheUtils";
import { S3Client } from "@aws-sdk/client-s3";
import { findObject } from "./utils";

describe("utils", () => {
  test("getLatestObj", async () => {
    const client = new S3Client({
      endpoint: "https://play.min.io",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "Q3AM3UQ867SPQQA43P2F",
        secretAccessKey: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG",
      },
    });
    const got = await findObject(
      client,
      "actions-cache",
      "foo.bar",
      ["test-Linux-"],
      await getCompressionMethod()
    );
    expect(got).toBeTruthy();
    console.log(got);
  });
});
