// app/page.tsx
"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_PASSAGES, Passage, USER_PASSAGES_STORAGE_KEY } from "@/lib/passages";
import { DIALECTS, Dialect } from "@/lib/dialects";
import { getWordScoreList, timingFromItem, WordDisplay } from "@/lib/speechace";
import { startWavRecorder } from "@/lib/wav-recorder";

type Task = "reading" | "open-ended" | "relevance";
type Mode = "library" | "custom";

type Token =
  | { kind: "space"; text: string }
  | { kind: "punct"; text: string }
  | { kind: "word"; text: string; attach: WordDisplay | null };

type WordTiming = { startSec: number; endSec: number };

type TaskUiState = {
  result: any | null;
  err: string | null;
  audioUrl: string | null;
  audioUrlAt: number | null;
  uploadedFile: File | null;
};

type HistoryEntry = {
  id: string;
  ts: number; // Date.now()
  task: Task;
  dialect: Dialect;

  overall: number | null;
  pronunciation: number | null;
  fluency: number | null;
  grammar: number | null;
  coherence: number | null;
  vocab: number | null;

  relevanceClass?: string | null;
  relevanceScore?: number | null;
  relevanceExtra?: Record<string, any> | null;

  transcript?: string | null;

  prompt?: string | null;
  relevanceContext?: string | null;
  referenceWords?: number | null;
};

const HISTORY_STORAGE_KEY = "speechace_history_v1";
const HISTORY_MAX = 200;

function safeNum(v: any): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryEntry[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
  } catch {}
}

function pushHistory(entry: HistoryEntry) {
  const cur = loadHistory();
  saveHistory([entry, ...cur].slice(0, HISTORY_MAX));
}

