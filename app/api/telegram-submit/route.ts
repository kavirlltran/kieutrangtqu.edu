export const runtime = "nodejs";

type TaskResultEntry = {
  task: string;
  result: any | null;
  audioUrl: string | null;
};

type Payload = {
  fullName: string;
  email: string;
  dialect: string;

  // ✅ MỚI: mảng kết quả của TẤT CẢ các phần đã làm
  taskResults?: TaskResultEntry[];

  // tương thích ngược (dùng nếu taskResults không có)
  task?: string;
  result?: any | null;
  audioUrl?: string | null;

  exercises: any[]; // ✅ tất cả bài đã lưu
  exerciseAnswers: Record<string, Record<string, any>>; // exId -> itemId/qid -> answer
};

const TASK_LABELS: Record<string, string> = {
  reading: "📚 READING",
  "open-ended": "💬 OPEN-ENDED",
  relevance: "🎯 RELEVANCE",
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

/* ──── Build score section cho 1 task ──── */
function buildScoreSection(taskName: string, result: any, audioUrl: string | null) {
  const label = TASK_LABELS[taskName] || taskName.toUpperCase();
  const sp = result?.speechace;

  const scoreObj =
    taskName === "reading"
      ? sp?.text_score?.speechace_score ?? sp?.speechace_score ?? null
      : sp?.speech_score?.speechace_score ?? sp?.speechace_score ?? null;

  const overall =
    taskName === "reading"
      ? sp?.text_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? result?.overall ?? null
      : sp?.speech_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? result?.overall ?? null;

  const pron = scoreObj?.pronunciation ?? null;
  const flu = scoreObj?.fluency ?? null;
  const gra = scoreObj?.grammar ?? null;
  const coh = scoreObj?.coherence ?? null;
  const voc = scoreObj?.vocab ?? null;

  const transcript =
    taskName === "reading"
      ? sp?.text_score?.transcript ?? sp?.transcript ?? ""
      : sp?.speech_score?.transcript ?? sp?.speech_score?.transcription ?? sp?.transcript ?? "";

  // Relevance extras
  const relevanceObj = (sp?.speech_score?.relevance ?? sp?.relevance ?? null) as any;
  const relevanceClass = result?.relevanceClass ?? relevanceObj?.class ?? null;
  const relevanceScore = result?.relevanceScore ?? relevanceObj?.score ?? null;

  // ── TXT lines ──
  const txtLines: string[] = [];
  txtLines.push(`===== ${label} =====`);
  txtLines.push(`Overall: ${overall ?? "n/a"}`);
  txtLines.push(`Pronunciation: ${pron ?? "n/a"}`);
  txtLines.push(`Fluency: ${flu ?? "n/a"}`);
  txtLines.push(`Grammar: ${gra ?? "n/a"}`);
  txtLines.push(`Coherence: ${coh ?? "n/a"}`);
  txtLines.push(`Vocab: ${voc ?? "n/a"}`);
  if (taskName === "relevance") {
    txtLines.push(`Relevance Class: ${relevanceClass ?? "n/a"}`);
    txtLines.push(`Relevance Score: ${relevanceScore ?? "n/a"}`);
  }
  if (audioUrl) txtLines.push(`Audio URL: ${audioUrl}`);
  if (transcript) txtLines.push(`Transcript: ${transcript}`);
  txtLines.push("");

  // ── HTML block ──
  let html = `<h2>${label}</h2>
<table>
<tr><th>Overall</th><td>${csvEscape(overall)}</td></tr>
<tr><th>Pronunciation</th><td>${csvEscape(pron)}</td></tr>
<tr><th>Fluency</th><td>${csvEscape(flu)}</td></tr>
<tr><th>Grammar</th><td>${csvEscape(gra)}</td></tr>
<tr><th>Coherence</th><td>${csvEscape(coh)}</td></tr>
<tr><th>Vocab</th><td>${csvEscape(voc)}</td></tr>`;
  if (taskName === "relevance") {
    html += `<tr><th>Relevance Class</th><td>${csvEscape(relevanceClass)}</td></tr>`;
    html += `<tr><th>Relevance Score</th><td>${csvEscape(relevanceScore)}</td></tr>`;
  }
  html += `</table>`;
  if (audioUrl) html += `<p><b>Audio:</b> <a href="${csvEscape(audioUrl)}">Tải audio</a></p>`;
  if (transcript) html += `<h4>Transcript</h4><pre>${csvEscape(transcript)}</pre>`;

  return { txtLines, html };
}

function buildReports(p: Payload) {
  // ✅ Xác định danh sách task results
  const taskResultsList: TaskResultEntry[] =
    Array.isArray(p.taskResults) && p.taskResults.length > 0
      ? p.taskResults
      : p.task && p.result
        ? [{ task: p.task, result: p.result, audioUrl: p.audioUrl ?? null }]
        : [];

  // ===== TXT =====
  const lines: string[] = [];
  lines.push("===== THÔNG TIN HỌC VIÊN =====");
  lines.push(`Họ tên: ${p.fullName || "—"}`);
  lines.push(`Email: ${p.email || "—"}`);
  lines.push(`Dialect: ${p.dialect || "—"}`);
  lines.push(`Số phần đã làm: ${taskResultsList.length}`);
  lines.push(`Các phần: ${taskResultsList.map((t) => t.task).join(", ") || "—"}`);
  lines.push("");

  // ===== HTML head =====
  const htmlScoreBlocks: string[] = [];

  // ===== CSV =====
  const rows: string[][] = [];
  rows.push(["type", "exerciseId", "title", "questionId", "prompt", "user", "correct", "status"]);

  // ── Build score sections cho TẤT CẢ task ──
  for (const tr of taskResultsList) {
    const section = buildScoreSection(tr.task, tr.result, tr.audioUrl);
    lines.push(...section.txtLines);
    htmlScoreBlocks.push(section.html);
  }

  if (taskResultsList.length === 0) {
    lines.push("(Chưa có kết quả chấm điểm nào)");
    lines.push("");
    htmlScoreBlocks.push("<p><em>Chưa có kết quả chấm điểm nào</em></p>");
  }

  // ===== Exercise blocks =====
  const exHtmlBlocks: string[] = [];

  for (const ex of Array.isArray(p.exercises) ? p.exercises : []) {
    const exId = String(ex?.id || "");
    const ansMap = p.exerciseAnswers?.[exId] || {};
    const exTaskLabel = TASK_LABELS[ex?.task] || (ex?.task || "").toUpperCase();

    exHtmlBlocks.push(`<h3>${csvEscape(ex?.title || "Exercise")} <small>(${exTaskLabel})</small></h3>`);
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
    lines.push(`===== EXERCISE: ${ex?.title || exId} (${exTaskLabel}) =====`);
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
h2{margin:18px 0 8px; border-bottom:2px solid #3b82f6; padding-bottom:6px}
h3{margin:14px 0 6px}
table{border-collapse:collapse; width:100%; margin:8px 0}
td,th{border:1px solid #ddd; padding:8px; vertical-align:top}
th{background:#f5f5f5; text-align:left}
pre{white-space:pre-wrap; background:#fafafa; border:1px solid #eee; padding:10px}
hr{border:0;border-top:1px solid #eee;margin:18px 0}
small{color:#888;font-weight:normal}
</style></head>
<body>
<h2>📋 Thông tin học viên</h2>
<table>
<tr><th>Họ tên</th><td>${csvEscape(p.fullName)}</td></tr>
<tr><th>Email</th><td>${csvEscape(p.email)}</td></tr>
<tr><th>Dialect</th><td>${csvEscape(p.dialect)}</td></tr>
<tr><th>Số phần đã làm</th><td>${taskResultsList.length}</td></tr>
<tr><th>Các phần</th><td>${taskResultsList.map((t) => TASK_LABELS[t.task] || t.task).join(", ") || "—"}</td></tr>
</table>

${htmlScoreBlocks.join("\n<hr/>\n")}

<h2>📝 Bài tập (tất cả đã lưu)</h2>
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

    // ✅ Xác định danh sách task results
    const taskResultsList: TaskResultEntry[] =
      Array.isArray(payload.taskResults) && payload.taskResults.length > 0
        ? payload.taskResults
        : payload.task && payload.result
          ? [{ task: payload.task, result: payload.result, audioUrl: payload.audioUrl ?? null }]
          : [];

    // ✅ Telegram summary message ghi rõ từng phần + chi tiết điểm
    const completedParts = taskResultsList.map((t) => TASK_LABELS[t.task] || t.task).join(", ");
    const summaryLines: string[] = [];
    summaryLines.push(`📌 Bài nộp mới`);
    summaryLines.push(`👤 ${payload.fullName || "—"}`);
    summaryLines.push(`📧 ${payload.email || "—"}`);
    summaryLines.push(`🗣 Dialect: ${payload.dialect}`);
    summaryLines.push(`📝 Các phần đã làm: ${completedParts || "—"}`);
    summaryLines.push(`🗂 Exercises: ${(payload.exercises || []).length}`);
    summaryLines.push(`⏱ ${new Date().toLocaleString("vi-VN")}`);

    // Chi tiết điểm từng phần
    for (const tr of taskResultsList) {
      const label = TASK_LABELS[tr.task] || tr.task.toUpperCase();
      const sp = tr.result?.speechace;

      const scoreObj =
        tr.task === "reading"
          ? sp?.text_score?.speechace_score ?? sp?.speechace_score ?? null
          : sp?.speech_score?.speechace_score ?? sp?.speechace_score ?? null;

      const overall =
        tr.task === "reading"
          ? sp?.text_score?.speechace_score?.overall ?? tr.result?.overall ?? null
          : sp?.speech_score?.speechace_score?.overall ?? tr.result?.overall ?? null;

      summaryLines.push(``);
      summaryLines.push(`━━━ ${label} ━━━`);
      summaryLines.push(`Overall: ${overall ?? "n/a"}`);
      if (scoreObj?.pronunciation != null) summaryLines.push(`Pronunciation: ${scoreObj.pronunciation}`);
      if (scoreObj?.fluency != null) summaryLines.push(`Fluency: ${scoreObj.fluency}`);
      if (scoreObj?.grammar != null) summaryLines.push(`Grammar: ${scoreObj.grammar}`);
      if (scoreObj?.coherence != null) summaryLines.push(`Coherence: ${scoreObj.coherence}`);
      if (scoreObj?.vocab != null) summaryLines.push(`Vocab: ${scoreObj.vocab}`);

      // Reading: weakest words
      if (tr.task === "reading") {
        const wordList = Array.isArray(sp?.text_score?.word_score_list) ? sp.text_score.word_score_list : [];
        const weakest = wordList
          .filter((w: any) => Number.isFinite(w?.quality_score))
          .sort((a: any, b: any) => a.quality_score - b.quality_score)
          .slice(0, 8);
        if (weakest.length) {
          summaryLines.push(`Weakest words: ${weakest.map((w: any) => `${w.word}(${w.quality_score})`).join(", ")}`);
        }
        const text = sp?.text_score?.text ?? tr.result?.text ?? "";
        if (text) summaryLines.push(`Text: ${String(text).slice(0, 200)}`);
      }

      // Open-ended / Relevance: transcript
      if (tr.task !== "reading") {
        const transcript = sp?.speech_score?.transcript ?? tr.result?.transcript ?? "";
        if (transcript) summaryLines.push(`Transcript: ${String(transcript).slice(0, 200)}`);
      }

      // Relevance: class + gemini
      if (tr.task === "relevance") {
        const relClass = tr.result?.relevanceClass ?? sp?.speech_score?.relevance?.class ?? null;
        summaryLines.push(`Relevance: ${relClass ?? "n/a"}`);
        if (tr.result?.geminiRelevance != null) {
          summaryLines.push(`🤖 Gemini: ${tr.result.geminiRelevance ? "TRUE" : "FALSE"} – ${tr.result.geminiReason || ""}`);
        }
      }
    }

    await tgSendMessage(token, chatId, summaryLines.join("\n"));

    const rep = buildReports(payload);
    await tgSendDocument(token, chatId, new Blob([rep.html], { type: "text/html" }), "report.html", "Report (HTML)");
    await tgSendDocument(token, chatId, new Blob([rep.csv], { type: "text/csv" }), "report.csv", "Report (CSV)");
    await tgSendDocument(token, chatId, new Blob([rep.txt], { type: "text/plain" }), "report.txt", "Report (TXT)");

    // ✅ gửi audio file cho TẤT CẢ các task (kèm nhãn phần)
    for (const tr of taskResultsList) {
      if (!tr.audioUrl) continue;
      try {
        const r = await fetch(tr.audioUrl);
        if (r.ok) {
          const ct = r.headers.get("content-type") || "audio/webm";
          const ab = await r.arrayBuffer();
          const ext = ct.includes("wav") ? "wav" : ct.includes("mpeg") ? "mp3" : ct.includes("mp4") ? "mp4" : "webm";
          const label = tr.task.replace(/[^a-z0-9-]/gi, "_");
          await tgSendDocument(
            token,
            chatId,
            new Blob([ab], { type: ct }),
            `audio_${label}.${ext}`,
            `🔊 Audio – ${TASK_LABELS[tr.task] || tr.task}`
          );
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