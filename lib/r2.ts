import { S3Client } from "@aws-sdk/client-s3";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function r2Client(): S3Client {
  const accountId = must("R2_ACCOUNT_ID");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: must("R2_ACCESS_KEY_ID"),
      secretAccessKey: must("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export function r2Bucket(): string {
  return must("R2_BUCKET");
}

export function r2PublicBaseUrl(): string | null {
  const v = process.env.R2_PUBLIC_BASE_URL?.trim();
  return v ? v : null;
}
