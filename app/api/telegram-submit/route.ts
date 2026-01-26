export const runtime = "nodejs";

type Payload = {
  fullName: string;
  email: string;
  task: string;
  dialect: string;
  result: any | null;
  audioUrl: string | null;

  exercises: any[]; // ✅ tất cả bài đã lưu
  exerciseAnswers: Record<string, Record<string, any>>; // exId -> itemId/qid -> answer
};

function seededShuffle<T>(arr: T[], seedStr: string): T[] {
  const a = [...arr];
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildShuffledMcqView(q: any, correctRaw: string, seedKey: string) {
  const letters = ["A", "B", "C", "D"];
  const opts = q?.options || {};
  const base = letters
    .filter((k) => typeof opts?.[k] === "string" && String(opts[k]).trim())
    .map((k) => ({ key: k, text: String(opts[k]).trim() }));

  if (!base.length) return { optionList: [] as { k: string; v: string }[], correct: null as string | null };

  const correctUpper = String(correctRaw || "").trim().toUpperCase();
  const correctLetter = letters.includes(correctUpper) ? correctUpper : null;

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const correctTextNorm = correctLetter ? "" : norm(String(correctRaw || ""));

  const choices = base.map((it) => ({
    text: it.text,
    isCorrect:
      (correctLetter ? it.key === correctLetter : false) ||
      (!!correctTextNorm && norm(it.text) === correctTextNorm),
  }));

  const shuffled = seededShuffle(choices, seedKey);
  const optionList = shuffled.slice(0, 4).map((c, idx) => ({ k: letters[idx], v: c.text }));
  const correctIdx = shuffled.findIndex((c) => c.isCorrect);
  const correct = correctIdx >= 0 ? letters[correctIdx] : null;

  return { optionList, correct };
}

function csvEscape(v: any) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function tgSendMessage(token: string, chatId: string, text: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.description || "Telegram sendMessage failed");
}

async function tgSendDocument(token: string, chatId: string, blob: Blob, filename: string, caption?: string) {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const fd = new FormData();
  fd.append("chat_id", chatId);
  if (caption) fd.append("caption", caption);
  fd.append("document", blob, filename);

  const r = await fetch(url, { method: "POST", body: fd });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.description || "Telegram sendDocument failed");
}

