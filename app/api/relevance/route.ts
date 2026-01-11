export const runtime = "nodejs";
export const maxDuration = 30;

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, r2Bucket } from "@/lib/r2";
import { isDialect } from "@/lib/dialects";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function extFromContentType(ct: string): string {
  const t = (ct || "").toLowerCase();
  if (t.includes("audio/wav") || t.includes("audio/x-wav")) return "wav";
  if (t.includes("audio/mpeg") || t.includes("audio/mp3")) return "mp3";
  if (t.includes("audio/ogg") || t.includes("application/ogg")) return "ogg";
  if (t.includes("audio/webm")) return "webm";
  if (t.includes("audio/mp4") || t.includes("video/mp4")) return "mp4";
  if (t.includes("audio/aac")) return "aac";
  if (t.includes("audio/flac")) return "flac";
  return "bin";
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

export async function POST(req: Request) {
  try {
    const speechaceKey = must("SPEECHACE_KEY");
    const endpoint = must("SPEECHACE_SPEECH_ENDPOINT"); // SpeechAce Speech v9 endpoint

    const body = await req.json();

    const fullName = String(body.fullName || "").trim();
    const email = String(body.email || "").trim();
    const audioKey = String(body.audioKey || "").trim();
    const dialect = isDialect(body.dialect) ? body.dialect : "en-us";
    const relevanceContext = String(body.relevanceContext || "").trim();
    const pronunciationScoreMode = body.pronunciationScoreMode === "strict" ? "strict" : "default";
    const detectDialect = body.detectDialect ? "1" : "0";

    if (!fullName || !email) return Response.json({ error: "Full name & email are required." }, { status: 400 });
    if (!audioKey) return Response.json({ error: "Missing audioKey." }, { status: 400 });
    if (!relevanceContext) return Response.json({ error: "relevanceContext is required." }, { status: 400 });

    const obj = await r2Client().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: audioKey }));
    if (!obj.Body) return Response.json({ error: "Audio not found." }, { status: 404 });

    const audioBuf = await streamToBuffer(obj.Body);
    const ct = obj.ContentType || "application/octet-stream";
    const ext = extFromContentType(ct);

    const forward = new FormData();
    const ab = bufferToArrayBuffer(audioBuf);
    forward.append("user_audio_file", new Blob([ab], { type: ct }), `speech.${ext}`);

    forward.append("relevance_context", relevanceContext);
    forward.append("include_ielts_feedback", "1");
    forward.append("pronunciation_score_mode", pronunciationScoreMode);
    forward.append("detect_dialect", detectDialect);

    const url =
      `${endpoint}?key=${encodeURIComponent(speechaceKey)}` +
      `&dialect=${encodeURIComponent(dialect)}`;

    const r = await fetch(url, { method: "POST", body: forward });
    const rawText = await r.text();
    let speechace: any;
    try {
      speechace = JSON.parse(rawText);
    } catch {
      speechace = { raw: rawText };
    }
    if (!r.ok) {
      return Response.json({ error: speechace?.error || speechace?.message || "SpeechAce error", speechace }, { status: 400 });
    }

    const overall =
      speechace?.speech_score?.speechace_score?.overall ??
      speechace?.speechace_score?.overall ??
      null;

    const relevanceClass = speechace?.speech_score?.relevance?.class ?? null;

    return Response.json({
      ok: true,
      task: "relevance",
      overall,
      relevanceClass,
      dialect,
      audioKey,
      relevanceContext,
      speechace,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}
