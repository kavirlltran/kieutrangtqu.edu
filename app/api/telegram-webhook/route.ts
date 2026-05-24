export const runtime = "nodejs";

import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client, r2Bucket } from "@/lib/r2";

const TASK_LABELS: Record<string, string> = {
  reading: "📚 Reading",
  "open-ended": "💬 Open-ended",
  relevance: "🎯 Relevance",
};

async function streamToText(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function tgSend(token: string, chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgSendDoc(
  token: string,
  chatId: string | number,
  blob: Blob,
  filename: string,
  caption: string
) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("document", blob, filename);
  await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: fd,
  });
}

function fmt(v: number | null) {
  return v != null ? String(v) : "—";
}

function esc(v: any) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Tạo presigned URL mới với hạn 7 ngày từ R2 key
async function getFreshAudioUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  try {
    return await getSignedUrl(
      r2Client(),
      new GetObjectCommand({ Bucket: r2Bucket(), Key: key }),
      { expiresIn: 7 * 24 * 3600 }
    );
  } catch {
    return null;
  }
}

// Trích xuất R2 key từ presigned URL (fallback nếu audioKey không lưu)
function extractKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    const clean = path.startsWith("/") ? path.slice(1) : path;
    return clean.startsWith("uploads/") ? clean : null;
  } catch {
    return null;
  }
}

function scoreColor(v: number | null) {
  if (v == null) return "#9ca3af";
  if (v >= 80) return "#16a34a";
  if (v >= 60) return "#d97706";
  return "#dc2626";
}

function scoreBg(v: number | null) {
  if (v == null) return "#f9fafb";
  if (v >= 80) return "#dcfce7";
  if (v >= 60) return "#fef9c3";
  return "#fee2e2";
}

