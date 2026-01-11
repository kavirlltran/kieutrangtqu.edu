export const runtime = "nodejs";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client, r2Bucket } from "@/lib/r2";

// Returns a short-lived signed URL to play/download an uploaded audio file.
// We keep buckets private by default; this route is the safe way to fetch audio.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const key = (searchParams.get("key") || "").trim();
    if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

    const url = await getSignedUrl(
      r2Client(),
      new GetObjectCommand({ Bucket: r2Bucket(), Key: key }),
      { expiresIn: 60 }
    );
    return Response.json({ url });
  } catch (e: any) {
    return Response.json({ error: e?.message || "audio-url error" }, { status: 500 });
  }
}