function buildReports(p: Payload) {
  const sp = p.result?.speechace;

  const scoreObj =
    p.task === "reading"
      ? sp?.text_score?.speechace_score ?? sp?.speechace_score ?? null
      : sp?.speech_score?.speechace_score ?? sp?.speechace_score ?? null;

  const overall =
    p.task === "reading"
      ? sp?.text_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? p.result?.overall ?? null
      : sp?.speech_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? p.result?.overall ?? null;

  const pron = scoreObj?.pronunciation ?? null;
  const flu = scoreObj?.fluency ?? null;
  const gra = scoreObj?.grammar ?? null;
  const coh = scoreObj?.coherence ?? null;
  const voc = scoreObj?.vocab ?? null;

  const transcript =
    p.task === "reading"
      ? sp?.text_score?.transcript ?? sp?.transcript ?? ""
      : sp?.speech_score?.transcript ?? sp?.speech_score?.transcription ?? sp?.transcript ?? "";

  // ===== TXT =====
  const lines: string[] = [];
  lines.push("===== THÔNG TIN HỌC VIÊN =====");
  lines.push(`Họ tên: ${p.fullName || "—"}`);
  lines.push(`Email: ${p.email || "—"}`);
  lines.push(`Task: ${p.task || "—"}`);
  lines.push(`Dialect: ${p.dialect || "—"}`);
  lines.push("");
  lines.push("===== ĐIỂM SPEECHACE =====");
  lines.push(`Overall: ${overall ?? "n/a"}`);
  lines.push(`Pronunciation: ${pron ?? "n/a"}`);
  lines.push(`Fluency: ${flu ?? "n/a"}`);
  lines.push(`Grammar: ${gra ?? "n/a"}`);
  lines.push(`Coherence: ${coh ?? "n/a"}`);
  lines.push(`Vocab: ${voc ?? "n/a"}`);
  lines.push("");
  if (p.audioUrl) lines.push(`Audio URL: ${p.audioUrl}\n`);
  if (transcript) lines.push(`===== TRANSCRIPT =====\n${transcript}\n`);

  // ===== CSV (Excel) =====
  const rows: string[][] = [];
  rows.push(["type", "exerciseId", "title", "questionId", "prompt", "user", "correct", "status"]);

  // ===== HTML =====
  const exHtmlBlocks: string[] = [];

  for (const ex of Array.isArray(p.exercises) ? p.exercises : []) {
    const exId = String(ex?.id || "");
    const ansMap = p.exerciseAnswers?.[exId] || {};

    exHtmlBlocks.push(`<h3>${csvEscape(ex?.title || "Exercise")}</h3>`);
    exHtmlBlocks.push(
      `<div><b>Task:</b> ${csvEscape(ex?.task || "")} &nbsp; <b>Level:</b> ${csvEscape(ex?.level || "")}</div>`
    );

    const items = Array.isArray(ex?.exercises) ? ex.exercises : [];
    const byType = (t: string) => items.find((x: any) => String(x?.type || "").toLowerCase() === t);

    // MCQ
    const mcq = byType("mcq");
    if (mcq) {
      exHtmlBlocks.push(`<h4>1) MCQ</h4>`);
      exHtmlBlocks.push(`<table><tr><th>#</th><th>Question</th><th>User</th><th>Correct</th><th>Status</th></tr>`);
      const qs = Array.isArray(mcq.questions) ? mcq.questions : [];
      qs.forEach((q: any, i: number) => {
        const qid = String(q?.id || `q${i + 1}`);
        const user = String(ansMap[qid] || "").trim().toUpperCase();

        const correctRaw = String(q?.answer ?? ex?.answerKey?.[qid] ?? "").trim();
        const view = buildShuffledMcqView(q, correctRaw, `mcq:${exId}:${qid}`);
        const correct = view.correct || "";

        const status = user && correct ? (user === correct ? "ĐÚNG" : "SAI") : "—";
        rows.push(["mcq", exId, String(ex?.title || ""), qid, String(q?.q || q?.question || ""), user, correct, status]);

        exHtmlBlocks.push(
          `<tr><td>${i + 1}</td><td>${csvEscape(q?.q || q?.question || "")}</td><td>${csvEscape(
            user || "—"
          )}</td><td>${csvEscape(correct || "—")}</td><td>${csvEscape(status)}</td></tr>`
        );
      });
      exHtmlBlocks.push(`</table>`);
    }

    // GAP FILL
    const gap = byType("gap_fill");
    if (gap) {
      exHtmlBlocks.push(`<h4>2) Gap fill</h4>`);
      const itemId = String(gap?.id || "gap1");
      const userArr = Array.isArray(ansMap[itemId]) ? ansMap[itemId] : [];
      const correctArr = Array.isArray(gap?.answers)
        ? gap.answers
        : Array.isArray(ex?.answerKey?.[itemId])
        ? ex.answerKey[itemId]
        : [];

      const n = Math.max(userArr.length, correctArr.length);
      exHtmlBlocks.push(`<table><tr><th>Blank</th><th>User</th><th>Correct</th><th>Status</th></tr>`);
      for (let i = 0; i < n; i++) {
        const u = String(userArr[i] ?? "").trim();
        const c = String(correctArr[i] ?? "").trim();
        const ok = u && c ? u.toLowerCase() === c.toLowerCase() : false;
        const status = u && c ? (ok ? "ĐÚNG" : "SAI") : "—";

        rows.push(["gap", exId, String(ex?.title || ""), `${itemId}[${i + 1}]`, "blank", u, c, status]);
        exHtmlBlocks.push(
          `<tr><td>${i + 1}</td><td>${csvEscape(u || "—")}</td><td>${csvEscape(c || "—")}</td><td>${csvEscape(
            status
          )}</td></tr>`
        );
      }
      exHtmlBlocks.push(`</table>`);
    }

    // Speaking draft (nếu có)
    const spk = byType("speaking_outline");
    if (spk) {
      const itemId = String(spk?.id || "spk1");
      const draft = String(ansMap[itemId] || "");
      if (draft.trim()) {
        rows.push(["speaking", exId, String(ex?.title || ""), itemId, "draft", draft, "", ""]);
        exHtmlBlocks.push(`<h4>Speaking draft</h4><pre>${csvEscape(draft)}</pre>`);
      }
    }

    exHtmlBlocks.push(`<hr/>`);
    lines.push(`===== EXERCISE: ${ex?.title || exId} =====`);
    lines.push(`Task/Level: ${ex?.task || ""} / ${ex?.level || ""}`);
    lines.push(`(Xem chi tiết trong report.html & report.csv)`);
    lines.push("");
  }

  const txt = lines.join("\n");
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Student Report</title>
<style>
body{font-family:Arial, sans-serif; padding:16px; line-height:1.5}
h2{margin:18px 0 8px}
table{border-collapse:collapse; width:100%; margin:8px 0}
td,th{border:1px solid #ddd; padding:8px; vertical-align:top}
th{background:#f5f5f5; text-align:left}
pre{white-space:pre-wrap; background:#fafafa; border:1px solid #eee; padding:10px}
hr{border:0;border-top:1px solid #eee;margin:18px 0}
</style></head>
<body>
<h2>Thông tin học viên</h2>
<table>
<tr><th>Họ tên</th><td>${csvEscape(p.fullName)}</td></tr>
<tr><th>Email</th><td>${csvEscape(p.email)}</td></tr>
<tr><th>Task</th><td>${csvEscape(p.task)}</td></tr>
<tr><th>Dialect</th><td>${csvEscape(p.dialect)}</td></tr>
</table>

<h2>Điểm</h2>
<table>
<tr><th>Overall</th><td>${csvEscape(overall)}</td></tr>
<tr><th>Pronunciation</th><td>${csvEscape(pron)}</td></tr>
<tr><th>Fluency</th><td>${csvEscape(flu)}</td></tr>
<tr><th>Grammar</th><td>${csvEscape(gra)}</td></tr>
<tr><th>Coherence</th><td>${csvEscape(coh)}</td></tr>
<tr><th>Vocab</th><td>${csvEscape(voc)}</td></tr>
</table>

${p.audioUrl ? `<h2>Audio</h2><pre>${csvEscape(p.audioUrl)}</pre>` : ""}
${transcript ? `<h2>Transcript</h2><pre>${csvEscape(transcript)}</pre>` : ""}

<h2>Bài tập (tất cả đã lưu)</h2>
${exHtmlBlocks.join("\n")}

</body></html>`;

  return { txt, csv, html };
}

export async function POST(req: Request) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    const chatId = process.env.TELEGRAM_CHAT_ID || "";
    if (!token || !chatId) {
      return Response.json({ error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" }, { status: 500 });
    }

    const payload = (await req.json()) as Payload;

    await tgSendMessage(
      token,
      chatId,
      `📌 Bài nộp mới\n👤 ${payload.fullName || "—"}\n📧 ${payload.email || "—"}\n🧾 ${payload.task} / ${
        payload.dialect
      }\n🗂 Exercises: ${(payload.exercises || []).length}\n⏱ ${new Date().toLocaleString("vi-VN")}`
    );

    const rep = buildReports(payload);
    await tgSendDocument(token, chatId, new Blob([rep.html], { type: "text/html" }), "report.html", "Report (HTML)");
    await tgSendDocument(token, chatId, new Blob([rep.csv], { type: "text/csv" }), "report.csv", "Report (CSV)");
    await tgSendDocument(token, chatId, new Blob([rep.txt], { type: "text/plain" }), "report.txt", "Report (TXT)");

    // gửi audio file (nếu lấy được)
    if (payload.audioUrl) {
      try {
        const r = await fetch(payload.audioUrl);
        if (r.ok) {
          const ct = r.headers.get("content-type") || "audio/webm";
          const ab = await r.arrayBuffer();
          const ext = ct.includes("wav") ? "wav" : ct.includes("mpeg") ? "mp3" : ct.includes("mp4") ? "mp4" : "webm";
          await tgSendDocument(token, chatId, new Blob([ab], { type: ct }), `audio.${ext}`, "Audio");
        }
      } catch {
        // ignore
      }
    }

    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Send failed" }, { status: 500 });
  }
}