async function buildClassReport(classCode: string) {
  const client = r2Client();
  const bucket = r2Bucket();

  const list = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `class-results/${classCode}/`,
      MaxKeys: 500,
    })
  );

  const keys = (list.Contents || []).map((o) => o.Key!).filter(Boolean);
  if (!keys.length) return null;

  const results: any[] = [];
  for (const key of keys) {
    try {
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (obj.Body) results.push(JSON.parse(await streamToText(obj.Body)));
    } catch { /* bỏ qua file lỗi */ }
  }

  results.sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime());

  const taskTypes = [
    ...new Set(results.flatMap((r) => r.tasks.map((t: any) => t.task))),
  ] as string[];

  // Tạo fresh audio URL cho tất cả học viên
  for (const r of results) {
    for (const t of r.tasks) {
      const key = t.audioKey ?? extractKeyFromUrl(t.audioUrl);
      t.freshAudioUrl = await getFreshAudioUrl(key);
    }
  }

  // Điểm trung bình lớp
  const avg: Record<string, number | null> = {};
  for (const t of taskTypes) {
    const vals = results
      .flatMap((r) => r.tasks.filter((x: any) => x.task === t).map((x: any) => x.overall))
      .filter((v: any) => v != null) as number[];
    avg[t] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }

  // Phân loại học sinh (dựa trên điểm TB của học sinh)
  const classLevels = [
    { label: "Xuất sắc",   color: "#065f46", bg: "#d1fae5", border: "#6ee7b7", min: 90 },
    { label: "Giỏi",       color: "#166534", bg: "#dcfce7", border: "#86efac", min: 80 },
    { label: "Khá",        color: "#92400e", bg: "#fef9c3", border: "#fde68a", min: 65 },
    { label: "Trung bình", color: "#9a3412", bg: "#ffedd5", border: "#fdba74", min: 50 },
    { label: "Yếu",        color: "#991b1b", bg: "#fee2e2", border: "#fca5a5", min: 0  },
  ];
  const studentAvgScores = results.map((r: any) => {
    const vals = r.tasks.map((t: any) => t.overall).filter((v: any) => v != null) as number[];
    return vals.length ? Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length) : null;
  });
  const classCount = [0, 0, 0, 0, 0];
  let classifiedCount = 0;
  for (const v of studentAvgScores) {
    if (v == null) continue;
    classifiedCount++;
    if (v >= 90)      classCount[0]++;
    else if (v >= 80) classCount[1]++;
    else if (v >= 65) classCount[2]++;
    else if (v >= 50) classCount[3]++;
    else              classCount[4]++;
  }
  const classBreakdownHtml = classLevels.map((lv, idx) => {
    const count = classCount[idx];
    const pct = classifiedCount > 0 ? Math.round((count / classifiedCount) * 100) : 0;
    return `<div style="background:${lv.bg};border:1.5px solid ${lv.border};border-radius:10px;padding:12px 10px;text-align:center">
      <div style="font-size:.78em;font-weight:700;color:${lv.color};margin-bottom:5px">${lv.label}</div>
      <div style="font-size:1.9em;font-weight:900;color:${lv.color};line-height:1">${count}</div>
      <div style="font-size:.72em;color:${lv.color};opacity:.85;margin-top:3px">${pct}%</div>
      <div style="margin-top:6px;background:rgba(0,0,0,.1);border-radius:4px;height:5px;overflow:hidden">
        <div style="height:100%;border-radius:4px;background:${lv.color};width:${pct}%;opacity:.75"></div>
      </div>
    </div>`;
  }).join("");

  // ===== CSV =====
  const header = [
    "STT", "Họ tên", "Email", "Thời gian nộp",
    ...taskTypes.flatMap((t) => [
      `${TASK_LABELS[t] || t} - Overall`,
      `${TASK_LABELS[t] || t} - Pronunciation`,
      `${TASK_LABELS[t] || t} - Fluency`,
      `${TASK_LABELS[t] || t} - Grammar`,
      `${TASK_LABELS[t] || t} - Coherence`,
      `${TASK_LABELS[t] || t} - Vocab`,
      `${TASK_LABELS[t] || t} - Audio URL`,
    ]),
  ];

  const rows = results.map((r, i) => {
    const tm: Record<string, any> = {};
    for (const t of r.tasks) tm[t.task] = t;
    return [
      i + 1, r.fullName, r.email,
      new Date(r.submittedAt).toLocaleString("vi-VN"),
      ...taskTypes.flatMap((t) => [
        fmt(tm[t]?.overall),
        fmt(tm[t]?.pronunciation),
        fmt(tm[t]?.fluency),
        fmt(tm[t]?.grammar),
        fmt(tm[t]?.coherence),
        fmt(tm[t]?.vocab),
        tm[t]?.freshAudioUrl ?? tm[t]?.audioUrl ?? "",
      ]),
    ];
  });

  rows.push([
    "TB", "=== TRUNG BÌNH LỚP ===", "", "",
    ...taskTypes.flatMap((t) => [fmt(avg[t]), "", "", "", "", "", ""]),
  ]);

  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");

  // ===== HTML =====
  let tableRows = "";
  results.forEach((r, i) => {
    const tm: Record<string, any> = {};
    for (const t of r.tasks) tm[t.task] = t;

    const taskCells = taskTypes
      .map((t) => {
        const overall = tm[t]?.overall ?? null;
        const pron = tm[t]?.pronunciation ?? null;
        const flu = tm[t]?.fluency ?? null;
        const audio = tm[t]?.freshAudioUrl ?? null;
        return `<td style="padding:12px 10px;border:1px solid #e5e7eb;text-align:center;background:${scoreBg(overall)}">
  <div style="font-size:1.5em;font-weight:800;color:${scoreColor(overall)};line-height:1">${fmt(overall)}</div>
  <div style="font-size:0.72em;color:#6b7280;margin:4px 0">P: ${fmt(pron)} &nbsp; F: ${fmt(flu)}</div>
  ${audio
    ? `<a href="${esc(audio)}" target="_blank" style="display:inline-block;background:#2563eb;color:#fff;padding:4px 10px;border-radius:20px;font-size:0.78em;text-decoration:none;margin-top:2px">🔊 Nghe</a>`
    : `<span style="color:#d1d5db;font-size:0.8em">— chưa có audio —</span>`}
</td>`;
      })
      .join("");

    tableRows += `<tr style="background:${i % 2 === 0 ? "#fff" : "#f8faff"}">
  <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;color:#9ca3af;font-weight:600">${i + 1}</td>
  <td style="padding:10px;border:1px solid #e5e7eb;font-weight:700;color:#111827">${esc(r.fullName)}</td>
  <td style="padding:10px;border:1px solid #e5e7eb;color:#4b5563;font-size:0.88em">${esc(r.email)}</td>
  <td style="padding:10px;border:1px solid #e5e7eb;color:#6b7280;font-size:0.82em;white-space:nowrap">${new Date(r.submittedAt).toLocaleString("vi-VN")}</td>
  ${taskCells}
</tr>`;
  });

  // Dòng trung bình
  const avgCells = taskTypes
    .map(
      (t) =>
        `<td style="padding:12px;border:1px solid #e5e7eb;text-align:center;background:#fef3c7">
  <div style="font-size:1.4em;font-weight:800;color:${scoreColor(avg[t])}">${fmt(avg[t])}</div>
  <div style="font-size:0.72em;color:#92400e;margin-top:2px">Trung bình</div>
</td>`
    )
    .join("");

  const statsHtml = taskTypes
    .map(
      (t) => `<div style="text-align:center;min-width:80px">
  <div style="font-size:2em;font-weight:900;color:${scoreColor(avg[t])}">${fmt(avg[t])}</div>
  <div style="font-size:0.78em;color:#6b7280;margin-top:2px">${(TASK_LABELS[t] || t).replace(/[📚💬🎯] /, "")}</div>
</div>`
    )
    .join(`<div style="width:1px;background:#e5e7eb;margin:0 8px"></div>`);

  const thTask = taskTypes
    .map(
      (t) =>
        `<th style="padding:12px;background:#1e3a5f;color:#fff;border:1px solid #1e40af;text-align:center;font-size:0.95em">${TASK_LABELS[t] || t}<br/><span style="font-size:0.78em;opacity:0.75">Overall · Audio</span></th>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bảng điểm lớp ${classCode.toUpperCase()}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#eef2f7;padding:20px;min-height:100vh}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.10);overflow:hidden;max-width:1200px;margin:0 auto}
.header{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;padding:28px 32px}
.header h1{font-size:1.8em;font-weight:800;letter-spacing:-.5px}
.header p{opacity:.8;margin-top:6px;font-size:.93em}
.stats{display:flex;align-items:center;gap:0;padding:18px 32px;background:#f8faff;border-bottom:1px solid #e5e7eb;flex-wrap:wrap;row-gap:12px}
.classify{padding:18px 32px 22px;background:#fff;border-bottom:1px solid #e5e7eb}
.classify-grid{display:grid;grid-template-columns:repeat(5,minmax(80px,1fr));gap:10px;margin-top:10px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:560px}
.th-base{padding:12px;background:#374151;color:#fff;text-align:left;font-weight:600;border:1px solid #374151;white-space:nowrap}
.avg-row td{font-weight:700}
.legend{display:flex;gap:16px;padding:14px 32px;font-size:.83em;color:#6b7280;border-top:1px solid #e5e7eb;flex-wrap:wrap}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:middle}
</style>
</head><body>
<div class="card">

  <div class="header">
    <h1>📊 Bảng điểm lớp ${classCode.toUpperCase()}</h1>
    <p>Xuất lúc: ${new Date().toLocaleString("vi-VN")} &nbsp;•&nbsp; Tổng số học viên: <b>${results.length}</b></p>
  </div>

  <div class="stats">
    <div style="font-size:.82em;color:#6b7280;margin-right:16px;font-weight:600">Điểm TB toàn lớp:</div>
    ${statsHtml}
  </div>

  <div class="classify">
    <div style="font-size:.75em;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Phân loại học sinh</div>
    <div class="classify-grid">${classBreakdownHtml}</div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="th-base" style="text-align:center;width:48px">STT</th>
          <th class="th-base">Họ tên</th>
          <th class="th-base">Email</th>
          <th class="th-base" style="white-space:nowrap">Nộp lúc</th>
          ${thTask}
        </tr>
      </thead>
      <tbody>
        ${tableRows}
        <tr class="avg-row" style="background:#fffbeb">
          <td style="padding:10px;border:1px solid #e5e7eb;text-align:center">📈</td>
          <td colspan="3" style="padding:10px;border:1px solid #e5e7eb;color:#92400e;font-size:.92em">Điểm trung bình lớp</td>
          ${avgCells}
        </tr>
      </tbody>
    </table>
  </div>

  <div class="legend">
    <span><span class="dot" style="background:#065f46"></span>≥ 90 · Xuất sắc</span>
    <span><span class="dot" style="background:#16a34a"></span>80–89 · Giỏi</span>
    <span><span class="dot" style="background:#d97706"></span>65–79 · Khá</span>
    <span><span class="dot" style="background:#ea580c"></span>50–64 · Trung bình</span>
    <span><span class="dot" style="background:#dc2626"></span>&lt; 50 · Yếu</span>
    <span style="margin-left:auto;color:#9ca3af">Link audio có hiệu lực 7 ngày</span>
  </div>

</div>
</body></html>`;

  // Tin nhắn tóm tắt Telegram
  const classLevelNames = ["Xuất sắc", "Giỏi", "Khá", "Trung bình", "Yếu"];
  const classBreakdownLines = classLevelNames
    .map((lv, idx) => classCount[idx] > 0 ? `  ${lv}: ${classCount[idx]} HS` : null)
    .filter((x): x is string => x !== null);

  const summary = [
    `📊 KẾT QUẢ LỚP ${classCode.toUpperCase()}`,
    `📅 ${new Date().toLocaleString("vi-VN")}`,
    `👥 Số học viên đã nộp: ${results.length}`,
    ``,
    `📈 Điểm TB toàn lớp:`,
    ...taskTypes.map((t) => `  ${TASK_LABELS[t] || t}: ${fmt(avg[t])}`),
    ``,
    `🏆 Phân loại:`,
    ...classBreakdownLines,
    ``,
    `👤 Chi tiết:`,
    ...results.map((r: any, i: number) => {
      const parts = r.tasks
        .map(
          (t: any) =>
            `${(TASK_LABELS[t.task] || t.task).replace(/[📚💬🎯] /, "")}: ${fmt(t.overall)}`
        )
        .join(" | ");
      return `${i + 1}. ${r.fullName} — ${parts}`;
    }),
  ].join("\n");

  return { summary, csv, html };
}