function dayKey(ts: number) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isoWeekKey(ts: number) {
  const d = new Date(ts);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function avg(nums: (number | null | undefined)[]) {
  const xs = nums.filter((x) => typeof x === "number" && Number.isFinite(x)) as number[];
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function groupHistory(
  items: HistoryEntry[],
  bucket: "day" | "week",
  taskFilter: Task | "all",
  metric: keyof Pick<
    HistoryEntry,
    "overall" | "pronunciation" | "fluency" | "grammar" | "coherence" | "vocab" | "relevanceScore"
  >
) {
  const keyer = bucket === "day" ? dayKey : isoWeekKey;
  const filtered = taskFilter === "all" ? items : items.filter((x) => x.task === taskFilter);

  const map = new Map<string, HistoryEntry[]>();
  for (const it of filtered) {
    const k = keyer(it.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }

  const labels = Array.from(map.keys()).sort();
  return labels.map((k) => {
    const group = map.get(k)!;
    const v = avg(group.map((g) => (g as any)[metric]));
    return { label: k, value: v };
  });
}

function wordsCount(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function pickRecorderMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) {
    // @ts-ignore
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return "";
}

function hasMediaRecorder() {
  return typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined";
}

function normalizeWord(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .trim();
}

function qualityBand(q: number | null | undefined): "none" | "good" | "warn" | "bad" {
  if (q == null || !Number.isFinite(q)) return "none";
  if (q >= 85) return "good";
  if (q >= 70) return "warn";
  return "bad";
}

function formatPhonesForTooltip(w: WordDisplay) {
  // @ts-ignore
  if (!w?.phones?.length) return "";
  // @ts-ignore
  const parts = w.phones.slice(0, 10).map((p) => {
    const q = typeof p.quality === "number" ? Math.round(p.quality) : null;
    const sm = p.soundMostLike ? `→${p.soundMostLike}` : "";
    return `${p.phone}${q == null ? "" : `(${q})`}${sm}`;
  });
  return parts.join("  ");
}

/**
 * SpeechAce extent theo đơn vị 10ms (theo docs).
 * startSec = extent[0] * 0.01
 * endSec   = extent[1] * 0.01
 */
function timingFromPhoneExtents(phoneScoreList: any[]): WordTiming | null {
  if (!Array.isArray(phoneScoreList) || phoneScoreList.length < 1) return null;

  const first = phoneScoreList[0];
  const last = phoneScoreList[phoneScoreList.length - 1];

  const s = Array.isArray(first?.extent) ? first.extent : null;
  const e = Array.isArray(last?.extent) ? last.extent : null;

  if (!s || !e) return null;

  const start10ms = typeof s[0] === "number" ? s[0] : null;
  const end10ms = typeof e[1] === "number" ? e[1] : null;
  if (start10ms == null || end10ms == null) return null;

  const startSec = Math.max(0, start10ms * 0.01);
  const endSec = Math.max(startSec + 0.02, end10ms * 0.01);
  return { startSec, endSec };
}

/**
 * Build wordDisplays theo thứ tự words trong usedText.
 * Map tuần tự + lookahead để bớt lệch.
 * Timing ưu tiên từ phone_score_list[].extent (10ms), fallback timingFromItem().
 */
function buildWordDisplays(usedText: string, speechace: any): WordDisplay[] {
  const list = getWordScoreList(speechace) || [];
  if (!usedText?.trim() || !list.length) return [];

  const wordsInText = usedText.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?/g) || [];
  const out: WordDisplay[] = [];

  let j = 0;

  for (let i = 0; i < wordsInText.length; i++) {
    const raw = wordsInText[i];
    const norm = normalizeWord(raw);

    let picked: any | null = null;
    let pickedIndex = -1;

    for (let k = j; k < Math.min(list.length, j + 4); k++) {
      // FIX: WordScoreListItem không có text => chỉ dùng .word
      const candidateWord = normalizeWord(list[k]?.word || "");
      if (candidateWord && candidateWord === norm) {
        picked = list[k];
        pickedIndex = k;
        break;
      }
    }

    if (!picked) {
      picked = list[j] || null;
      pickedIndex = j;
    }

    if (pickedIndex >= j) j = pickedIndex + 1;

    const quality =
      typeof picked?.quality_score === "number"
        ? picked.quality_score
        : typeof picked?.quality === "number"
        ? picked.quality
        : typeof picked?.score === "number"
        ? picked.score
        : null;

    const phonesRaw = Array.isArray(picked?.phone_score_list) ? picked.phone_score_list : [];
    const phones = phonesRaw.map((p: any) => ({
      phone: String(p?.phone || p?.symbol || ""),
      quality:
        typeof p?.quality_score === "number"
          ? p.quality_score
          : typeof p?.quality === "number"
          ? p.quality
          : null,
      soundMostLike: p?.sound_most_like ? String(p.sound_most_like) : undefined,
      extent: Array.isArray(p?.extent) ? p.extent : null,
    }));

    const timingFromExtent = timingFromPhoneExtents(phonesRaw);
    const timing = (timingFromExtent || timingFromItem(picked) || null) as any;

    out.push({
      idx: i,
      word: raw,
      quality,
      phones,
      timing,
    } as any);
  }

  return out;
}

function tokenizeAndAttach(text: string, wordDisplays: WordDisplay[]): Token[] {
  const tokens: Token[] = [];
  if (!text) return tokens;

  let wi = 0;
  const re = /(\s+)|([A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?)|([^A-Za-z0-9\s]+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.push({ kind: "space", text: m[1] });
    else if (m[2]) {
      const attach = wordDisplays?.[wi] || null;
      tokens.push({ kind: "word", text: m[2], attach });
      wi++;
    } else if (m[3]) tokens.push({ kind: "punct", text: m[3] });
  }
  return tokens;
}

function Sparkline({
  data,
  height = 64,
}: {
  data: { label: string; value: number | null }[];
  height?: number;
}) {
  const w = 420;
  const h = height;

  const vals = data.map((d) => d.value).filter((v): v is number => typeof v === "number");
  if (!data.length || !vals.length) {
    return (
      <div className="muted" style={{ padding: 10 }}>
        Chưa đủ dữ liệu để vẽ biểu đồ.
      </div>
    );
  }

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = 4;
  const xStep = data.length <= 1 ? 0 : (w - pad * 2) / (data.length - 1);

  const yOf = (v: number) => {
    if (max === min) return h / 2;
    const t = (v - min) / (max - min);
    return pad + (1 - t) * (h - pad * 2);
  };

  const pts = data
    .map((d, i) => {
      if (d.value == null) return null;
      const x = pad + i * xStep;
      const y = yOf(d.value);
      return `${x},${y}`;
    })
    .filter(Boolean)
    .join(" ");

  const last = [...data].reverse().find((d) => d.value != null);

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height }} aria-label="progress chart">
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="3"
          points={pts}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line x1="0" y1={h - 1} x2={w} y2={h - 1} stroke="rgba(15,23,42,.10)" />
      </svg>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <div
          className="muted"
          style={{ maxWidth: "75%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {data[0]?.label} → {data[data.length - 1]?.label}
        </div>
        <div className="badge accentBadge">Latest: {last?.value != null ? last.value.toFixed(1) : "n/a"}</div>
      </div>
    </div>
  );
}

export default function Page() {
  const [mounted, setMounted] = useState(false);

  const [task, setTask] = useState<Task>("reading");
  const [mode, setMode] = useState<Mode>("library");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [dialect, setDialect] = useState<Dialect>("en-us");

  const [pronunciationScoreMode, setPronunciationScoreMode] = useState<"default" | "strict">("default");
  const [detectDialect, setDetectDialect] = useState(false);

  const [passages, setPassages] = useState<Passage[]>(DEFAULT_PASSAGES);
  const [selectedId, setSelectedId] = useState(DEFAULT_PASSAGES[0]?.id || "");
  const selected = useMemo(() => passages.find((p) => p.id === selectedId), [passages, selectedId]);

  const [customTitle, setCustomTitle] = useState("");
  const [customText, setCustomText] = useState("");

  const [openPrompt, setOpenPrompt] = useState(
    "Tell me about a memorable day in your life. What happened and why was it memorable?"
  );
  const [relevanceContext, setRelevanceContext] = useState("Describe your favorite food and explain why you like it.");

  // per-task state
  const [taskState, setTaskState] = useState<Record<Task, TaskUiState>>({
    reading: { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
    "open-ended": { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
    relevance: { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
  });

  const active = taskState[task];
  const result = active.result;
  const err = active.err;
  const audioUrl = active.audioUrl;
  const uploadedFile = active.uploadedFile;

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  // ===== Dashboard (history + chart) =====
  const [historyVersion, setHistoryVersion] = useState(0);
  const [dashBucket, setDashBucket] = useState<"day" | "week">("day");
  const [dashTask, setDashTask] = useState<Task | "all">("all");
  const [dashMetric, setDashMetric] = useState<
    "overall" | "pronunciation" | "fluency" | "grammar" | "coherence" | "vocab" | "relevanceScore"
  >("overall");

  const history = useMemo(() => {
    void historyVersion;
    return loadHistory();
  }, [historyVersion]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // playback anti-race
  const playTokenRef = useRef(0);
  const segmentRef = useRef<{ endSec: number; token: number } | null>(null);
  const segmentTimerRef = useRef<any>(null);

  const [hover, setHover] = useState<{ w: WordDisplay; x: number; y: number } | null>(null);
  const [clickPop, setClickPop] = useState<{ w: WordDisplay; x: number; y: number } | null>(null);

  // ===== Translation (EN -> VI) for hover tooltip =====
  const [meaningMap, setMeaningMap] = useState<Record<string, string>>({});
  const [translatingKey, setTranslatingKey] = useState<string | null>(null);
  const translateAbortRef = useRef<AbortController | null>(null);

  function getMeaning(rawWord: string | undefined | null) {
    const k = normalizeWord(rawWord || "");
    return k ? meaningMap[k] || "" : "";
  }

  // MediaRecorder path
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const taskAtRecordRef = useRef<Task>("reading");

  // WAV fallback path
  const wavStopperRef = useRef<null | (() => Promise<{ blob: Blob; durationSec: number; mimeType: string }>)>(null);

  const [seconds, setSeconds] = useState(0);
  const secondsRef = useRef(0);
  const timerRef = useRef<any>(null);

  // Sample TTS (browser)
  const [ttsSpeaking, setTtsSpeaking] = useState(false);

  function updateTaskState(patch: Partial<TaskUiState>, t: Task = task) {
    setTaskState((prev) => ({
      ...prev,
      [t]: { ...prev[t], ...patch },
    }));
  }

  useEffect(() => setMounted(true), []);

  // Đổi tab: reset DOM file input + reset state uploadedFile của tab đang vào
  useEffect(() => {
    try {
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {}
    updateTaskState({ uploadedFile: null }, task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  // Auto-translate hovered/clicked word (reading)
  useEffect(() => {
    if (task !== "reading") return;

    const rawWord = clickPop?.w?.word || hover?.w?.word || "";
    const key = normalizeWord(rawWord);

    if (!key || key.length < 2 || !/^[a-z]+$/i.test(key)) return;
    if (meaningMap[key]) return;

    const timer = setTimeout(async () => {
      translateAbortRef.current?.abort?.();
      const ac = new AbortController();
      translateAbortRef.current = ac;

      setTranslatingKey(key);

      try {
        const r = await fetch("/api/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: key, from: "en", to: "vi" }),
          signal: ac.signal,
        });

        const j = await r.json().catch(() => null);
        if (!r.ok) return;

        const vi = String(j?.translation || "").trim();
        if (vi) setMeaningMap((prev) => ({ ...prev, [key]: vi }));
      } catch {
        // ignore
      } finally {
        setTranslatingKey((cur) => (cur === key ? null : cur));
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [task, hover?.w?.word, clickPop?.w?.word, meaningMap]);

  useEffect(() => {
    const raw = localStorage.getItem(USER_PASSAGES_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setPassages([...DEFAULT_PASSAGES, ...parsed]);
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      try {
        const synth: any = (window as any).speechSynthesis;
        synth?.cancel?.();
      } catch {}
    };
  }, []);

  function canStart() {
    return fullName.trim() && email.trim();
  }

  function referenceText() {
    if (task !== "reading") return "";
    return mode === "library" ? selected?.text || "" : customText;
  }

  const refText = referenceText().trim();

  function stopSegmentTimer() {
    if (segmentTimerRef.current) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  }

  function stopTts() {
    try {
      const synth: any = (window as any).speechSynthesis;
      synth?.cancel?.();
    } catch {}
    setTtsSpeaking(false);
  }

  function resetRunState(t: Task = task) {
    updateTaskState({ result: null, err: null, audioUrl: null, audioUrlAt: null }, t);
    setHover(null);
    setClickPop(null);

    stopSegmentTimer();
    segmentRef.current = null;

    try {
      audioRef.current?.pause?.();
    } catch {}
    stopTts();
  }

  function addCustomPassageToLibrary() {
    updateTaskState({ err: null });
    const title = customTitle.trim() || "Untitled";
    const text = customText.trim();
    if (wordsCount(text) < 1) return updateTaskState({ err: "Text trống (không thể lưu)." });

    const p: Passage = { id: `u_${Date.now()}`, title, text };
    const existingUserPassages = passages.filter((x) => x.id.startsWith("u_"));
    const nextUserPassages = [...existingUserPassages, p];

    localStorage.setItem(USER_PASSAGES_STORAGE_KEY, JSON.stringify(nextUserPassages));
    setPassages([...DEFAULT_PASSAGES, ...nextUserPassages]);
    setSelectedId(p.id);
    setMode("library");
  }

  async function ensureFreshAudioUrl(): Promise<string | null> {
    const key = result?.audioKey;
    if (!key) return null;

    const now = Date.now();
    if (audioUrl && active.audioUrlAt && now - active.audioUrlAt < 50_000) return audioUrl;

    try {
      const r = await fetch(`/api/audio-url?key=${encodeURIComponent(key)}`);
      const j = await r.json();
      const url = j?.url || null;

      updateTaskState({ audioUrl: url, audioUrlAt: url ? Date.now() : null });

      if (url && audioRef.current) {
        try {
          audioRef.current.src = url;
          audioRef.current.load();
        } catch {}
      }

      return url;
    } catch {
      return audioUrl || null;
    }
  }

  async function playSegment(startSec: number, endSec: number) {
    const a = audioRef.current;
    if (!a) return;

    stopSegmentTimer();
    segmentRef.current = null;

    playTokenRef.current += 1;
    const token = playTokenRef.current;

    try {
      a.pause();
    } catch {}

    if (!a.src) {
      const url = await ensureFreshAudioUrl();
      if (!url) return;
    }

    const doSeekPlay = async () => {
      if (token !== playTokenRef.current) return;

      try {
        a.currentTime = Math.max(0, startSec);
      } catch {}

      segmentRef.current = { endSec, token };

      void a.play().catch(() => {});

      const ms = Math.max(80, Math.round((endSec - startSec) * 1000) + 60);
      segmentTimerRef.current = setTimeout(() => {
        const seg = segmentRef.current;
        if (!seg || seg.token !== token) return;

        try {
          a.pause();
        } catch {}
        segmentRef.current = null;
        segmentTimerRef.current = null;
      }, ms);
    };

    if (a.readyState < 1) {
      await new Promise<void>((resolve) => {
        const once = () => {
          a.removeEventListener("loadedmetadata", once);
          resolve();
        };
        a.addEventListener("loadedmetadata", once);
        try {
          a.load();
        } catch {
          resolve();
        }
      });
    }

    await doSeekPlay();
  }

  function toggleTts(text: string) {
    if (typeof window === "undefined") return;

    const synth: any = (window as any).speechSynthesis;
    const Utter: any = (window as any).SpeechSynthesisUtterance;
    if (!synth || !Utter) return;

    if (ttsSpeaking) {
      stopTts();
      return;
    }

    try {
      audioRef.current?.pause?.();
    } catch {}
    stopSegmentTimer();
    segmentRef.current = null;

    const u = new Utter(text);
    u.lang = (result?.dialect || dialect) === "en-gb" ? "en-GB" : "en-US";
    u.rate = 0.95;
    u.onend = () => setTtsSpeaking(false);
    u.onerror = () => setTtsSpeaking(false);

    setTtsSpeaking(true);
    synth.cancel();
    synth.speak(u);
  }

  async function playWord(w: WordDisplay) {
    const url = await ensureFreshAudioUrl();
    if (!url) return;

    stopTts();
    stopSegmentTimer();

    const t: any = (w as any).timing;
    if (!t || typeof t.startSec !== "number" || typeof t.endSec !== "number") {
      updateTaskState({ err: "Từ này không có timing → không thể phát đúng theo từ (hãy đảm bảo SpeechAce trả extent)." });
      return;
    }

    const start = Math.max(0, t.startSec - 0.05);
    const end = Math.max(start + 0.02, t.endSec);
    await playSegment(start, end);
  }

  async function startRec() {
    resetRunState(task);
    taskAtRecordRef.current = task;

    if (!canStart()) return updateTaskState({ err: "Bạn phải nhập Họ tên + Email trước khi bắt đầu." });
    if (task === "reading" && wordsCount(refText) < 1) return updateTaskState({ err: "Bạn phải nạp Reference text trước khi ghi âm." });

    if (uploadedFile) updateTaskState({ uploadedFile: null });

    secondsRef.current = 0;
    setSeconds(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);

    try {
      const gum = (navigator as any)?.mediaDevices?.getUserMedia;
      if (!gum) {
        throw new Error("Trình duyệt không hỗ trợ getUserMedia (hoặc đang chạy HTTP). Hãy dùng HTTPS hoặc Upload audio.");
      }

      if (hasMediaRecorder()) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = pickRecorderMimeType();
        const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

        chunksRef.current = [];
        mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);

        mr.onstop = async () => {
          try {
            if (timerRef.current) clearInterval(timerRef.current);
            stream.getTracks().forEach((t) => t.stop());

            const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });

            if (!blob || blob.size < 1000) {
              updateTaskState({
                err: "Không thu được audio (blob rỗng). Hãy thử Chrome khác / cấp quyền micro lại / hoặc dùng Upload file.",
              });
              return;
            }

            await uploadThenScore(blob, secondsRef.current, taskAtRecordRef.current);
          } catch (e: any) {
            updateTaskState({ err: e?.message || "Stop recording failed" });
          }
        };

        mrRef.current = mr;
        mr.start(250);

        setRecording(true);
        return;
      }

      const h = await startWavRecorder();
      wavStopperRef.current = h.stop;
      setRecording(true);
    } catch (e: any) {
      if (timerRef.current) clearInterval(timerRef.current);
      setRecording(false);

      const name = e?.name || "";
      if (name === "NotAllowedError") {
        updateTaskState({ err: "Bạn đã chặn quyền micro. Bấm icon khóa cạnh URL → Allow microphone." });
      } else if (name === "NotFoundError") {
        updateTaskState({ err: "Không tìm thấy micro trên máy. Cắm micro/chọn đúng Input trong Windows, hoặc dùng Upload audio." });
      } else if (name === "NotReadableError") {
        updateTaskState({ err: "Micro đang bị app khác chiếm (Zoom/Meet/...). Tắt app đó rồi thử lại." });
      } else {
        updateTaskState({ err: e?.message || "Không thể ghi âm. Bạn có thể dùng Upload audio." });
      }
    }
  }

  async function stopRec() {
    if (!recording) return;
    setRecording(false);

    if (mrRef.current) {
      mrRef.current.stop();
      mrRef.current = null;
      return;
    }

    const stop = wavStopperRef.current;
    wavStopperRef.current = null;

    if (timerRef.current) clearInterval(timerRef.current);
    if (!stop) return updateTaskState({ err: "Recorder not ready" });

    try {
      const rec = await stop();
      const dur = Number.isFinite(rec.durationSec) ? rec.durationSec : secondsRef.current;
      await uploadThenScore(rec.blob, dur, taskAtRecordRef.current);
    } catch (e: any) {
      updateTaskState({ err: e?.message || "Stop recording failed" });
    }
  }

  async function uploadThenScore(audioBlob: Blob, durationSec?: number, t: Task = task) {
    try {
      setBusy(true);
      updateTaskState({ err: null }, t);

      const up = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentType: audioBlob.type || "application/octet-stream" }),
      }).then((r) => r.json());

      if (!up?.url || !up?.key) throw new Error(up?.error || "Cannot get upload url");

      const putRes = await fetch(up.url, {
        method: "PUT",
        headers: { "content-type": audioBlob.type || "application/octet-stream" },
        body: audioBlob,
      });
      if (!putRes.ok) throw new Error("Upload failed");

      const payload: any = {
        fullName: fullName.trim(),
        email: email.trim(),
        dialect,
        audioKey: up.key,
        durationSec,
        pronunciationScoreMode,
        detectDialect,
      };

      let endpoint = "/api/score";

      if (t === "reading") {
        if (wordsCount(refText) < 1) throw new Error("Reference text is empty");
        payload.text = refText;
        endpoint = "/api/score";
      } else if (t === "open-ended") {
        payload.prompt = openPrompt.trim();
        endpoint = "/api/open-ended";
      } else {
        payload.relevanceContext = relevanceContext.trim();
        endpoint = "/api/relevance";
      }

      console.log("[score] task =", t, "endpoint =", endpoint, "payload =", payload);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const raw = await res.text();
      console.log("[score] status =", res.status, "raw(head) =", raw?.slice(0, 200));

      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        json = { raw };
      }

      if (!res.ok) throw new Error(json?.error || json?.message || raw || "Scoring failed");

      const nextResult = { ...(json ?? {}), usedText: t === "reading" ? refText : undefined };

      updateTaskState(
        {
          result: nextResult,
          audioUrl: null,
          audioUrlAt: null,
        },
        t
      );

      // ===== Save history =====
      try {
        const sp = nextResult?.speechace;

        const scoreObj =
          t === "reading"
            ? sp?.text_score?.speechace_score ?? sp?.speechace_score ?? null
            : sp?.speech_score?.speechace_score ?? sp?.speechace_score ?? null;

        const overallNum =
          t === "reading"
            ? safeNum(
                sp?.text_score?.speechace_score?.overall ??
                  sp?.text_score?.overall ??
                  scoreObj?.overall ??
                  nextResult?.overall
              )
            : safeNum(
                sp?.speech_score?.speechace_score?.overall ??
                  sp?.speech_score?.overall ??
                  scoreObj?.overall ??
                  nextResult?.overall
              );

        const relObj = sp?.speech_score?.relevance ?? sp?.relevance ?? null;
        const relExtra =
          relObj && typeof relObj === "object"
            ? Object.fromEntries(Object.entries(relObj).filter(([k]) => !["class", "score"].includes(k)))
            : null;

        const entry: HistoryEntry = {
          id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
          ts: Date.now(),
          task: t,
          dialect,

          overall: overallNum,
          pronunciation: safeNum(scoreObj?.pronunciation),
          fluency: safeNum(scoreObj?.fluency),
          grammar: safeNum(scoreObj?.grammar),
          coherence: safeNum(scoreObj?.coherence),
          vocab: safeNum(scoreObj?.vocab),

          relevanceClass: t === "relevance" ? (nextResult?.relevanceClass ?? relObj?.class ?? null) : null,
          relevanceScore: t === "relevance" ? safeNum(nextResult?.relevanceScore ?? relObj?.score ?? null) : null,
          relevanceExtra: t === "relevance" ? (relExtra as any) : null,

          transcript: sp?.speech_score?.transcript ?? sp?.speech_score?.transcription ?? null,

          prompt: t === "open-ended" ? openPrompt.trim() : null,
          relevanceContext: t === "relevance" ? relevanceContext.trim() : null,
          referenceWords: t === "reading" ? wordsCount(refText) : null,
        };

        pushHistory(entry);
        setHistoryVersion((v) => v + 1);
      } catch {}
    } catch (e: any) {
      updateTaskState({ err: e?.message || "Error" }, t);
    } finally {
      setBusy(false);
    }
  }

  async function scoreUploadedFile() {
    resetRunState(task);
    if (!uploadedFile) return;
    if (!canStart()) return updateTaskState({ err: "Bạn phải nhập Họ tên + Email trước khi bắt đầu." });
    if (task === "reading" && wordsCount(refText) < 1) return updateTaskState({ err: "Bạn phải nạp Reference text trước khi chấm." });
    await uploadThenScore(uploadedFile, undefined, task);
  }

  // Fetch audioUrl when current task result has audioKey
  useEffect(() => {
    let cancelled = false;

    async function run() {
      const key = result?.audioKey;
      if (!key) return;
      if (active.audioUrl && active.audioUrlAt) return;

      try {
        const r = await fetch(`/api/audio-url?key=${encodeURIComponent(key)}`);
        const j = await r.json();
        if (!cancelled) updateTaskState({ audioUrl: j?.url || null, audioUrlAt: j?.url ? Date.now() : null });
      } catch {
        if (!cancelled) updateTaskState({ audioUrl: null, audioUrlAt: null });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, result?.audioKey]);

  // Pause at segment end
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onTime = () => {
      const seg = segmentRef.current;
      if (!seg) return;
      if (playTokenRef.current !== seg.token) return;

      if (a.currentTime >= seg.endSec) {
        try {
          a.pause();
        } catch {}
        segmentRef.current = null;
        stopSegmentTimer();
      }
    };

    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [audioUrl]);

  const recorderName = hasMediaRecorder() ? "MediaRecorder" : "WAV fallback";

  const overall =
    result?.task === "reading"
      ? result?.speechace?.text_score?.speechace_score?.overall ??
        result?.speechace?.text_score?.overall ??
        result?.speechace?.speechace_score?.overall ??
        result?.overall ??
        null
      : result?.speechace?.speech_score?.speechace_score?.overall ??
        result?.speechace?.speechace_score?.overall ??
        result?.overall ??
        null;

  const speechace = result?.speechace;
  const usedText = (result?.usedText || refText || "").trim();

  const wordDisplays = useMemo(() => {
    if (task !== "reading" || !speechace || !usedText) return [];
    return buildWordDisplays(usedText, speechace);
  }, [task, speechace, usedText]);

  const tokens = useMemo(() => {
    if (task !== "reading" || !usedText) return [];
    return tokenizeAndAttach(usedText, wordDisplays);
  }, [task, usedText, wordDisplays]);

  const hasHighlight =
    task === "reading" && tokens.some((t) => t.kind === "word" && t.attach && typeof t.attach.quality === "number");

  // Relevance details (show everything SpeechAce returns)
  const relevanceObj = (speechace?.speech_score?.relevance ?? speechace?.relevance ?? null) as any;
  const relevanceClass =
    (result?.relevanceClass ?? relevanceObj?.class ?? speechace?.speech_score?.relevance?.class ?? null) as any;
  const relevanceScore =
    (result?.relevanceScore ?? relevanceObj?.score ?? speechace?.speech_score?.relevance?.score ?? null) as any;

  const relevanceExtra =
    relevanceObj && typeof relevanceObj === "object"
      ? Object.entries(relevanceObj).filter(([k]) => !["class", "score"].includes(k))
      : [];

  const clampLeft = (x: number, w: number) =>
    Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1024) - w - 12);
  const clampTop = (y: number, h: number) =>
    Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 768) - h - 12);

  const renderPopups =
    mounted && typeof document !== "undefined"
      ? createPortal(
          <>
            {clickPop ? (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: "fixed",
                  left: clampLeft(clickPop.x + 12, 300),
                  top: clampTop(clickPop.y + 12, 230),
                  width: 280,
                  borderRadius: 16,
                  border: "1px solid var(--border)",
                  background: "rgba(255,255,255,.98)",
                  boxShadow: "0 18px 40px rgba(15,23,42,.18)",
                  padding: 10,
                  zIndex: 9999,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 900 }}>{clickPop.w.word}</div>
                  <span className="badge accentBadge">
                    {clickPop.w.quality == null ? "n/a" : (clickPop.w.quality as number).toFixed(0)}
                  </span>
                </div>

                <div className="muted" style={{ marginTop: 6 }}>
                  {formatPhonesForTooltip(clickPop.w) || "(no phone detail)"}
                </div>

                <div className="muted" style={{ marginTop: 6 }}>
                  Dịch:{" "}
                  <b>
                    {getMeaning(clickPop.w.word) ||
                      (translatingKey === normalizeWord(clickPop.w.word) ? "đang tra…" : "—")}
                  </b>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <button className="btn3d" onClick={() => void playWord(clickPop.w)} disabled={!audioUrl}>
                    ▶ nghe lại từ
                  </button>

                  <button className="btn3d" onClick={() => toggleTts(clickPop.w.word)}>
                    {ttsSpeaking ? "⏹ Stop mẫu" : "🔈 mẫu (TTS)"}
                  </button>

                  <button className="btn3d" onClick={() => setClickPop(null)}>
                    ✕
                  </button>
                </div>

                {!(clickPop as any)?.w?.timing ? (
                  <div className="muted" style={{ marginTop: 8 }}>
                    *Từ này không có timing → hãy đảm bảo SpeechAce trả extent.
                  </div>
                ) : null}
              </div>
            ) : null}

            {hover ? (
              <div
                style={{
                  position: "fixed",
                  left: clampLeft(hover.x + 12, 280),
                  top: clampTop(hover.y + 12, 200),
                  width: 260,
                  borderRadius: 16,
                  border: "1px solid var(--border)",
                  background: "rgba(255,255,255,.98)",
                  boxShadow: "0 18px 40px rgba(15,23,42,.18)",
                  padding: 10,
                  zIndex: 9998,
                  pointerEvents: "none",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 900 }}>{hover.w.word}</div>
                  <span className="badge accentBadge">
                    {hover.w.quality == null ? "n/a" : (hover.w.quality as number).toFixed(0)}
                  </span>
                </div>

                <div className="muted" style={{ marginTop: 6 }}>
                  {formatPhonesForTooltip(hover.w) || "(no phone detail)"}
                </div>

                <div className="muted" style={{ marginTop: 6 }}>
                  Dịch:{" "}
                  <b>
                    {getMeaning(hover.w.word) || (translatingKey === normalizeWord(hover.w.word) ? "đang tra…" : "—")}
                  </b>
                </div>

                <div className="muted" style={{ marginTop: 8 }}>
                  click vào từ để nghe lại đúng từ
                </div>
              </div>
            ) : null}
          </>,
          document.body
        )
      : null;

  const themeClass = task === "reading" ? "themeReading" : task === "open-ended" ? "themeOpen" : "themeRel";

  const scoreObj =
    task === "reading"
      ? speechace?.text_score?.speechace_score ?? speechace?.speechace_score ?? null
      : speechace?.speech_score?.speechace_score ?? speechace?.speechace_score ?? null;

  const ieltsObj =
    task === "reading"
      ? speechace?.text_score?.ielts_score ?? speechace?.ielts_score ?? null
      : speechace?.speech_score?.ielts_score ?? speechace?.ielts_score ?? null;

  const pteObj =
    task === "reading"
      ? speechace?.text_score?.pte_score ?? speechace?.pte_score ?? null
      : speechace?.speech_score?.pte_score ?? speechace?.pte_score ?? null;

  const toeicObj =
    task === "reading"
      ? speechace?.text_score?.toeic_score ?? speechace?.toeic_score ?? null
      : speechace?.speech_score?.toeic_score ?? speechace?.toeic_score ?? null;

  const cefrObj =
    task === "reading"
      ? speechace?.text_score?.cefr_score ?? speechace?.cefr_score ?? null
      : speechace?.speech_score?.cefr_score ?? speechace?.cefr_score ?? null;

  const issueList =
    (task === "reading"
      ? speechace?.text_score?.score_issue_list ?? speechace?.score_issue_list
      : speechace?.speech_score?.score_issue_list ?? speechace?.score_issue_list) || [];

  const transcript =
    task === "reading"
      ? speechace?.text_score?.transcript ?? speechace?.transcript ?? ""
      : speechace?.speech_score?.transcript ??
        speechace?.speech_score?.transcription ??
        speechace?.transcript ??
        "";

  const norm100 = (v: any) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  };

  const Metric = ({ label, value, sub }: { label: string; value: any; sub?: string }) => {
    const vv = norm100(value);
    return (
      <div className="metricCardPro">
        <div className="metricTop">
          <div className="metricLabel">{label}</div>
          <div className="metricValue">{vv == null ? "n/a" : vv.toFixed(0)}</div>
        </div>
        <div className="bar">
          <div className="barFill" style={{ width: `${vv == null ? 0 : vv}%` }} />
        </div>
        {sub ? <div className="metricSub">{sub}</div> : null}
      </div>
    );
  };

  // ---- Progress dashboard computed data
  const chartData = useMemo(() => {
    return groupHistory(history, dashBucket, dashTask, dashMetric).slice(-24);
  }, [history, dashBucket, dashTask, dashMetric]);

  const resultsPanel = (
    <div>
      <div className="resultsHeader">
        <div>
          <div className="resultsTitle">Kết quả chấm</div>
          <div className="resultsSub">
            {task === "reading"
              ? "Reading (tham chiếu theo reference text)"
              : task === "open-ended"
              ? "Open-ended (tự do theo prompt)"
              : "Relevance (đúng/ngữ cảnh theo context)"}
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span className="badge accentBadge">{task}</span>
          {typeof overall === "number" ? <span className="badge accentBadge">Overall: {overall.toFixed(1)}</span> : null}
          {busy ? <span className="badge">⏳ Đang chấm…</span> : null}
        </div>
      </div>

      {err ? <div className="alertError">Lỗi: {err}</div> : null}

      {!result ? (
        <div className="muted" style={{ marginTop: 12 }}>
          Chưa có kết quả. Hãy ghi âm hoặc upload file ở menu bên trái rồi bấm chấm.
        </div>
      ) : (
        <>
          {/* METRICS */}
          <div className="dashGrid">
            <Metric label="Overall" value={scoreObj?.overall ?? overall} />
            <Metric label="Pronunciation" value={scoreObj?.pronunciation} />
            <Metric label="Fluency" value={scoreObj?.fluency} />
            <Metric label="Grammar" value={scoreObj?.grammar} />
            <Metric label="Vocabulary" value={scoreObj?.vocab} />
            <Metric label="Coherence" value={scoreObj?.coherence} />
          </div>

          <div className="quickRow">
            {cefrObj ? (
              <div className="quickCard">
                <div className="quickTitle">CEFR</div>
                <div className="quickText">
                  Pron <b>{cefrObj?.pronunciation ?? "n/a"}</b> • Flu <b>{cefrObj?.fluency ?? "n/a"}</b> • Gram{" "}
                  <b>{cefrObj?.grammar ?? "n/a"}</b> • Coh <b>{cefrObj?.coherence ?? "n/a"}</b> • Vocab{" "}
                  <b>{cefrObj?.vocab ?? "n/a"}</b> • Overall <b>{cefrObj?.overall ?? "n/a"}</b>
                </div>
              </div>
            ) : null}

            {ieltsObj ? (
              <div className="quickCard">
                <div className="quickTitle">IELTS (ước lượng)</div>
                <div className="quickText">
                  Pron <b>{ieltsObj?.pronunciation ?? "n/a"}</b> • Flu <b>{ieltsObj?.fluency ?? "n/a"}</b> • Gram{" "}
                  <b>{ieltsObj?.grammar ?? "n/a"}</b> • Coh <b>{ieltsObj?.coherence ?? "n/a"}</b> • Vocab{" "}
                  <b>{ieltsObj?.vocab ?? ieltsObj?.lexical_resource ?? "n/a"}</b>
                </div>
              </div>
            ) : null}

            {pteObj ? (
              <div className="quickCard">
                <div className="quickTitle">PTE</div>
                <div className="quickText">
                  Pron <b>{pteObj?.pronunciation ?? "n/a"}</b> • Flu <b>{pteObj?.fluency ?? "n/a"}</b> • Gram{" "}
                  <b>{pteObj?.grammar ?? "n/a"}</b> • Coh <b>{pteObj?.coherence ?? "n/a"}</b> • Vocab{" "}
                  <b>{pteObj?.vocab ?? "n/a"}</b>
                </div>
              </div>
            ) : null}

            {toeicObj ? (
              <div className="quickCard">
                <div className="quickTitle">TOEIC</div>
                <div className="quickText">
                  Pron <b>{toeicObj?.pronunciation ?? "n/a"}</b> • Flu <b>{toeicObj?.fluency ?? "n/a"}</b> • Gram{" "}
                  <b>{toeicObj?.grammar ?? "n/a"}</b> • Coh <b>{toeicObj?.coherence ?? "n/a"}</b> • Vocab{" "}
                  <b>{toeicObj?.vocab ?? "n/a"}</b>
                </div>
              </div>
            ) : null}
          </div>

          {/* AUDIO */}
          <div className="divider" style={{ marginTop: 14 }} />
          <div style={{ marginTop: 12 }}>
            {audioUrl ? (
              <audio
                ref={audioRef}
                src={audioUrl}
                controls
                style={{ width: "100%" }}
                onError={() => {
                  void ensureFreshAudioUrl();
                }}
              />
            ) : (
              <div className="muted">Chưa có audioUrl (nếu R2 private thì cần presign).</div>
            )}
          </div>

          {/* TASK DETAIL */}
          <div className="divider" style={{ marginTop: 14 }} />

          {task === "relevance" ? (
            <div className="relBox">
              <div className="relRow">
                <span className={`relPill ${String(relevanceClass).toUpperCase() === "TRUE" ? "relTrue" : "relFalse"}`}>
                  {relevanceClass ?? "n/a"}
                </span>
                {relevanceScore != null ? <span className="badge accentBadge">score: {relevanceScore}</span> : null}
              </div>

              {relevanceExtra?.length ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Relevance details (SpeechAce trả thêm)</div>
                  <div className="kvList">
                    {relevanceExtra.map(([k, v]) => (
                      <div key={k} className="kvRow">
                        <div className="kvKey">{k}</div>
                        <div className="kvVal">{typeof v === "string" ? v : JSON.stringify(v)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 10 }}>
                  <b>TRUE/FALSE nghĩa là gì?</b>
                  <div style={{ marginTop: 6 }}>
                    • <b>TRUE</b>: bài nói bám đúng “relevance_context”, đúng chủ đề/ý chính.
                    <br />
                    • <b>FALSE</b>: lạc đề, nói sang nội dung khác, hoặc nội dung quá ngắn/thiếu tín hiệu bám đề.
                  </div>
                </div>
              )}

              <div className="muted" style={{ marginTop: 10 }}>
                Tip: nhắc lại keyword của đề ở mở bài, trả lời 2–3 ý chính, tránh kể lan man.
              </div>
            </div>
          ) : null}

          {task === "open-ended" ? (
            <div className="relBox">
              <div style={{ fontWeight: 900 }}>Transcript</div>
              <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                <b>{transcript || "n/a"}</b>
              </div>
            </div>
          ) : null}

          {task === "reading" ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 8, marginTop: 12 }}>Highlight theo word-score</div>

              {!hasHighlight ? (
                <div className="muted">
                  Chưa thấy word_score_list để highlight. Nếu SpeechAce trả về word_score_list, UI sẽ bôi màu theo
                  quality_score.
                </div>
              ) : null}

              <div style={{ lineHeight: 2, fontSize: 16, marginTop: 8 }}>
                {tokens.map((t, idx) => {
                  if (t.kind === "space") return <span key={idx}>{t.text}</span>;
                  if (t.kind === "punct") return <span key={idx}>{t.text}</span>;

                  const w = t.attach;
                  const band = qualityBand((w as any)?.quality ?? null);

                  const style: CSSProperties =
                    band === "good"
                      ? { background: "rgba(34,197,94,.12)", border: "1px solid rgba(34,197,94,.18)" }
                      : band === "warn"
                      ? { background: "rgba(245,158,11,.14)", border: "1px solid rgba(245,158,11,.20)" }
                      : band === "bad"
                      ? { background: "rgba(239,68,68,.12)", border: "1px solid rgba(239,68,68,.18)" }
                      : {};

                  return (
                    <span
                      key={idx}
                      style={{
                        ...style,
                        padding: "2px 6px",
                        borderRadius: 10,
                        cursor: w && audioUrl ? "pointer" : "default",
                        userSelect: "none",
                      }}
                      title={w ? formatPhonesForTooltip(w) : ""}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!w) return;
                        setClickPop({ w, x: e.clientX, y: e.clientY });
                        void playWord(w);
                      }}
                      onMouseEnter={(e) => {
                        if (!w) return;
                        setHover({ w, x: e.clientX, y: e.clientY });
                      }}
                      onMouseMove={(e) => {
                        if (!w) return;
                        setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : { w, x: e.clientX, y: e.clientY }));
                      }}
                      onMouseLeave={() => setHover(null)}
                    >
                      {t.text}
                    </span>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* PROGRESS DASHBOARD */}
          <div className="divider" style={{ marginTop: 14 }} />
          <div className="dashCard" style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 1000 }}>Dashboard tiến bộ</div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="badge accentBadge">History: {history.length}</span>
                <button
                  className="btn3d btnTiny"
                  onClick={() => {
                    saveHistory([]);
                    setHistoryVersion((v) => v + 1);
                  }}
                >
                  🧹 Clear
                </button>
              </div>
            </div>

            <div className="dashControls">
              <div className="field">
                <label>Bucket</label>
                <select className="select" value={dashBucket} onChange={(e) => setDashBucket(e.target.value as any)}>
                  <option value="day">Theo ngày</option>
                  <option value="week">Theo tuần (ISO)</option>
                </select>
              </div>

              <div className="field">
                <label>Task</label>
                <select className="select" value={dashTask} onChange={(e) => setDashTask(e.target.value as any)}>
                  <option value="all">All</option>
                  <option value="reading">Reading</option>
                  <option value="open-ended">Open-ended</option>
                  <option value="relevance">Relevance</option>
                </select>
              </div>

              <div className="field">
                <label>Metric</label>
                <select className="select" value={dashMetric} onChange={(e) => setDashMetric(e.target.value as any)}>
                  <option value="overall">Overall</option>
                  <option value="pronunciation">Pronunciation</option>
                  <option value="fluency">Fluency</option>
                  <option value="grammar">Grammar</option>
                  <option value="coherence">Coherence</option>
                  <option value="vocab">Vocab</option>
                  <option value="relevanceScore">Relevance score</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <Sparkline data={chartData} height={70} />
            </div>

            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer" }}>Xem 10 bài gần nhất</summary>
              <div style={{ marginTop: 8 }} className="historyList">
                {history.slice(0, 10).map((h) => (
                  <div key={h.id} className="historyRow">
                    <div className="muted">
                      {new Date(h.ts).toLocaleString()} • <b>{h.task}</b>
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <span className="badge accentBadge">Overall: {h.overall != null ? h.overall.toFixed(1) : "n/a"}</span>
                      <span className="badge">P: {h.pronunciation ?? "n/a"}</span>
                      <span className="badge">F: {h.fluency ?? "n/a"}</span>
                      {h.task === "relevance" ? (
                        <span className="badge">Rel: {h.relevanceClass ?? "n/a"}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>

          {/* ISSUES */}
          {Array.isArray(issueList) && issueList.length ? (
            <>
              <div className="divider" style={{ marginTop: 14 }} />
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Cảnh báo / Issues</div>
              <div className="issueWrap">
                {issueList.slice(0, 12).map((it: any, idx: number) => {
                  const st = String(it?.status || "").toLowerCase();
                  const cls = st === "warning" ? "issueWarn" : st === "error" ? "issueErr" : "issueInfo";
                  return (
                    <div key={idx} className={`issuePill ${cls}`} title={String(it?.detail_message || "")}>
                      {String(it?.short_message || it?.source || "issue")}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* DEBUG */}
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer" }}>Xem JSON trả về (debug)</summary>
            <pre
              style={{
                marginTop: 10,
                padding: 12,
                borderRadius: 14,
                border: "1px solid var(--border)",
                background: "rgba(255,255,255,.9)",
                overflowX: "auto",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>

          <p className="muted" style={{ textAlign: "center", marginTop: 12 }}>
            *Audio user phát lại qua presigned URL (R2). Sample là Browser TTS.
          </p>
        </>
      )}
    </div>
  );

  return (
    <div
      className="container"
      onClick={() => {
        setClickPop(null);
      }}
    >
      <div className="card">
        <div className="h1">SpeechAce Practice (Web)</div>
        <p className="sub">
          Reading / Open-ended / Relevance. Upload hoặc ghi âm → chấm. (Audio user phát lại qua presigned URL; mẫu phát âm
          dùng Browser TTS nếu cần.)
        </p>

        <div className={`proGrid ${themeClass}`}>
          {/* LEFT: MENU */}
          <aside className="proSide">
            <div className="sideTabs">
              <button
                className={`btn3d tabBtn ${task === "reading" ? "tabBtnActive" : ""}`}
                onClick={() => {
                  setHover(null);
                  setClickPop(null);
                  setTask("reading");
                }}
                disabled={busy || recording}
              >
                📘 Reading
              </button>

              <button
                className={`btn3d tabBtn ${task === "open-ended" ? "tabBtnActive" : ""}`}
                onClick={() => {
                  setHover(null);
                  setClickPop(null);
                  setTask("open-ended");
                }}
                disabled={busy || recording}
              >
                🗣️ Open-ended
              </button>

              <button
                className={`btn3d tabBtn ${task === "relevance" ? "tabBtnActive" : ""}`}
                onClick={() => {
                  setHover(null);
                  setClickPop(null);
                  setTask("relevance");
                }}
                disabled={busy || recording}
              >
                🎯 Relevance
              </button>
            </div>

            <div className="divider" style={{ marginTop: 14 }} />

            <div className="sideScroll">
              {/* USER INFO */}
              <div className="section">
                <div className="sectionTitle">
                  <span>Thông tin người dùng</span>
                  <span className="badge accentBadge">Dialect: {dialect}</span>
                </div>

                <div className="grid2">
                  <div className="field">
                    <label>Họ tên (bắt buộc)</label>
                    <input
                      className="input"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Nguyễn Văn A"
                      disabled={busy || recording}
                    />
                  </div>

                  <div className="field">
                    <label>Email (bắt buộc)</label>
                    <input
                      className="input"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      disabled={busy || recording}
                    />
                  </div>
                </div>

                <div className="divider" style={{ marginTop: 12 }} />

                <div className="grid2">
                  <div className="field">
                    <label>Dialect</label>
                    <select className="select" value={dialect} onChange={(e) => setDialect(e.target.value as any)} disabled={busy || recording}>
                      {DIALECTS.map((d) => (
                        <option key={d} value={d}>
                          {d === "en-gb" ? "English (UK) — en-gb" : "English (US) — en-us"}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label>Chế độ chấm (premium)</label>
                    <select
                      className="select"
                      value={pronunciationScoreMode}
                      onChange={(e) => setPronunciationScoreMode(e.target.value as any)}
                      disabled={busy || recording}
                    >
                      <option value="default">Default</option>
                      <option value="strict">Strict</option>
                    </select>
                    <div className="muted" style={{ marginTop: 6 }}>
                      Strict thường khó hơn (phù hợp luyện thi / chấm gắt).
                    </div>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 10 }}>
                  <label className="row" style={{ gap: 10, cursor: "pointer" }}>
                    <input type="checkbox" checked={detectDialect} onChange={(e) => setDetectDialect(e.target.checked)} disabled={busy || recording} />
                    <span className="muted">Detect dialect (SpeechAce)</span>
                  </label>
                </div>
              </div>

              {/* TASK INPUT */}
              {task === "reading" ? (
                <div className="section">
                  <div className="sectionTitle">
                    <span>Reference text</span>
                    <span className="badge accentBadge">Words: {wordsCount(refText)}</span>
                  </div>

                  <div className="grid2">
                    <div className="field">
                      <label>Reference source</label>
                      <div className="row" style={{ flexWrap: "wrap" }}>
                        <button className={`btn3d ${mode === "library" ? "btnPrimary btnActive" : ""}`} onClick={() => setMode("library")} disabled={busy || recording}>
                          Văn mẫu
                        </button>
                        <button className={`btn3d ${mode === "custom" ? "btnPrimary btnActive" : ""}`} onClick={() => setMode("custom")} disabled={busy || recording}>
                          User dán text
                        </button>
                      </div>
                    </div>

                    <div className="field">
                      <label>Mẫu phát âm chuẩn</label>
                      <button
                        className="btn3d"
                        onClick={() => toggleTts(refText || selected?.text || "")}
                        disabled={busy || recording || wordsCount(refText || selected?.text || "") < 1}
                        style={{ width: "100%" }}
                      >
                        {ttsSpeaking ? "⏹ Stop mẫu (TTS)" : "🔈 Play mẫu (TTS)"}
                      </button>
                      <div className="muted" style={{ marginTop: 6 }}>
                        *Browser TTS (nếu SpeechAce không cung cấp audio mẫu).
                      </div>
                    </div>
                  </div>

                  <div className="divider" style={{ marginTop: 12 }} />

                  {mode === "library" ? (
                    <>
                      <div className="field">
                        <label>Chọn văn mẫu</label>
                        <select className="select" value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={busy || recording}>
                          {passages.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.title}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="divider" style={{ marginTop: 12 }} />

                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 14,
                          padding: 12,
                          background: "rgba(255,255,255,.92)",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.6,
                        }}
                      >
                        {selected?.text || ""}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="field">
                        <label>Tiêu đề (tuỳ chọn - để lưu vào thư viện)</label>
                        <input className="input" value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} disabled={busy || recording} placeholder="My passage" />
                      </div>

                      <div className="field" style={{ marginTop: 10 }}>
                        <label>Reference text (bắt buộc)</label>
                        <textarea className="textarea" value={customText} onChange={(e) => setCustomText(e.target.value)} disabled={busy || recording} placeholder="Dán đoạn bạn muốn user đọc..." />
                      </div>

                      <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
                        <button className="btn3d" onClick={addCustomPassageToLibrary} disabled={busy || recording}>
                          Lưu vào thư viện
                        </button>
                        <span className="badge accentBadge">Words: {wordsCount(customText)}</span>
                      </div>
                    </>
                  )}
                </div>
              ) : task === "open-ended" ? (
                <div className="section">
                  <div className="sectionTitle">
                    <span>Open-ended prompt</span>
                    <span className="badge accentBadge">IELTS: {ieltsObj ? "ON" : "n/a"}</span>
                  </div>
                  <div className="field">
                    <label>Prompt</label>
                    <textarea className="textarea" value={openPrompt} onChange={(e) => setOpenPrompt(e.target.value)} disabled={busy || recording} />
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Tip: nói tự nhiên 1–2 phút (API tối đa), nên có mở bài – thân bài – kết.
                  </div>
                </div>
              ) : (
                <div className="section">
                  <div className="sectionTitle">
                    <span>Relevance context</span>
                    <span className="badge accentBadge">Class: {relevanceClass ?? "n/a"}</span>
                  </div>
                  <div className="field">
                    <label>Context</label>
                    <textarea className="textarea" value={relevanceContext} onChange={(e) => setRelevanceContext(e.target.value)} disabled={busy || recording} />
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Tip: nói đúng trọng tâm đề bài để relevance lên TRUE.
                  </div>
                </div>
              )}

              {/* RECORD / UPLOAD */}
              <div className="section">
                <div className="sectionTitle">
                  <span>Ghi âm / Upload audio</span>
                  <span className="badge accentBadge">Recorder: {recorderName}</span>
                </div>

                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <button className="btn3d btnPrimary" onClick={() => void startRec()} disabled={busy || recording}>
                    🎙️ Bắt đầu ghi
                  </button>
                  <button className="btn3d btnDanger" onClick={() => void stopRec()} disabled={busy || !recording}>
                    ⏹ Dừng ({seconds}s)
                  </button>
                  <span className="badge accentBadge">Time: {seconds}s</span>
                </div>

                {busy ? (
                  <div className="muted" style={{ marginTop: 8 }}>
                    Đang upload &amp; chấm điểm... (đợi chút)
                  </div>
                ) : null}

                <div className="divider" style={{ marginTop: 12 }} />

                <div className="field">
                  <label>Upload audio file (mp3/wav/webm/…)</label>
                  <input
                    ref={fileInputRef}
                    key={`file-${task}`}
                    className="input fileInput"
                    type="file"
                    accept="audio/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      resetRunState(task);
                      updateTaskState({ uploadedFile: f }, task);
                    }}
                    disabled={busy || recording}
                  />

                  {uploadedFile ? (
                    <div className="muted" style={{ marginTop: 8 }}>
                      Selected: <b>{uploadedFile.name}</b>
                    </div>
                  ) : null}

                  <button
                    className="btn3d btnPrimary"
                    onClick={() => void scoreUploadedFile()}
                    disabled={busy || recording || !uploadedFile}
                    style={{ width: "100%", marginTop: 10 }}
                  >
                    Chấm file upload
                  </button>
                </div>

                <div className="muted" style={{ marginTop: 12 }}>
                  Kết quả sẽ hiển thị ở panel bên phải.
                </div>
              </div>
            </div>
          </aside>

          {/* RIGHT: RESULTS */}
          <main className="proMain">{resultsPanel}</main>
        </div>
      </div>

      <style jsx global>{`
        :root {
          --border: rgba(15, 23, 42, 0.12);
          --shadow: 0 18px 60px rgba(2, 6, 23, 0.2);
          --text: #0f172a;
          --muted: #475569;

          --accent: #6366f1;
          --accentSoft: rgba(99, 102, 241, 0.14);
          --accentBorder: rgba(99, 102, 241, 0.26);
          --accentText: #1e1b4b;

          --accentA: #6366f1;
          --accentB: #4338ca;
        }

        body {
          background: radial-gradient(1000px 700px at 10% 10%, rgba(99, 102, 241, 0.35), transparent 60%),
            radial-gradient(900px 650px at 90% 0%, rgba(34, 197, 94, 0.28), transparent 55%),
            linear-gradient(180deg, #0b1020, #0b1020);
        }

        .container {
          padding: 18px;
          max-width: 1220px;
          margin: 0 auto;
        }

        .card {
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 24px;
          box-shadow: var(--shadow);
          padding: 18px;
          backdrop-filter: blur(10px);
        }

        .h1 {
          color: #fff;
          font-size: 22px;
          font-weight: 900;
          letter-spacing: 0.2px;
        }

        .sub {
          color: rgba(255, 255, 255, 0.75);
          margin-top: 6px;
        }

        .proGrid {
          display: grid;
          grid-template-columns: 420px 1fr;
          gap: 16px;
          margin-top: 16px;
        }

        .proSide {
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid var(--border);
          border-radius: 22px;
          padding: 14px;
          box-shadow: 0 16px 40px rgba(2, 6, 23, 0.1);
        }

        .proMain {
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid var(--border);
          border-radius: 22px;
          padding: 16px;
          box-shadow: 0 16px 40px rgba(2, 6, 23, 0.1);
          min-height: 520px;
        }

        .sideTabs {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .sideTabs .btn3d {
          width: 100%;
          justify-content: flex-start;
        }

        .sideScroll {
          margin-top: 14px;
          max-height: calc(100vh - 220px);
          overflow: auto;
          padding-right: 6px;
        }

        .sideScroll::-webkit-scrollbar {
          width: 10px;
        }

        .sideScroll::-webkit-scrollbar-thumb {
          background: rgba(15, 23, 42, 0.18);
          border-radius: 999px;
          border: 3px solid rgba(255, 255, 255, 0.75);
        }

        .section {
          background: rgba(255, 255, 255, 0.98);
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 18px;
          padding: 14px;
          box-shadow: 0 10px 25px rgba(2, 6, 23, 0.06);
        }

        .section + .section {
          margin-top: 14px;
        }

        .sectionTitle {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 900;
          color: var(--text);
          margin-bottom: 10px;
        }

        .divider {
          height: 1px;
          background: rgba(15, 23, 42, 0.1);
          border: 0;
        }

        .muted {
          color: var(--muted);
          font-size: 13px;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(99, 102, 241, 0.12);
          border: 1px solid rgba(99, 102, 241, 0.22);
          color: #1e1b4b;
          font-weight: 800;
          font-size: 12px;
        }

        .accentBadge {
          background: var(--accentSoft) !important;
          border: 1px solid var(--accentBorder) !important;
          color: var(--accentText) !important;
        }

        .grid2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .row {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .input,
        .select,
        .textarea {
          width: 100%;
          border-radius: 14px;
          border: 1px solid rgba(15, 23, 42, 0.14);
          background: rgba(255, 255, 255, 0.98);
          padding: 10px 12px;
          outline: none;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
        }

        .textarea {
          min-height: 120px;
          resize: vertical;
        }

        /* 3D Buttons */
        .btn3d {
          border: 0;
          cursor: pointer;
          border-radius: 14px;
          padding: 11px 14px;
          font-weight: 900;
          color: #0b1020;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.8));
          box-shadow: 0 10px 0 rgba(15, 23, 42, 0.08), 0 16px 28px rgba(2, 6, 23, 0.12);
          transform: translateY(0);
          transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
          user-select: none;
        }

        .btn3d:hover {
          filter: brightness(1.02);
          transform: translateY(-1px);
        }

        .btn3d:active {
          transform: translateY(3px);
          box-shadow: 0 7px 0 rgba(15, 23, 42, 0.1), 0 10px 18px rgba(2, 6, 23, 0.14);
        }

        .btn3d:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          transform: none;
        }

        .btnPrimary {
          color: #fff;
          background: linear-gradient(180deg, #6366f1, #4338ca);
          box-shadow: 0 10px 0 rgba(67, 56, 202, 0.35), 0 16px 28px rgba(2, 6, 23, 0.22);
        }

        .btnDanger {
          color: #fff;
          background: linear-gradient(180deg, #fb7185, #ef4444);
          box-shadow: 0 10px 0 rgba(239, 68, 68, 0.28), 0 16px 28px rgba(2, 6, 23, 0.22);
        }

        .btnActive {
          outline: 3px solid rgba(255, 255, 255, 0.35);
        }

        /* ===== Theme vars per task (ONE PLACE) ===== */
        .themeReading {
          --tab1: #6366f1;
          --tab2: #4338ca;
          --tabShadow: rgba(67, 56, 202, 0.35);

          --accentA: #06b6d4;
          --accentB: #3b82f6;
          --accent: #3b82f6;
          --accentText: #083344;
          --accentSoft: rgba(6, 182, 212, 0.12);
          --accentBorder: rgba(6, 182, 212, 0.26);
        }

        .themeOpen {
          --tab1: #22c55e;
          --tab2: #16a34a;
          --tabShadow: rgba(22, 163, 74, 0.35);

          --accentA: #8b5cf6;
          --accentB: #6366f1;
          --accent: #6366f1;
          --accentText: #2e1065;
          --accentSoft: rgba(139, 92, 246, 0.12);
          --accentBorder: rgba(139, 92, 246, 0.26);
        }

        .themeRel {
          --tab1: #f59e0b;
          --tab2: #d97706;
          --tabShadow: rgba(217, 119, 6, 0.35);

          --accentA: #f97316;
          --accentB: #ef4444;
          --accent: #ef4444;
          --accentText: #7c2d12;
          --accentSoft: rgba(249, 115, 22, 0.12);
          --accentBorder: rgba(249, 115, 22, 0.26);
        }

        /* Tabs: inactive dim, active bright */
        .tabBtn {
          width: 100%;
          justify-content: flex-start;
          opacity: 0.55;
          background: rgba(255, 255, 255, 0.78);
          border: 1px solid rgba(15, 23, 42, 0.10);
          box-shadow: 0 10px 0 rgba(15, 23, 42, 0.06), 0 16px 28px rgba(2, 6, 23, 0.10);
        }

        .tabBtn:hover {
          opacity: 0.75;
        }

        .tabBtnActive {
          opacity: 1;
          color: #fff;
          background: linear-gradient(180deg, var(--tab1), var(--tab2));
          box-shadow: 0 10px 0 var(--tabShadow), 0 16px 28px rgba(2, 6, 23, 0.22);
        }

        .tabBtnActive:hover {
          filter: brightness(1.03);
        }

        /* Results header + dashboard */
        .resultsHeader {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 12px;
          padding: 14px;
          border-radius: 18px;
          border: 1px solid rgba(15, 23, 42, 0.1);
          background: radial-gradient(700px 240px at 20% 0%, var(--accentSoft), transparent 60%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.9));
          box-shadow: 0 10px 24px rgba(2, 6, 23, 0.06);
        }

        .resultsTitle {
          font-weight: 1000;
          font-size: 18px;
          color: var(--text);
          position: relative;
          padding-left: 10px;
        }

        .resultsTitle:before {
          content: "";
          position: absolute;
          left: 0;
          top: 3px;
          bottom: 3px;
          width: 6px;
          border-radius: 999px;
          background: var(--accent);
        }

        .resultsSub {
          color: var(--muted);
          font-size: 13px;
          margin-top: 4px;
          font-weight: 700;
        }

        .dashGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-top: 12px;
        }

        .metricCardPro {
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 18px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 10px 24px rgba(2, 6, 23, 0.06);
          border-left: 6px solid var(--accent);
        }

        .metricTop {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 10px;
        }

        .metricLabel {
          color: var(--muted);
          font-weight: 800;
          font-size: 12px;
        }

        .metricValue {
          font-weight: 1000;
          font-size: 22px;
        }

        .metricSub {
          margin-top: 8px;
          color: var(--muted);
          font-size: 12px;
          font-weight: 700;
        }

        .bar {
          height: 10px;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.08);
          overflow: hidden;
          margin-top: 10px;
        }

        .barFill {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--accentA), var(--accentB));
          width: 0%;
          transition: width 240ms ease;
        }

        .quickRow {
          display: grid;
          grid-template-columns: 1fr;
          gap: 10px;
          margin-top: 12px;
        }

        .quickCard {
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 18px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 10px 24px rgba(2, 6, 23, 0.06);
        }

        .quickTitle {
          font-weight: 1000;
          margin-bottom: 6px;
        }

        .quickText {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.55;
          font-weight: 700;
        }

        .issueWrap {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .issuePill {
          padding: 7px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 900;
          border: 1px solid rgba(15, 23, 42, 0.12);
          background: rgba(255, 255, 255, 0.9);
        }

        .issueWarn {
          background: rgba(245, 158, 11, 0.12);
          border-color: rgba(245, 158, 11, 0.22);
          color: #7c2d12;
        }

        .issueErr {
          background: rgba(239, 68, 68, 0.12);
          border-color: rgba(239, 68, 68, 0.22);
          color: #7f1d1d;
        }

        .issueInfo {
          background: rgba(99, 102, 241, 0.12);
          border-color: rgba(99, 102, 241, 0.22);
          color: #1e1b4b;
        }

        .relBox {
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 18px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 10px 24px rgba(2, 6, 23, 0.06);
          margin-top: 12px;
        }

        .relRow {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }

        .relPill {
          padding: 7px 12px;
          border-radius: 999px;
          font-weight: 1000;
          border: 1px solid rgba(15, 23, 42, 0.12);
        }

        .relTrue {
          background: rgba(34, 197, 94, 0.12);
          border-color: rgba(34, 197, 94, 0.22);
          color: #064e3b;
        }

        .relFalse {
          background: rgba(239, 68, 68, 0.12);
          border-color: rgba(239, 68, 68, 0.22);
          color: #7f1d1d;
        }

        .alertError {
          margin-top: 12px;
          padding: 12px;
          border-radius: 16px;
          border: 1px solid rgba(239, 68, 68, 0.28);
          background: rgba(239, 68, 68, 0.08);
          color: #7f1d1d;
          font-weight: 800;
        }

        /* Dashboard card */
        .dashCard {
          border: 1px solid rgba(15, 23, 42, 0.10);
          border-radius: 18px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 10px 24px rgba(2, 6, 23, 0.06);
        }

        .dashControls {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
          margin-top: 10px;
        }

        .historyList {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .historyRow {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          border: 1px solid rgba(15, 23, 42, 0.08);
          border-radius: 14px;
          padding: 10px;
          background: rgba(255, 255, 255, 0.98);
        }

        .btnTiny {
          padding: 8px 10px;
          border-radius: 12px;
        }

        /* Key-value list for relevance extra */
        .kvList {
          display: grid;
          gap: 8px;
        }

        .kvRow {
          display: grid;
          grid-template-columns: 160px 1fr;
          gap: 10px;
          padding: 10px;
          border-radius: 14px;
          border: 1px solid rgba(15, 23, 42, 0.08);
          background: rgba(255, 255, 255, 0.98);
        }

        .kvKey {
          font-weight: 900;
          color: rgba(15, 23, 42, 0.72);
        }

        .kvVal {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
          overflow-wrap: anywhere;
        }

        /* Responsive */
        @media (max-width: 980px) {
          .proGrid {
            grid-template-columns: 1fr;
          }
          .sideScroll {
            max-height: none;
          }
          .dashGrid {
            grid-template-columns: 1fr;
          }
          .dashControls {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .grid2 {
            grid-template-columns: 1fr !important;
          }
          .row {
            flex-wrap: wrap !important;
          }
          .btn3d {
            min-height: 44px;
            font-size: 16px;
          }
          .input,
          .select,
          .textarea,
          input[type="file"].fileInput {
            font-size: 16px !important;
          }
          input[type="file"].fileInput {
            height: auto !important;
            padding: 10px 12px !important;
          }
          .kvRow {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {renderPopups}
    </div>
  );
}
