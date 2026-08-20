import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "fs";
import { stat } from "fs/promises";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const accountId = process.env.R2_ACCOUNT_ID;
    if (!accountId) throw new Error("R2_ACCOUNT_ID is required");

    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return s3Client;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is required");
  return bucket;
}

export async function uploadFile(
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const fileStats = await stat(filePath);
  const stream = createReadStream(filePath);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentLength: fileStats.size,
    })
  );
}

export async function downloadFile(key: string): Promise<ReadableStream> {
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  );

  if (!response.Body) throw new Error(`File not found in R2: ${key}`);
  return response.Body.transformToWebStream();
}

/** Byte count of a stored object, or null when the store does not report one.
 *
 *  Exists so the delivery path can refuse an absurd file BEFORE reading it.
 *  Note a presigned GET URL cannot be probed with HTTP HEAD - the signature
 *  covers the method, so HEAD answers 403 - which is why this asks the S3 API
 *  directly instead. */
export async function getObjectSize(key: string): Promise<number | null> {
  const head = await getS3Client().send(
    new HeadObjectCommand({ Bucket: getBucket(), Key: key })
  );
  return typeof head.ContentLength === "number" ? head.ContentLength : null;
}

export async function deleteFile(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  );
}

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 3600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn: expiresInSeconds,
  });
}

export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn: expiresInSeconds,
  });
}

/** Server-side copy inside the bucket. No download, no egress.
 *
 *  Used to take a permanent copy of a clip the moment someone gives feedback on
 *  it. The alternative - exempting the clip from the retention sweep - was
 *  rejected: Rule A soft-deletes precisely because usage.service counts stored
 *  clips as `deletedAt: null`, so a sweep exemption would keep a clip inside
 *  the user's storage quota for the length of the exemption.
 *
 *  CopySource must include the bucket and be URI-encoded; a key with a space or
 *  a non-ASCII character resolves to a different object otherwise. */
export async function copyObject(
  sourceKey: string,
  destinationKey: string
): Promise<void> {
  const bucket = getBucket();
  await getS3Client().send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeURI(`${bucket}/${sourceKey}`),
      Key: destinationKey,
    })
  );
}