export async function POST(req: Request) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token) return Response.json({ ok: false });

    const body = await req.json();
    const message = body?.message;
    if (!message?.text) return Response.json({ ok: true });

    const chatId = message.chat?.id;
    const text = String(message.text).trim();

    // Lệnh: /report 10A1
    const match = text.match(/^\/report(?:@\S+)?\s+(\S+)/i);
    if (!match) return Response.json({ ok: true });

    const classCode = match[1];
    await tgSend(token, chatId, `⏳ Đang tổng hợp kết quả lớp ${classCode}...`);

    const report = await buildClassReport(classCode);
    if (!report) {
      await tgSend(
        token,
        chatId,
        `❌ Chưa có dữ liệu cho lớp ${classCode}.\nHọc viên cần chọn đúng mã lớp khi nộp bài.`
      );
    } else {
      await tgSend(token, chatId, report.summary);
      await tgSendDoc(
        token, chatId,
        new Blob([report.html], { type: "text/html" }),
        `bang_diem_${classCode}.html`,
        `📊 Bảng điểm lớp ${classCode} — mở bằng trình duyệt để xem + nghe audio`
      );
      await tgSendDoc(
        token, chatId,
        new Blob([report.csv], { type: "text/csv" }),
        `bang_diem_${classCode}.csv`,
        `📊 Bảng điểm lớp ${classCode} — mở bằng Excel / Google Sheets`
      );
    }

    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message });
  }
}
