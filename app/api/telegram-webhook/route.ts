export const runtime = "nodejs";

import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
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

async function buildClassReport(classCode: string) {
  const client = r2Client();
  const bucket = r2Bucket();

  // Lấy danh sách file JSON của lớp từ R2
  const list = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `class-results/${classCode}/`,
      MaxKeys: 500,
    })
  );

  const keys = (list.Contents || []).map((o) => o.Key!).filter(Boolean);
  if (!keys.length) return null;

  // Đọc tất cả kết quả
  const results: any[] = [];
  for (const key of keys) {
    try {
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (obj.Body) results.push(JSON.parse(await streamToText(obj.Body)));
    } catch {
      /* bỏ qua file lỗi */
    }
  }

  // Sắp xếp theo thời gian nộp
  results.sort(
    (a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime()
  );

  // Lấy tất cả loại task hiện có
  const taskTypes = [
    ...new Set(results.flatMap((r) => r.tasks.map((t: any) => t.task))),
  ];

  // Tính điểm trung bình từng task
  const avg: Record<string, number | null> = {};
  for (const t of taskTypes) {
    const vals = results
      .flatMap((r) =>
        r.tasks.filter((x: any) => x.task === t).map((x: any) => x.overall)
      )
      .filter((v: any) => v != null) as number[];
    avg[t] =
      vals.length
        ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
        : null;
  }

  // ===== Tạo CSV =====
  const header = [
    "STT",
    "Họ tên",
    "Email",
    "Thời gian nộp",
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
      i + 1,
      r.fullName,
      r.email,
      new Date(r.submittedAt).toLocaleString("vi-VN"),
      ...taskTypes.flatMap((t) => [
        fmt(tm[t]?.overall),
        fmt(tm[t]?.pronunciation),
        fmt(tm[t]?.fluency),
        fmt(tm[t]?.grammar),
        fmt(tm[t]?.coherence),
        fmt(tm[t]?.vocab),
        tm[t]?.audioUrl || "",
      ]),
    ];
  });

  // Dòng trung bình lớp cuối CSV
  rows.push([
    "TB",
    "=== TRUNG BÌNH LỚP ===",
    "",
    "",
    ...taskTypes.flatMap((t) => [fmt(avg[t]), "", "", "", "", "", ""]),
  ]);

  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");

  // ===== Tạo HTML =====
  const thStyle = `style="background:#1e3a5f;color:#fff;padding:8px;text-align:center"`;
  const tdStyle = `style="padding:8px;text-align:center;border:1px solid #ddd"`;

  let htmlTable = `<!doctype html><html><head><meta charset="utf-8"/>
<title>Bảng điểm lớp ${classCode}</title>
<style>
body{font-family:Arial,sans-serif;padding:20px}
h2{color:#1e3a5f}
table{border-collapse:collapse;width:100%;margin-top:12px}
th{background:#1e3a5f;color:#fff;padding:8px;text-align:center}
td{padding:8px;text-align:center;border:1px solid #ddd}
tr:nth-child(even){background:#f5f9ff}
.avg{background:#fff3cd;font-weight:bold}
.good{color:#16a34a;font-weight:bold}
.warn{color:#d97706;font-weight:bold}
.bad{color:#dc2626;font-weight:bold}
</style></head><body>
<h2>📊 Bảng điểm lớp ${classCode.toUpperCase()}</h2>
<p>Ngày xuất: ${new Date().toLocaleString("vi-VN")} &nbsp;|&nbsp; Số học viên: ${results.length}</p>
<p><b>Điểm TB toàn lớp:</b> ${taskTypes.map((t) => `${TASK_LABELS[t] || t}: <b>${fmt(avg[t])}</b>`).join(" &nbsp;|&nbsp; ")}</p>
<table>
<tr>
  <th>STT</th><th>Họ tên</th><th>Email</th><th>Nộp lúc</th>
  ${taskTypes
    .map(
      (t) =>
        `<th colspan="2">${TASK_LABELS[t] || t}</th>`
    )
    .join("")}
</tr>
<tr>
  <th></th><th></th><th></th><th></th>
  ${taskTypes.map(() => `<th>Overall</th><th>Audio</th>`).join("")}
</tr>
`;

  results.forEach((r, i) => {
    const tm: Record<string, any> = {};
    for (const t of r.tasks) tm[t.task] = t;
    const scoreColor = (v: number | null) =>
      v == null ? "" : v >= 80 ? "good" : v >= 60 ? "warn" : "bad";

    htmlTable += `<tr>
  <td>${i + 1}</td>
  <td style="text-align:left"><b>${esc(r.fullName)}</b></td>
  <td style="text-align:left;font-size:0.85em">${esc(r.email)}</td>
  <td style="font-size:0.8em">${new Date(r.submittedAt).toLocaleString("vi-VN")}</td>
  ${taskTypes
    .map((t) => {
      const overall = tm[t]?.overall ?? null;
      const audio = tm[t]?.audioUrl || "";
      return `<td class="${scoreColor(overall)}">${fmt(overall)}</td>
  <td>${audio ? `<a href="${esc(audio)}">🔊</a>` : "—"}</td>`;
    })
    .join("")}
</tr>`;
  });

  // Dòng trung bình
  htmlTable += `<tr class="avg">
  <td colspan="4"><b>📈 Trung bình lớp</b></td>
  ${taskTypes.map((t) => `<td><b>${fmt(avg[t])}</b></td><td>—</td>`).join("")}
</tr>`;

  htmlTable += `</table></body></html>`;

  // ===== Tin nhắn tóm tắt Telegram =====
  const summary = [
    `📊 KẾT QUẢ LỚP ${classCode.toUpperCase()}`,
    `📅 ${new Date().toLocaleString("vi-VN")}`,
    `👥 Số học viên đã nộp: ${results.length}`,
    ``,
    `📈 Điểm TB toàn lớp:`,
    ...taskTypes.map((t) => `  ${TASK_LABELS[t] || t}: ${fmt(avg[t])}`),
    ``,
    `👤 Chi tiết:`,
    ...results.map((r, i) => {
      const parts = r.tasks
        .map(
          (t: any) =>
            `${(TASK_LABELS[t.task] || t.task).replace(/[📚💬🎯] /, "")}: ${fmt(t.overall)}`
        )
        .join(" | ");
      return `${i + 1}. ${r.fullName} — ${parts}`;
    }),
  ].join("\n");

  return { summary, csv, html: htmlTable };
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
    const match = text.match(/^\/report\s+(\S+)/i);
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
        token,
        chatId,
        new Blob([report.html], { type: "text/html" }),
        `bang_diem_${classCode}.html`,
        `📊 Bảng điểm chi tiết lớp ${classCode} (HTML)`
      );
      await tgSendDoc(
        token,
        chatId,
        new Blob([report.csv], { type: "text/csv" }),
        `bang_diem_${classCode}.csv`,
        `📊 Bảng điểm chi tiết lớp ${classCode} (CSV)`
      );
    }

    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message });
  }
}
