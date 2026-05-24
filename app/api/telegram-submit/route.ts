export const runtime = "nodejs";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, r2Bucket } from "@/lib/r2";

type TaskResultEntry = {
  task: string;
  result: any | null;
  audioUrl: string | null;
};

type Payload = {
  fullName: string;
  email: string;
  dialect: string;
  classCode?: string; // ✅ lớp học

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

// ===== CLASS CONFIG =====
// Vercel env var CLASS_CONFIG dạng JSON:
// [{"code":"10A1","chatId":"-1001234567890"},{"code":"10A2","chatId":"-1009876543210"},...]
// Nếu không có CLASS_CONFIG hoặc không tìm thấy lớp, fallback về TELEGRAM_CHAT_ID
function resolveClassChatId(classCode: string | undefined, defaultChatId: string): string {
  if (!classCode) return defaultChatId;
  try {
    const raw = process.env.CLASS_CONFIG || "";
    if (!raw) return defaultChatId;
    const list: { code: string; chatId: string }[] = JSON.parse(raw);
    const found = list.find((item) => item.code.toLowerCase() === classCode.toLowerCase());
    return found?.chatId || defaultChatId;
  } catch {
    return defaultChatId;
  }
}

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

function rankInfo(v: number | null) {
  if (v == null) return { label: "—",         color: "#6b7280", bg: "#f3f4f6", border: "#e5e7eb" };
  if (v >= 90)   return { label: "Xuất sắc",  color: "#065f46", bg: "#d1fae5", border: "#6ee7b7" };
  if (v >= 80)   return { label: "Giỏi",      color: "#166534", bg: "#dcfce7", border: "#86efac" };
  if (v >= 65)   return { label: "Khá",       color: "#92400e", bg: "#fef9c3", border: "#fde68a" };
  if (v >= 50)   return { label: "Trung bình",color: "#9a3412", bg: "#ffedd5", border: "#fdba74" };
  return           { label: "Yếu",            color: "#991b1b", bg: "#fee2e2", border: "#fca5a5" };
}

function mkBar(label: string, v: number | null): string {
  if (v == null) return "";
  const pct = Math.min(100, Math.max(0, v));
  const c = v >= 80 ? "#16a34a" : v >= 60 ? "#d97706" : "#dc2626";
  return `<div style="margin-bottom:9px">
    <div style="display:flex;justify-content:space-between;font-size:.82em;margin-bottom:3px;color:#4b5563">
      <span>${label}</span><b style="color:${c}">${v}</b>
    </div>
    <div style="background:#e5e7eb;border-radius:4px;height:8px">
      <div style="height:100%;border-radius:4px;background:${c};width:${pct}%"></div>
    </div>
  </div>`;
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

  // Word score list (reading)
  const wordList = taskName === "reading"
    ? (Array.isArray(sp?.text_score?.word_score_list) ? sp.text_score.word_score_list : [])
    : [];
  const weakest = wordList
    .filter((w: any) => Number.isFinite(w?.quality_score))
    .sort((a: any, b: any) => a.quality_score - b.quality_score)
    .slice(0, 10);

  // Reference text
  const refText = sp?.text_score?.text ?? result?.text ?? "";

  // Relevance extras
  const relevanceObj = (sp?.speech_score?.relevance ?? sp?.relevance ?? null) as any;
  const relevanceClass = result?.relevanceClass ?? relevanceObj?.class ?? null;
  const relevanceScore = result?.relevanceScore ?? relevanceObj?.score ?? null;
  const relevanceContext = result?.relevanceContext ?? "";

  // Gemini cross-check
  const geminiRelevance = result?.geminiRelevance ?? null;
  const geminiReason = result?.geminiReason ?? "";

  // IELTS, CEFR, PTE, TOEIC
  const ielts = sp?.speech_score?.ielts_score ?? sp?.text_score?.ielts_score ?? null;
  const cefr = sp?.speech_score?.cefr_score ?? sp?.text_score?.cefr_score ?? null;
  const pte = sp?.speech_score?.pte_score ?? sp?.text_score?.pte_score ?? null;
  const toeic = sp?.speech_score?.toeic_score ?? sp?.text_score?.toeic_score ?? null;

  // ── TXT lines ──
  const txtLines: string[] = [];
  txtLines.push(`===== ${label} =====`);
  txtLines.push(`Overall: ${overall ?? "n/a"}`);
  txtLines.push(`Pronunciation: ${pron ?? "n/a"}`);
  txtLines.push(`Fluency: ${flu ?? "n/a"}`);
  txtLines.push(`Grammar: ${gra ?? "n/a"}`);
  txtLines.push(`Coherence: ${coh ?? "n/a"}`);
  txtLines.push(`Vocab: ${voc ?? "n/a"}`);
  if (ielts) txtLines.push(`IELTS: ${JSON.stringify(ielts)}`);
  if (cefr) txtLines.push(`CEFR: ${JSON.stringify(cefr)}`);
  if (taskName === "relevance") {
    txtLines.push(`Relevance Class: ${relevanceClass ?? "n/a"}`);
    txtLines.push(`Relevance Score: ${relevanceScore ?? "n/a"}`);
    if (relevanceContext) txtLines.push(`Context: ${relevanceContext}`);
    if (geminiRelevance != null) txtLines.push(`Gemini: ${geminiRelevance ? "TRUE" : "FALSE"} – ${geminiReason}`);
  }
  if (weakest.length) {
    txtLines.push(`Weakest words: ${weakest.map((w: any) => `${w.word}(${w.quality_score})`).join(", ")}`);
  }
  if (audioUrl) txtLines.push(`Audio URL: ${audioUrl}`);
  if (refText) txtLines.push(`Reference text: ${refText}`);
  if (transcript) txtLines.push(`Transcript: ${transcript}`);
  txtLines.push("");

  // ── HTML block ──
  const rk = rankInfo(overall);

  const audioBtn = audioUrl
    ? `<a href="${csvEscape(audioUrl)}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:#2563eb;color:#fff;padding:8px 18px;border-radius:24px;font-size:.88em;font-weight:700;text-decoration:none;box-shadow:0 2px 8px rgba(37,99,235,.3)">🔊 Nghe lại audio</a>`
    : `<span style="color:#9ca3af;font-size:.85em;font-style:italic">Chưa có audio</span>`;

  const metricBars = [
    pron != null ? mkBar("🎯 Pronunciation", pron) : "",
    flu  != null ? mkBar("🗣 Fluency",        flu)  : "",
    gra  != null ? mkBar("📝 Grammar",        gra)  : "",
    coh  != null ? mkBar("💡 Coherence",      coh)  : "",
    voc  != null ? mkBar("📖 Vocab",          voc)  : "",
  ].filter(Boolean).join("");

  const stdBadges = [
    ielts  ? `<span style="background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd;border-radius:12px;padding:2px 10px;font-size:.78em;font-weight:700">IELTS: ${typeof ielts === "object" ? JSON.stringify(ielts) : ielts}</span>`   : "",
    cefr   ? `<span style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;border-radius:12px;padding:2px 10px;font-size:.78em;font-weight:700">CEFR: ${typeof cefr === "object" ? JSON.stringify(cefr) : cefr}</span>`     : "",
    pte    ? `<span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:12px;padding:2px 10px;font-size:.78em;font-weight:700">PTE: ${typeof pte === "object" ? JSON.stringify(pte) : pte}</span>`          : "",
    toeic  ? `<span style="background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:12px;padding:2px 10px;font-size:.78em;font-weight:700">TOEIC: ${typeof toeic === "object" ? JSON.stringify(toeic) : toeic}</span>` : "",
  ].filter(Boolean).join(" ");

  const wordChips = weakest.map((w: any) => {
    const q = w.quality_score;
    const cc = q < 30
      ? { bg: "#fee2e2", c: "#991b1b", bd: "#fca5a5" }
      : q < 60
        ? { bg: "#fef9c3", c: "#92400e", bd: "#fde68a" }
        : { bg: "#dcfce7", c: "#166534", bd: "#86efac" };
    return `<span style="display:inline-block;background:${cc.bg};color:${cc.c};border:1px solid ${cc.bd};border-radius:20px;padding:3px 10px;font-size:.82em;margin:3px 3px 3px 0;font-weight:600">${csvEscape(w.word)} <b>${q}</b></span>`;
  }).join("");

  const allWordChips = wordList.length > 0
    ? wordList.filter((w: any) => w?.word).slice(0, 50).map((w: any) => {
        const q: number | null = w.quality_score ?? null;
        const cc = q == null
          ? { bg: "#f3f4f6", c: "#6b7280", bd: "#e5e7eb" }
          : q < 30  ? { bg: "#fee2e2", c: "#991b1b", bd: "#fca5a5" }
          : q < 60  ? { bg: "#fef9c3", c: "#92400e", bd: "#fde68a" }
          :           { bg: "#dcfce7", c: "#166534", bd: "#86efac" };
        return `<span style="display:inline-block;background:${cc.bg};color:${cc.c};border:1px solid ${cc.bd};border-radius:16px;padding:2px 9px;font-size:.76em;margin:2px;font-weight:600">${csvEscape(w.word)}${q != null ? ` <b>${q}</b>` : ""}</span>`;
      }).join("")
    : "";

  let html = `<div style="border:2px solid ${rk.border};border-radius:14px;overflow:hidden;margin-bottom:24px;box-shadow:0 2px 14px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:14px 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div style="color:#fff;font-size:1.08em;font-weight:800;letter-spacing:.2px">${label}</div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="font-size:2.5em;font-weight:900;color:#fff;line-height:1;text-shadow:0 2px 4px rgba(0,0,0,.25)">${overall ?? "—"}</div>
      <div style="background:${rk.bg};color:${rk.color};border:2px solid ${rk.border};border-radius:20px;padding:4px 14px;font-size:.82em;font-weight:800">${rk.label}</div>
    </div>
  </div>
  <div style="padding:18px 22px 10px;background:#fff">
    ${metricBars || `<div style="color:#9ca3af;font-style:italic;font-size:.88em;padding:8px 0">Chưa có điểm chi tiết</div>`}
    ${stdBadges ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">${stdBadges}</div>` : ""}
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #f0f0f0">${audioBtn}</div>
  </div>`;

  if (taskName === "relevance") {
    const relOk = String(relevanceClass).toUpperCase() === "TRUE";
    html += `<div style="margin:0 22px 16px;padding:14px;background:#f8faff;border-radius:10px;border:1px solid #e0e7ff">
    <div style="font-weight:700;color:#1e3a5f;margin-bottom:8px;font-size:.9em">🎯 Relevance Analysis</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="background:${relOk ? "#dcfce7" : "#fee2e2"};color:${relOk ? "#16a34a" : "#dc2626"};border-radius:20px;padding:4px 16px;font-weight:800;font-size:.9em">${csvEscape(relevanceClass ?? "n/a")}</span>
      ${relevanceScore != null ? `<span style="color:#6b7280;font-size:.88em">Score: <b style="color:#374151">${relevanceScore}</b></span>` : ""}
      ${geminiRelevance != null ? `<span style="background:#ede9fe;color:#5b21b6;border-radius:20px;padding:4px 12px;font-size:.82em;font-weight:700">🤖 Gemini: ${geminiRelevance ? "TRUE" : "FALSE"}</span>` : ""}
    </div>
    ${relevanceContext ? `<div style="margin-top:8px;font-size:.82em;color:#6b7280">Context: ${csvEscape(relevanceContext)}</div>` : ""}
    ${geminiReason ? `<div style="margin-top:6px;font-size:.82em;color:#6b7280">AI reason: ${csvEscape(geminiReason)}</div>` : ""}
  </div>`;
  }

  if (refText) {
    html += `<div style="margin:0 22px 16px">
    <div style="font-size:.78em;font-weight:700;color:#1d4ed8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">📖 Reference Text</div>
    <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:12px 14px;font-size:.88em;line-height:1.75;color:#1e3a5f;white-space:pre-wrap">${csvEscape(refText)}</div>
  </div>`;
  }

  if (transcript) {
    html += `<div style="margin:0 22px 16px">
    <div style="font-size:.78em;font-weight:700;color:#15803d;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">🎙 Transcript</div>
    <div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:0 8px 8px 0;padding:12px 14px;font-size:.88em;line-height:1.75;color:#14532d;white-space:pre-wrap">${csvEscape(transcript)}</div>
  </div>`;
  }

  if (weakest.length) {
    html += `<div style="margin:0 22px 16px">
    <div style="font-size:.78em;font-weight:700;color:#dc2626;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">⚠️ Từ phát âm yếu nhất</div>
    <div style="line-height:2.2">${wordChips}</div>
  </div>`;
  }

  if (wordList.length > 0) {
    html += `<div style="margin:0 22px 20px">
    <details>
      <summary style="cursor:pointer;font-size:.82em;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;padding:6px 0">📊 Tất cả từ (${wordList.length} từ) — nhấn để mở rộng</summary>
      <div style="margin-top:8px;line-height:2.2">${allWordChips}${wordList.length > 50 ? `<span style="color:#9ca3af;font-size:.78em"> ... và ${wordList.length - 50} từ nữa</span>` : ""}</div>
    </details>
  </div>`;
  }

  html += `</div>`;

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

  // ── Compute avg overall for overview ──
  const overallScores = taskResultsList.map((tr) => {
    const sp = tr.result?.speechace;
    const v = tr.task === "reading"
      ? sp?.text_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? tr.result?.overall
      : sp?.speech_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? tr.result?.overall;
    return v ?? null;
  }).filter((v): v is number => v != null);
  const avgOverall = overallScores.length
    ? Math.round(overallScores.reduce((a: number, b: number) => a + b, 0) / overallScores.length)
    : null;
  const avgRk = rankInfo(avgOverall);

  const overviewCards = taskResultsList.map((tr) => {
    const sp = tr.result?.speechace;
    const ovr = (tr.task === "reading"
      ? sp?.text_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? tr.result?.overall
      : sp?.speech_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? tr.result?.overall) ?? null;
    const trk = rankInfo(ovr as number | null);
    const lbl = TASK_LABELS[tr.task] || tr.task.toUpperCase();
    return `<div style="flex:1;min-width:130px;background:${trk.bg};border:2px solid ${trk.border};border-radius:12px;padding:14px 16px;text-align:center">
      <div style="font-size:.72em;font-weight:700;color:#374151;margin-bottom:6px">${lbl}</div>
      <div style="font-size:2.2em;font-weight:900;color:${trk.color};line-height:1">${ovr ?? "—"}</div>
      <div style="font-size:.74em;color:${trk.color};font-weight:700;margin-top:4px">${trk.label}</div>
    </div>`;
  }).join("");

  const html = `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Báo cáo – ${csvEscape(p.fullName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#eef2f7;padding:20px;min-height:100vh;color:#1f2937}
.wrap{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.10);overflow:hidden;max-width:880px;margin:0 auto}
.hdr{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;padding:28px 32px}
.ex-section h3{font-size:1em;font-weight:800;color:#1e3a5f;margin:14px 0 6px}
.ex-section h4{font-size:.9em;font-weight:700;color:#374151;margin:12px 0 4px}
.ex-section table{border-collapse:collapse;width:100%;margin:6px 0 14px}
.ex-section td,.ex-section th{border:1px solid #e5e7eb;padding:8px 10px;vertical-align:top;font-size:.88em}
.ex-section th{background:#f1f5f9;color:#374151;font-weight:700;text-align:left}
.ex-section pre{white-space:pre-wrap;background:#f8faff;border:1px solid #e0e7ff;border-radius:8px;padding:10px;font-size:.85em}
.ex-section hr{border:0;border-top:1px solid #e5e7eb;margin:14px 0}
.ex-section small{color:#6b7280;font-weight:normal}
details summary{cursor:pointer;user-select:none}
</style>
</head><body>
<div class="wrap">

  <div class="hdr">
    <div style="font-size:1.65em;font-weight:900;letter-spacing:-.5px;margin-bottom:14px">📋 Báo cáo kết quả</div>
    <table style="border-collapse:collapse;width:100%;font-size:.93em">
      <tr>
        <td style="padding:4px 14px 4px 0;opacity:.7;font-size:.85em;white-space:nowrap">👤 Học viên</td>
        <td style="font-weight:800;font-size:1.08em;color:#fff;padding-right:24px">${csvEscape(p.fullName || "—")}</td>
        <td style="padding:4px 14px 4px 0;opacity:.7;font-size:.85em;white-space:nowrap">🏫 Lớp</td>
        <td style="font-weight:700;color:#fff">${csvEscape(p.classCode || "—")}</td>
      </tr>
      <tr>
        <td style="padding:4px 14px 4px 0;opacity:.7;font-size:.85em">📧 Email</td>
        <td style="color:rgba(255,255,255,.9);padding-right:24px">${csvEscape(p.email || "—")}</td>
        <td style="padding:4px 14px 4px 0;opacity:.7;font-size:.85em">🗣 Dialect</td>
        <td style="color:rgba(255,255,255,.9)">${csvEscape(p.dialect || "—")}</td>
      </tr>
      <tr>
        <td style="padding:4px 14px 4px 0;opacity:.7;font-size:.85em">⏱ Nộp lúc</td>
        <td colspan="3" style="color:rgba(255,255,255,.85)">${new Date().toLocaleString("vi-VN")}</td>
      </tr>
    </table>
  </div>

  <div style="padding:20px 28px 22px;background:#f8faff;border-bottom:1px solid #e5e7eb">
    <div style="font-size:.72em;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Tổng quan kết quả</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div style="background:${avgRk.bg};border:2px solid ${avgRk.border};border-radius:14px;padding:16px 20px;text-align:center;min-width:110px">
        <div style="font-size:.7em;font-weight:700;color:#374151;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">TB tổng</div>
        <div style="font-size:2.7em;font-weight:900;color:${avgRk.color};line-height:1">${avgOverall ?? "—"}</div>
        <div style="background:${avgRk.border};color:${avgRk.color};font-size:.73em;font-weight:800;margin-top:6px;border-radius:10px;padding:2px 10px;display:inline-block">${avgRk.label}</div>
      </div>
      <div style="display:flex;flex:1;gap:10px;flex-wrap:wrap;align-items:flex-start">
        ${overviewCards}
      </div>
    </div>
  </div>

  <div style="padding:24px 28px">
    ${htmlScoreBlocks.join("")}
  </div>

  ${exHtmlBlocks.length > 0 ? `<div style="padding:0 28px 28px">
    <div style="border-top:2px solid #e5e7eb;padding-top:20px">
      <div style="font-size:.72em;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">📝 Bài tập</div>
      <div class="ex-section" style="background:#f8faff;border-radius:12px;padding:18px 22px">${exHtmlBlocks.join("")}</div>
    </div>
  </div>` : ""}

</div>
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

    // ===== Xác định chat ID theo lớp =====
    const classChatId = resolveClassChatId(payload.classCode, chatId);
    const adminChatId = process.env.ADMIN_CHAT_ID || ""; // admin nhận bản sao (tuỳ chọn)

    // ✅ Xác định danh sách task results
    const taskResultsList: TaskResultEntry[] =
      Array.isArray(payload.taskResults) && payload.taskResults.length > 0
        ? payload.taskResults
        : payload.task && payload.result
          ? [{ task: payload.task, result: payload.result, audioUrl: payload.audioUrl ?? null }]
          : [];

    // ✅ Telegram summary message
    const completedParts = taskResultsList.map((t) => TASK_LABELS[t.task] || t.task).join(", ");
    const summaryLines: string[] = [];
    summaryLines.push(`📌 Bài nộp mới`);
    summaryLines.push(`🎫 Lớp: ${payload.classCode || "(chưa chọn)"}`);
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

    await tgSendMessage(token, classChatId, summaryLines.join("\n"));
    // CC cho admin nếu có ADMIN_CHAT_ID (và khác classChatId)
    if (adminChatId && adminChatId !== classChatId) {
      await tgSendMessage(token, adminChatId, summaryLines.join("\n")).catch(() => {});
    }

    const rep = buildReports(payload);
    await tgSendDocument(token, classChatId, new Blob([rep.html], { type: "text/html" }), "report.html", "Report (HTML)");
    await tgSendDocument(token, classChatId, new Blob([rep.csv], { type: "text/csv" }), "report.csv", "Report (CSV)");
    await tgSendDocument(token, classChatId, new Blob([rep.txt], { type: "text/plain" }), "report.txt", "Report (TXT)");

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
            classChatId,
            new Blob([ab], { type: ct }),
            `audio_${label}.${ext}`,
            `🔊 Audio – ${TASK_LABELS[tr.task] || tr.task}`
          );
        }
      } catch {
        // ignore
      }
    }

    // ===== Lưu điểm vào R2 để tổng hợp theo lớp =====
    if (payload.classCode) {
      try {
        const entry = {
          submittedAt: new Date().toISOString(),
          fullName: payload.fullName,
          email: payload.email,
          classCode: payload.classCode,
          dialect: payload.dialect,
          tasks: taskResultsList.map((tr) => {
            const sp = tr.result?.speechace;
            const scoreObj =
              tr.task === "reading"
                ? sp?.text_score?.speechace_score ?? sp?.speechace_score ?? null
                : sp?.speech_score?.speechace_score ?? sp?.speechace_score ?? null;
            // Thử nhiều đường dẫn vì SpeechAce trả về cấu trúc khác nhau
            const overall =
              tr.task === "reading"
                ? sp?.text_score?.speechace_score?.overall
                  ?? sp?.text_score?.speechace_score?.quality_score
                  ?? sp?.text_score?.quality_score
                  ?? sp?.speechace_score?.overall
                  ?? tr.result?.overall
                  ?? null
                : sp?.speech_score?.speechace_score?.overall
                  ?? sp?.speech_score?.quality_score
                  ?? sp?.speechace_score?.overall
                  ?? tr.result?.overall
                  ?? null;
            return {
              task: tr.task,
              overall: overall ?? null,
              pronunciation: scoreObj?.pronunciation ?? null,
              fluency: scoreObj?.fluency ?? null,
              grammar: scoreObj?.grammar ?? null,
              coherence: scoreObj?.coherence ?? null,
              vocab: scoreObj?.vocab ?? null,
              // Lưu R2 key để tạo URL mới khi xuất báo cáo (presigned URL hết hạn sau 60s)
              audioKey: (tr.result?.audioKey as string | undefined) ?? null,
              audioUrl: tr.audioUrl ?? null,
            };
          }),
        };
        const safeEmail = payload.email.replace(/[^a-zA-Z0-9@._-]/g, "_");
        await r2Client().send(
          new PutObjectCommand({
            Bucket: r2Bucket(),
            Key: `class-results/${payload.classCode}/${Date.now()}_${safeEmail}.json`,
            Body: JSON.stringify(entry),
            ContentType: "application/json",
          })
        );
      } catch {
        // Không làm hỏng flow chính nếu lưu R2 thất bại
      }
    }

    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Send failed" }, { status: 500 });
  }
}