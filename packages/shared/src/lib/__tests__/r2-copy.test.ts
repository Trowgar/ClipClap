import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = sendMock;
    },
  };
});

import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { copyObject } from "../r2";

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

describe("copyObject", () => {
  it("copies inside the bucket, with the source qualified by the bucket name", async () => {
    await copyObject("clips/a.mp4", "feedback/a.mp4");
    const command = sendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    const bucket = process.env.R2_BUCKET_NAME;
    expect(command.input).toEqual({
      Bucket: bucket,
      CopySource: `${bucket}/clips/a.mp4`,
      Key: "feedback/a.mp4",
    });
  });

  // CopySource is a URL path, not a plain string. An un-encoded space or
  // non-ASCII character in the key makes S3 resolve a different object - the
  // copy 404s, or worse, silently lands somewhere else. The bucket prefix is
  // what makes it a same-bucket copy at all; without it S3 reads the first
  // path segment as the bucket.
  it("URI-encodes the source key", async () => {
    await copyObject("clips/my clip.mp4", "feedback/x.mp4");
    expect(sendMock.mock.calls[0][0].input.CopySource).toContain("my%20clip.mp4");
  });
});
