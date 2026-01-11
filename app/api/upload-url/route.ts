export const runtime = "nodejs";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Bucket, r2Client } from "@/lib/r2";

function randomKey(ext: string) {
  const rand = Math.random().toString(16).slice(2);
  const ts = Date.now();
  return `uploads/${ts}_${rand}.${ext || "bin"}`;
}

function extFromContentType(ct: string): string {
  const t = (ct || "").toLowerCase();
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4")) return "mp4";
  if (t.includes("aac")) return "aac";
  if (t.includes("flac")) return "flac";
  return "bin";
}

// Create a presigned PUT URL so the browser can upload audio directly to R2 (private bucket).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const contentType = String(body?.contentType || "application/octet-stream");
    const key = randomKey(extFromContentType(contentType));

    const cmd = new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(r2Client(), cmd, { expiresIn: 60 });

    return Response.json({ url, key });
  } catch (e: any) {
    return Response.json({ error: e?.message || "upload-url error" }, { status: 500 });
  }
}
