export const runtime = "nodejs";
export const maxDuration = 120;

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, r2Bucket, r2PublicBaseUrl } from "@/lib/r2";
import { isDialect } from "@/lib/dialects";

type WeakestWord = { word: string; q: number };

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
  // Make a clean ArrayBuffer (NOT SharedArrayBuffer) to satisfy TS `BlobPart` typing.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

async function sendTelegram(text: string) {
  const token = must("TELEGRAM_BOT_TOKEN");
  const chatId = must("TELEGRAM_CHAT_ID");
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

export async function POST(req: Request) {
  try {
    const speechaceKey = must("SPEECHACE_KEY");
    const endpoint = must("SPEECHACE_TEXT_ENDPOINT"); // SpeechAce Text (scripted reading) endpoint

    const body = await req.json();

    const fullName = String(body.fullName || "").trim();
    const email = String(body.email || "").trim();
    const text = String(body.text || "").trim();
    const audioKey = String(body.audioKey || "").trim();
    const dialect = isDialect(body.dialect) ? body.dialect : "en-us";
    const durationSec = Number.isFinite(body.durationSec) ? Number(body.durationSec) : undefined;

    if (!fullName || !email) return Response.json({ error: "Full name & email are required." }, { status: 400 });
    if (!text || text.split(/\s+/).filter(Boolean).length < 1)
      return Response.json({ error: "Reference text is required." }, { status: 400 });
    if (!audioKey) return Response.json({ error: "Missing audioKey." }, { status: 400 });

    // Load audio from R2
    const obj = await r2Client().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: audioKey }));
    if (!obj.Body) return Response.json({ error: "Audio not found." }, { status: 404 });

    const audioBuf = await streamToBuffer(obj.Body);
    const ct = obj.ContentType || "application/octet-stream";
    const ext = extFromContentType(ct);

    // Forward to SpeechAce as multipart: text + user_audio_file (+ include_fluency=1)
    const forward = new FormData();
    forward.append("text", text);
    forward.append("include_fluency", "1");

    const ab = bufferToArrayBuffer(audioBuf);
    forward.append("user_audio_file", new Blob([ab], { type: ct }), `speech.${ext}`);

    const speechAceUrl =
      `${endpoint}?key=${encodeURIComponent(speechaceKey)}` +
      `&dialect=${encodeURIComponent(dialect)}`;

    const r = await fetch(speechAceUrl, { method: "POST", body: forward });
    const rawText = await r.text();

    let speechace: any;
    try {
      speechace = JSON.parse(rawText);
    } catch {
      speechace = { raw: rawText };
    }

    const overall =
      speechace?.text_score?.speechace_score?.overall ??
      speechace?.text_score?.overall ??
      speechace?.speechace_score?.overall ??
      null;

    const wordList = Array.isArray(speechace?.text_score?.word_score_list)
      ? speechace.text_score.word_score_list
      : [];

    // ✅ FIX: give weakest a real type so TS can infer map callback types later
    const weakest: WeakestWord[] = wordList
      .filter((w: any) => Number.isFinite(w?.quality_score))
      .map((w: any) => ({ word: String(w.word ?? ""), q: Number(w.quality_score) }))
      .filter((w: WeakestWord) => Boolean(w.word))
      .sort((a: WeakestWord, b: WeakestWord) => a.q - b.q)
      .slice(0, 8);

    const pub = r2PublicBaseUrl();
    const audioLink = pub ? `${pub.replace(/\/$/, "")}/${audioKey}` : null;

    const msg =
      `📩 New Reading Result\n` +
      `Name: ${fullName}\n` +
      `Email: ${email}\n` +
      `Dialect: ${dialect}\n` +
      (typeof durationSec === "number" ? `Duration: ${durationSec}s\n` : "") +
      `Overall: ${overall ?? "n/a"}\n` +
      // ✅ FIX: explicitly type w
      (weakest.length
        ? `Weakest words: ${weakest
            .map((w: WeakestWord) => `${w.word}(${w.q.toFixed(0)})`)
            .join(", ")}\n`
        : "") +
      (audioLink ? `Audio: ${audioLink}\n` : "") +
      `Text: ${text.slice(0, 220)}${text.length > 220 ? "…" : ""}`;

    // Don't block the user if Telegram temporarily fails.
    try {
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        await sendTelegram(msg);
      }
    } catch {
      // noop
    }

    return Response.json({ ok: true, task: "reading", overall, dialect, audioKey, speechace });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}
