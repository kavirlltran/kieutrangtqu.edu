export const runtime = "nodejs";
export const maxDuration = 30;

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * Extract JSON object bằng cách balance ngoặc {} (an toàn hơn lastIndexOf).
 * Trả về JSON object đầu tiên hoàn chỉnh trong chuỗi.
 */
function extractBalancedJson(text: string): string | null {
  if (!text) return null;

  // remove markdown fences (nếu model lỡ bọc)
  const cleaned = String(text)
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  // không tìm được JSON hoàn chỉnh (bị cụt)
  return null;
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function callGroq(messages: { role: "system" | "user"; content: string }[]) {
  const key = must("GROQ_API_KEY");
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.35, // GIẢM để ít loạn / ít text thừa
      max_tokens: 2400,  // TĂNG để đỡ bị cụt JSON
      messages,
    }),
  });

  const raw = await r.text();
  let data: any = null;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Groq returned non-JSON: ${raw.slice(0, 400)}`);
  }

  if (!r.ok) {
    const msg = data?.error?.message || "Groq error";
    throw new Error(msg);
  }

  return String(data?.choices?.[0]?.message?.content || "");
}

function normalizeExerciseObj(obj: any, task: string, level: string) {
  // ép kiểu & set defaults để UI khỏi “no prompt”
  const out: any = obj && typeof obj === "object" ? obj : {};

  out.title = String(out.title || "Exercise Set").trim();
  out.task = task;     // ép theo request
  out.level = level;   // ép theo request

  out.newContent = out.newContent && typeof out.newContent === "object" ? out.newContent : {};
  out.newContent.title = String(out.newContent.title || "New Content").trim();
  out.newContent.text = String(out.newContent.text || "").trim();

  out.exercises = Array.isArray(out.exercises) ? out.exercises : [];
  out.answerKey = out.answerKey && typeof out.answerKey === "object" ? out.answerKey : {};
  out.rubric = out.rubric && typeof out.rubric === "object" ? out.rubric : {};

  return out;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const task = String(body.task || "").trim().toLowerCase(); // reading | open-ended
    const sourceText = String(body.sourceText || "").trim();
    const level = String(body.level || "B1").trim().toUpperCase();
    const topic = String(body.topic || "").trim();
    const targetSeconds = Number(body.targetSeconds || 90);

    if (!task || !["reading", "open-ended"].includes(task)) {
      return Response.json({ error: "task must be reading | open-ended" }, { status: 400 });
    }
    if (!sourceText) {
      return Response.json({ error: "sourceText is required" }, { status: 400 });
    }

    // ✅ Prompt gọn hơn để output KHÔNG bị cụt
    const system = `
You are an expert English teacher and exercise designer.
Return ONLY ONE valid JSON object. No markdown. No extra text.
Do not wrap in backticks. Do not add commentary.
All keys must use double quotes. JSON must be parseable by JSON.parse.
Use Vietnamese for explanations/notes, English for passage/prompts/questions.
Keep everything SHORT.
`.trim();

    const user = `
Create a BRAND NEW exercise set for task="${task}".
The input is ONLY for reference. Do NOT copy sentences.

INPUT (reference):
${sourceText}

Constraints:
- Level: ${level}
- Topic preference: ${topic || "(free)"}
- Output must be small enough to fit tokens.
- newContent.text:
  - reading: 90-120 words (<= 850 chars)
  - open-ended: 1 NEW prompt + 3 follow-ups in the text (short)

Return EXACT schema:
{
  "title": string,
  "task": "reading" | "open-ended",
  "level": string,
  "newContent": { "title": string, "text": string },
  "exercises": [
    { "type":"mcq","id":"mcq1","questions":[
      {"id":"q1","q":string,"options":{"A":string,"B":string,"C":string,"D":string},"answer":"A"|"B"|"C"|"D"},
      {"id":"q2","q":string,"options":{"A":string,"B":string,"C":string,"D":string},"answer":"A"|"B"|"C"|"D"},
      {"id":"q3","q":string,"options":{"A":string,"B":string,"C":string,"D":string},"answer":"A"|"B"|"C"|"D"}
    ]},
    { "type":"gap_fill","id":"gap1","text":string,"bank":[string,string,string,string],"answers":[string,string,string,string]},
    { "type":"vocab_pack","id":"vocab1","items":[
      {"word":string,"meaning_vi":string,"example":string,"collocation":string},
      {"word":string,"meaning_vi":string,"example":string,"collocation":string},
      {"word":string,"meaning_vi":string,"example":string,"collocation":string},
      {"word":string,"meaning_vi":string,"example":string,"collocation":string},
      {"word":string,"meaning_vi":string,"example":string,"collocation":string},
      {"word":string,"meaning_vi":string,"example":string,"collocation":string}
    ]},
    { "type":"pronunciation_drill","id":"pron1","minimalPairs":[[string,string],[string,string],[string,string],[string,string],[string,string]],"shadowingSentences":[string,string,string,string,string]},
    { "type":"speaking_outline","id":"spk1","outline":{"intro":[string,string],"body":[string,string,string],"conclusion":[string]},"followUps":[string,string,string]},
    { "type":"common_mistakes","id":"mist1","mistakes":[{"wrong":string,"fix":string,"note":string},{"wrong":string,"fix":string,"note":string},{"wrong":string,"fix":string,"note":string},{"wrong":string,"fix":string,"note":string},{"wrong":string,"fix":string,"note":string}]}
  ],
  "answerKey": { "q1":string, "q2":string, "q3":string, "gap1":[string,string,string,string] },
  "rubric": { "pronunciation":string,"fluency":string,"grammar":string,"vocab":string,"coherence":string }
}

IMPORTANT:
- MUST include all 6 exercise items exactly once.
- gap_fill.text MUST contain exactly 4 blanks using "____".
- Keep strings short.
`.trim();

    // 1) Call lần 1
    const content1 = await callGroq([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    const jsonStr1 = extractBalancedJson(content1);
    let obj = jsonStr1 ? safeJsonParse(jsonStr1) : null;

    // 2) Nếu fail → repair 1 lần
    if (!obj) {
      const repairSystem = `
You are a JSON repair bot.
Return ONLY a valid JSON object. No markdown. No extra text.
Fix missing braces/quotes/trailing commas if needed.
`.trim();

      const repairUser = `
The previous output was not valid JSON (maybe truncated).
Reconstruct and output the COMPLETE JSON object following the SAME schema.

Previous output (may be incomplete):
${content1.slice(0, 3500)}
`.trim();

      const content2 = await callGroq([
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ]);

      const jsonStr2 = extractBalancedJson(content2);
      obj = jsonStr2 ? safeJsonParse(jsonStr2) : null;

      if (!obj) {
        return Response.json(
          {
            error: "Model did not return valid JSON (even after repair)",
            contentHead: content2.slice(0, 1200),
          },
          { status: 422 }
        );
      }
    }

    // normalize + server set fields
    const normalized = normalizeExerciseObj(obj, task, level);

    normalized.id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    normalized.createdAt = Date.now();

    return Response.json({ ok: true, exercise: normalized });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}
