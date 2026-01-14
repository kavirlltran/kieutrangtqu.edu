export const runtime = "nodejs";
export const maxDuration = 30;

function clampText(s: string, max = 80) {
  const t = (s || "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const text = clampText(String(body?.text || ""));
    const from = String(body?.from || "en");
    const to = String(body?.to || "vi");

    if (!text) {
      return Response.json({ ok: false, error: "Missing text" }, { status: 400 });
    }

    // Free endpoint (rate-limited). Docs: https://mymemory.translated.net/doc/spec.php
    const url =
      "https://api.mymemory.translated.net/get" +
      `?q=${encodeURIComponent(text)}` +
      `&langpair=${encodeURIComponent(`${from}|${to}`)}`;

    const r = await fetch(url, { method: "GET" });
    const j: any = await r.json().catch(() => null);

    const translation = String(j?.responseData?.translatedText || "").trim();

    if (!r.ok) {
      return Response.json(
        { ok: false, error: j?.responseDetails || j?.error || "Translate error", raw: j },
        { status: 400 }
      );
    }

    return Response.json({
      ok: true,
      provider: "mymemory",
      text,
      from,
      to,
      translation: translation || "",
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
