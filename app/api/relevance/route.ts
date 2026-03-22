export const runtime = "nodejs";
export const maxDuration = 120; // Premium cho audio dài, tránh Vercel timeout

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

// ===== Gemini AI cross-check relevance =====
async function geminiCheckRelevance(
  transcript: string,
  context: string
): Promise<{ relevant: boolean; reason: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !transcript || !context) return null;

  const prompt = `You are evaluating whether a student's spoken response matches the given topic.

Topic/Question: "${context}"

Student's transcript: "${transcript}"

Rules:
- TRUE if the student talks about the topic described in the question/context
- FALSE if the student talks about a completely different topic
- Be strict: "favorite food" and "favorite subject" are DIFFERENT topics
- Only answer in this exact JSON format, nothing else:
{"relevant": true, "reason": "brief explanation"}
or
{"relevant": false, "reason": "brief explanation"}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      relevant: Boolean(parsed.relevant),
      reason: String(parsed.reason || ""),
    };
  } catch {
    return null; // graceful fallback
  }
}

export async function POST(req: Request) {
  try {
    const speechaceKey = must("SPEECHACE_KEY");
    const endpoint = must("SPEECHACE_SPEECH_ENDPOINT");

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
    const transcript = speechace?.speech_score?.transcript ?? null;

    const ielts = speechace?.speech_score?.ielts_score ?? null;
    const pte = speechace?.speech_score?.pte_score ?? null;
    const toeic = speechace?.speech_score?.toeic_score ?? null;
    const cefr = speechace?.speech_score?.cefr_score ?? null;

    const issues = Array.isArray(speechace?.speech_score?.score_issue_list)
      ? speechace.speech_score.score_issue_list
      : [];

    // ===== Gemini AI cross-check =====
    let geminiRelevance: boolean | null = null;
    let geminiReason: string | null = null;

    if (transcript && relevanceContext) {
      const geminiResult = await geminiCheckRelevance(transcript, relevanceContext);
      if (geminiResult) {
        geminiRelevance = geminiResult.relevant;
        geminiReason = geminiResult.reason;
      }
    }

    return Response.json({
      ok: true,
      task: "relevance",
      overall,
      relevanceClass,
      transcript,
      ielts,
      pte,
      toeic,
      cefr,
      issues,
      dialect,
      audioKey,
      relevanceContext,
      // Gemini cross-check results
      geminiRelevance,
      geminiReason,
      speechace,
    });

  } catch (e: any) {
    return Response.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}
