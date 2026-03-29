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

type ExerciseSet = {
  id: string;
  title: string;
  task: "reading" | "open-ended";
  level: string;
  createdAt: number;
  newContent: { title: string; text: string };
  exercises: any[];
  answerKey: any;
  rubric: any;
};

const EXERCISE_STORAGE_KEY = "speechace_exercises_v1";
const EXERCISE_MAX = 50;

// ===== Multi-user localStorage =====
const USER_PROFILES_KEY = "speechace_user_profiles_v1";
const ACTIVE_USER_KEY = "speechace_active_user_v1";

// Danh sách lớp — chỉnh ở đây khi thêm/xóa lớp
const CLASS_LIST = [
  "10A1",
  "10A2",
  "10A3",
  "11B1",
  "11B2",
];

type UserProfile = {
  id: string; // email-based
  fullName: string;
  email: string;
  createdAt: number;
};

function loadUserProfiles(): UserProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(USER_PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveUserProfiles(profiles: UserProfile[]) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(USER_PROFILES_KEY, JSON.stringify(profiles)); } catch {}
}

function loadActiveUserId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(ACTIVE_USER_KEY) || "";
}

function saveActiveUserId(id: string) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(ACTIVE_USER_KEY, id); } catch {}
}

// mỗi user lưu exercises & answers riêng
function userExKey(userId: string) { return `speechace_ex_${userId}`; }
function userAnsKey(userId: string) { return `speechace_ans_${userId}`; }
function userHistKey(userId: string) { return `speechace_hist_${userId}`; }
function userResultsKey(userId: string) { return `speechace_results_${userId}`; }

// Save/load task results (result JSON only — không lưu File object hay audioUrl vì sẽ expire)
type PersistedResults = Partial<Record<Task, any>>;
function loadUserResults(userId: string): PersistedResults {
  if (!userId || typeof window === "undefined") return {};
  try { const r = localStorage.getItem(userResultsKey(userId)); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
function saveUserResults(userId: string, results: PersistedResults) {
  if (!userId || typeof window === "undefined") return;
  try { localStorage.setItem(userResultsKey(userId), JSON.stringify(results)); } catch {}
}

function loadUserExercises(userId: string): ExerciseSet[] {
  if (!userId || typeof window === "undefined") return [];
  try { const r = localStorage.getItem(userExKey(userId)); return r ? JSON.parse(r) : []; } catch { return []; }
}
function saveUserExercises(userId: string, items: ExerciseSet[]) {
  if (!userId || typeof window === "undefined") return;
  try { localStorage.setItem(userExKey(userId), JSON.stringify(items.slice(0, EXERCISE_MAX))); } catch {}
}
function loadUserAnswers(userId: string): Record<string, Record<string, any>> {
  if (!userId || typeof window === "undefined") return {};
  try { const r = localStorage.getItem(userAnsKey(userId)); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
function saveUserAnswers(userId: string, ans: Record<string, Record<string, any>>) {
  if (!userId || typeof window === "undefined") return;
  try { localStorage.setItem(userAnsKey(userId), JSON.stringify(ans)); } catch {}
}

function loadExercises(): ExerciseSet[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(EXERCISE_STORAGE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ExerciseSet[]) : [];
  } catch {
    return [];
  }
}

function saveExercises(items: ExerciseSet[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(EXERCISE_STORAGE_KEY, JSON.stringify(items.slice(0, EXERCISE_MAX)));
  } catch { }
}

function pushExercise(item: ExerciseSet) {
  const cur = loadExercises();
  saveExercises([item, ...cur].slice(0, EXERCISE_MAX));
}

function safeNum(v: any): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryEntry[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
  } catch { }
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
function seededShuffle<T>(arr: T[], seedStr: string): T[] {
  const a = [...arr];

  // tạo seed số từ string
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) {
    seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  }

  // xorshift32
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

function buildShuffledMcqView(
  q: any,
  correctRaw: string,
  seedKey: string
): { optionList: { k: string; v: string }[]; correct: string | null } {
  const letters = ["A", "B", "C", "D"];

  const opts = q?.options || {};
  const base = letters
    .filter((k) => typeof opts?.[k] === "string" && String(opts[k]).trim())
    .map((k) => ({ key: k, text: String(opts[k]).trim() }));

  if (!base.length) return { optionList: [], correct: null };

  const correctUpper = String(correctRaw || "").trim().toUpperCase();

  // Nếu correctRaw là A/B/C/D → dùng trực tiếp
  const correctLetter = letters.includes(correctUpper) ? correctUpper : null;

  // Nếu correctRaw là text → match theo text
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const correctTextNorm = correctLetter ? "" : norm(String(correctRaw || ""));

  const choices = base.map((it) => ({
    text: it.text,
    isCorrect:
      (correctLetter ? it.key === correctLetter : false) ||
      (!!correctTextNorm && norm(it.text) === correctTextNorm),
  }));

  // Xáo trộn ổn định theo seedKey (không bị đổi mỗi lần render)
  const shuffled = seededShuffle(choices, seedKey);

  // Gán lại nhãn A/B/C/D theo thứ tự mới
  const optionList = shuffled.slice(0, 4).map((c, idx) => ({
    k: letters[idx],
    v: c.text,
  }));

  const correctIdx = shuffled.findIndex((c) => c.isCorrect);
  const correct = correctIdx >= 0 ? letters[correctIdx] : null;

  return { optionList, correct };
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

type ExerciseAnswers = Record<string, Record<string, any>>; // exId -> itemId -> answer

export default function Page() {
  const [mounted, setMounted] = useState(false);

  const [task, setTask] = useState<Task>("reading");
  const [mode, setMode] = useState<Mode>("library");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [dialect, setDialect] = useState<Dialect>("en-us");

  // ===== Multi-user session =====
  const [activeUserId, setActiveUserId] = useState("");
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [userInfoLocked, setUserInfoLocked] = useState(false); // true = user đã lưu, đang trong session

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

  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [classCode, setClassCode] = useState(""); // lớp được chọn khi nộp bài
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false); // sidebar mobile

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

  // ===== Exercise generator (saved in localStorage) =====
  const [exerciseLoading, setExerciseLoading] = useState(false);
  const [exerciseErr, setExerciseErr] = useState<string | null>(null);
  const [exerciseVersion, setExerciseVersion] = useState(0);
  const [exerciseLevel, setExerciseLevel] = useState("B1");
  const [rightTab, setRightTab] = useState<"score" | "exercises">("score");
  const [revealAnswerMap, setRevealAnswerMap] = useState<Record<string, boolean>>({});

  const exercises = useMemo(() => {
    void exerciseVersion;
    return loadExercises();
  }, [exerciseVersion]);

  function deleteExerciseById(exIdToDelete: string) {
    if (typeof window === "undefined") return;

    const ok = window.confirm("Xóa bài tập này? (Không thể hoàn tác)");
    if (!ok) return;

    // 1) xóa khỏi danh sách exercises trong localStorage
    const nextList = exercises.filter((x) => x.id !== exIdToDelete);
    saveExercises(nextList);
    setExerciseVersion((v) => v + 1);

    // 2) xóa luôn đáp án đã lưu (nếu có)
    setExerciseAnswers((prev) => {
      const next = { ...(prev || {}) };
      delete next[exIdToDelete];
      return next;
    });

    // 3) nếu đang mở đúng bài vừa xóa -> chuyển sang bài khác (hoặc rỗng)
    if (openExerciseId === exIdToDelete) {
      setOpenExerciseId(nextList[0]?.id || "");
    }
  }

  // ✅ open exercise viewer
  const [openExerciseId, setOpenExerciseId] = useState<string>("");
  const [openExercise, setOpenExercise] = useState<ExerciseSet | null>(null);

  // ✅ answers store (localStorage)
  const EX_ANS_KEY = "speechace_exercise_answers_v1";
  const [exerciseAnswers, setExerciseAnswers] = useState<ExerciseAnswers>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(EX_ANS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") setExerciseAnswers(parsed);
    } catch { }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(EX_ANS_KEY, JSON.stringify(exerciseAnswers));
    } catch { }
  }, [exerciseAnswers]);

  function getExerciseAnswer(exId: string, itemId: string) {
    return exerciseAnswers?.[exId]?.[itemId] ?? null;
  }

  function setExerciseAnswer(exId: string, itemId: string, value: any) {
    setExerciseAnswers((prev) => {
      const next = { ...(prev || {}) };
      const exMap = { ...(next[exId] || {}) };
      exMap[itemId] = value;
      next[exId] = exMap;
      return next;
    });
  }

  function getOrInitArrayAnswer(exId: string, itemId: string, n: number) {
    const cur = getExerciseAnswer(exId, itemId);
    if (Array.isArray(cur) && cur.length === n) return cur as string[];
    return Array.from({ length: n }, () => "");
  }

  function setArrayAnswer(exId: string, itemId: string, arr: string[]) {
    setExerciseAnswer(exId, itemId, arr);
  }

  // keep openExercise synced
  useEffect(() => {
    if (!openExerciseId) {
      setOpenExercise(null);
      return;
    }
    const ex = exercises.find((x) => x.id === openExerciseId) || null;
    setOpenExercise(ex);
  }, [openExerciseId, exercises]);

  // if list has items but no selection yet -> select first
  useEffect(() => {
    if (!exercises.length) return;
    if (!openExerciseId) setOpenExerciseId(exercises[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercises.length]);

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

  useEffect(() => {
    setMounted(true);

    // ===== Restore active user session =====
    const profiles = loadUserProfiles();
    setUserProfiles(profiles);

    const savedId = loadActiveUserId();
    if (savedId) {
      const profile = profiles.find((p) => p.id === savedId);
      if (profile) {
        setFullName(profile.fullName);
        setEmail(profile.email);
        setActiveUserId(savedId);
        setUserInfoLocked(true);

        // load user-specific data
        const exs = loadUserExercises(savedId);
        if (exs.length) {
          saveExercises(exs);
          setExerciseVersion((v) => v + 1);
        }
        const ans = loadUserAnswers(savedId);
        if (Object.keys(ans).length) setExerciseAnswers(ans);

        // ✅ khôi phục kết quả chấm điểm đã lưu
        const savedResults = loadUserResults(savedId);
        if (Object.keys(savedResults).length) {
          setTaskState((prev) => {
            const next = { ...prev };
            for (const t of ["reading", "open-ended", "relevance"] as Task[]) {
              if (savedResults[t]) {
                next[t] = { ...prev[t], result: savedResults[t], audioUrl: null, audioUrlAt: null };
              }
            }
            return next;
          });
        }
      }
    }
  }, []);

  // ===== Auto-save exercises/answers per user =====
  useEffect(() => {
    if (!activeUserId) return;
    saveUserExercises(activeUserId, exercises);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercises, activeUserId]);

  useEffect(() => {
    if (!activeUserId) return;
    saveUserAnswers(activeUserId, exerciseAnswers);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseAnswers, activeUserId]);

  // ✅ Auto-save task results per user
  useEffect(() => {
    if (!activeUserId) return;
    const toSave: PersistedResults = {};
    for (const t of ["reading", "open-ended", "relevance"] as Task[]) {
      if (taskState[t].result) toSave[t] = taskState[t].result;
    }
    saveUserResults(activeUserId, toSave);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskState, activeUserId]);

  // ===== Save current user profile & lock session =====
  function saveCurrentUser() {
    const name = fullName.trim();
    const em = email.trim();
    if (!name || !em) return;

    const id = em.toLowerCase().replace(/[^a-z0-9@._-]/gi, "_");
    const isNewUser = id !== activeUserId;

    // save/update profile
    const profiles = loadUserProfiles();
    const existing = profiles.findIndex((p) => p.id === id);
    const profile: UserProfile = { id, fullName: name, email: em, createdAt: Date.now() };
    if (existing >= 0) {
      profiles[existing] = profile;
    } else {
      profiles.push(profile);
    }
    saveUserProfiles(profiles);
    setUserProfiles(profiles);

    // save OLD user's data before switching
    if (activeUserId && isNewUser) {
      saveUserExercises(activeUserId, exercises);
      saveUserAnswers(activeUserId, exerciseAnswers);
      const curResults: PersistedResults = {};
      for (const t of ["reading", "open-ended", "relevance"] as Task[]) {
        if (taskState[t].result) curResults[t] = taskState[t].result;
      }
      saveUserResults(activeUserId, curResults);
    }

    // set active
    saveActiveUserId(id);
    setActiveUserId(id);
    setUserInfoLocked(true);

    if (isNewUser) {
      // NEW user: load their data (empty for brand new, or existing if they used before)
      const exs = loadUserExercises(id);
      saveExercises(exs);
      setExerciseVersion((v) => v + 1);
      setExerciseAnswers(loadUserAnswers(id));
      setOpenExerciseId(exs[0]?.id || "");

      // reset task state then restore if they have saved results
      const savedResults = loadUserResults(id);
      setTaskState({
        reading: { result: savedResults.reading || null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
        "open-ended": { result: savedResults["open-ended"] || null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
        relevance: { result: savedResults.relevance || null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
      });
      setSendOk(false);
      setSendErr(null);
    } else {
      // SAME user (re-save): just persist current data
      saveUserExercises(id, exercises);
      saveUserAnswers(id, exerciseAnswers);
    }
  }

  // ===== Switch to a different user =====
  function switchToUser(userId: string) {
    if (userId === activeUserId) return;

    // save current user's data first
    if (activeUserId) {
      saveUserExercises(activeUserId, exercises);
      saveUserAnswers(activeUserId, exerciseAnswers);
      // save results
      const curResults: PersistedResults = {};
      for (const t of ["reading", "open-ended", "relevance"] as Task[]) {
        if (taskState[t].result) curResults[t] = taskState[t].result;
      }
      saveUserResults(activeUserId, curResults);
    }

    const profiles = loadUserProfiles();
    const profile = profiles.find((p) => p.id === userId);
    if (!profile) return;

    // reset all task state (clean slate)
    setTaskState({
      reading: { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
      "open-ended": { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
      relevance: { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
    });
    setSendOk(false);
    setSendErr(null);

    // load new user
    setFullName(profile.fullName);
    setEmail(profile.email);
    setActiveUserId(userId);
    saveActiveUserId(userId);
    setUserInfoLocked(true);

    // load user-specific exercises & answers
    const exs = loadUserExercises(userId);
    saveExercises(exs);
    setExerciseVersion((v) => v + 1);

    const ans = loadUserAnswers(userId);
    setExerciseAnswers(ans);

    // ✅ restore task results của user mới
    const savedResults = loadUserResults(userId);
    setTaskState((prev) => {
      const next = {
        reading: { ...prev.reading, result: null, audioUrl: null, audioUrlAt: null },
        "open-ended": { ...prev["open-ended"], result: null, audioUrl: null, audioUrlAt: null },
        relevance: { ...prev.relevance, result: null, audioUrl: null, audioUrlAt: null },
      };
      for (const t of ["reading", "open-ended", "relevance"] as Task[]) {
        if (savedResults[t]) next[t] = { ...next[t], result: savedResults[t] };
      }
      return next;
    });

    setOpenExerciseId(exs[0]?.id || "");
  }

  // ===== Unlock to change user / create new =====
  function logoutUser() {
    // save current user's data
    if (activeUserId) {
      saveUserExercises(activeUserId, exercises);
      saveUserAnswers(activeUserId, exerciseAnswers);
    }

    setUserInfoLocked(false);
    setFullName("");
    setEmail("");
    setActiveUserId("");
    saveActiveUserId("");

    // reset task state
    setTaskState({
      reading: { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
      "open-ended": { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
      relevance: { result: null, err: null, audioUrl: null, audioUrlAt: null, uploadedFile: null },
    });
    saveExercises([]);
    setExerciseVersion((v) => v + 1);
    setExerciseAnswers({});
    setOpenExerciseId("");
    setSendOk(false);
    setSendErr(null);
  }

  // Đổi tab: reset DOM file input + reset state uploadedFile của tab đang vào
  useEffect(() => {
    try {
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch { }
    setRightTab("score");
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
    } catch { }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      try {
        const synth: any = (window as any).speechSynthesis;
        synth?.cancel?.();
      } catch { }
    };
  }, []);

  function canStart() {
    return fullName.trim() && email.trim() && userInfoLocked;
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
    } catch { }
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
    } catch { }
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
        } catch { }
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
    } catch { }

    if (!a.src) {
      const url = await ensureFreshAudioUrl();
      if (!url) return;
    }

    const doSeekPlay = async () => {
      if (token !== playTokenRef.current) return;

      try {
        a.currentTime = Math.max(0, startSec);
      } catch { }

      segmentRef.current = { endSec, token };

      void a.play().catch(() => { });

      const ms = Math.max(80, Math.round((endSec - startSec) * 1000) + 60);
      segmentTimerRef.current = setTimeout(() => {
        const seg = segmentRef.current;
        if (!seg || seg.token !== token) return;

        try {
          a.pause();
        } catch { }
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
    } catch { }
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

    if (!canStart()) return updateTaskState({ err: "Bạn phải nhập Họ tên + Email rồi bấm 💾 Lưu thông tin trước khi bắt đầu." });
    if (task === "reading" && wordsCount(refText) < 1)
      return updateTaskState({ err: "Bạn phải nạp Reference text trước khi ghi âm." });

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

      const uploadReq = await fetch("/api/upload-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentType: audioBlob.type || "application/octet-stream" }),
      });
      const uploadText = await uploadReq.text();
      let up: any;
      try {
        up = JSON.parse(uploadText);
      } catch (e) {
        throw new Error(`Upload API returned non-JSON: ${uploadText.slice(0, 100)}...`);
      }

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

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const raw = await res.text();
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
      } catch { }
    } catch (e: any) {
      updateTaskState({ err: e?.message || "Error" }, t);
    } finally {
      setBusy(false);
    }
  }
  async function sendToTelegram() {
    try {
      setSendErr(null);
      setSendOk(false);
      setSending(true);

      // ✅ Thu thập kết quả từ TẤT CẢ các task (reading, open-ended, relevance)
      const allTasks: Task[] = ["reading", "open-ended", "relevance"];
      const taskResults: { task: string; result: any; audioUrl: string | null }[] = [];

      for (const t of allTasks) {
        const st = taskState[t];
        if (!st.result) continue; // bỏ qua task chưa có kết quả

        // Lấy presigned audio URL cho task này
        let freshUrl: string | null = null;
        const audioKey = st.result?.audioKey;
        if (audioKey) {
          try {
            const r = await fetch(`/api/audio-url?key=${encodeURIComponent(audioKey)}`);
            const j = await r.json();
            freshUrl = j?.url || null;
          } catch {
            freshUrl = st.audioUrl || null;
          }
        }

        taskResults.push({
          task: t,
          result: st.result,
          audioUrl: freshUrl,
        });
      }

      const payload = {
        fullName: fullName.trim(),
        email: email.trim(),
        dialect,
        classCode: classCode.trim(), // ✅ lớp học
        // ✅ gửi toàn bộ kết quả của tất cả các phần đã làm
        taskResults,
        // tương thích ngược
        task,
        result: result ?? null,
        audioUrl: taskResults.find((x) => x.task === task)?.audioUrl ?? null,

        // ✅ gửi toàn bộ bài tập đã lưu + đáp án
        exercises: exercises ?? [],
        exerciseAnswers: exerciseAnswers ?? {},
      };

      const r = await fetch("/api/telegram-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "Send failed");

      setSendOk(true);
    } catch (e: any) {
      setSendErr(e?.message || "Send failed");
    } finally {
      setSending(false);
    }
  }

  async function scoreUploadedFile() {
    resetRunState(task);
    if (!uploadedFile) return;
    if (!canStart()) return updateTaskState({ err: "Bạn phải nhập Họ tên + Email trước khi bắt đầu." });
    if (task === "reading" && wordsCount(refText) < 1)
      return updateTaskState({ err: "Bạn phải nạp Reference text trước khi chấm." });
    await uploadThenScore(uploadedFile, undefined, task);
  }

  async function generateExerciseNow() {
    try {
      setExerciseErr(null);
      setExerciseLoading(true);

      if (!canStart()) {
        setExerciseErr("Bạn phải nhập Họ tên + Email rồi bấm 💾 Lưu thông tin trước.");
        return;
      }

      // chỉ hỗ trợ reading/open-ended
      if (task === "relevance") {
        setExerciseErr("Chưa hỗ trợ tạo bài tập cho Relevance.");
        return;
      }

      const source = task === "reading" ? (refText || selected?.text || "").trim() : openPrompt.trim();

      if (!source) {
        setExerciseErr("Chưa có nội dung nguồn để tạo bài tập (text/prompt đang trống).");
        return;
      }

      const r = await fetch("/api/generate-exercise", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task,
          sourceText: source,
          level: exerciseLevel,
          targetSeconds: 90,
        }),
      });

      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "Generate failed");

      const ex = j?.exercise as ExerciseSet;
      if (!ex?.id) throw new Error("API trả về thiếu exercise");

      pushExercise(ex);
      setExerciseVersion((v) => v + 1);

      setOpenExerciseId(ex.id);
      setRightTab("exercises");
    } catch (e: any) {
      setExerciseErr(e?.message || "Error");
    } finally {
      setExerciseLoading(false);
    }
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
        } catch { }
        segmentRef.current = null;
        stopSegmentTimer();
      }
    };

    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [audioUrl]);

  const recorderName = mounted ? (hasMediaRecorder() ? "MediaRecorder" : "WAV fallback") : "Detecting...";

  const overall =
    task === "reading"
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
                background: "var(--card-s)",
                boxShadow: "0 18px 40px rgba(0,0,0,.45)",
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
        </>,
        document.body
      )
      : null;

  const themeClass = task === "reading" ? "themeReading" : task === "open-ended" ? "themeOpen" : "themeRel";

  const scoreObj =
    task === "reading"
      ? speechace?.text_score?.speechace_score ?? speechace?.speechace_score ?? null
      : speechace?.speech_score?.speechace_score ?? speechace?.speechace_score ?? null;

  // ★ Memoize score metrics grid so it does NOT re-render when clickPop/other unrelated state changes
  const memoizedScoreGrid = useMemo(() => {
    if (typeof overall !== "number") return null;
    return (
      <div style={{ display: "flex", gap: 20, alignItems: "center", marginTop: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <div className="metricsGrid" style={{ width: "100%", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* OVERALL */}
          <div className="scoreMetricCard">
            <div className={`scoreRing ${overall >= 80 ? "scoreRingGood" : overall >= 60 ? "scoreRingWarn" : "scoreRingBad"}`} style={{ width: 85, height: 85, fontSize: 26, borderWidth: 4 }}>
              {overall.toFixed(0)}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text2)", letterSpacing: 1 }}>OVERALL</div>
          </div>
          {/* PRONUNCIATION */}
          <div className="scoreMetricCard">
            <div className={`scoreRing ${scoreObj?.pronunciation >= 80 ? "scoreRingGood" : scoreObj?.pronunciation >= 60 ? "scoreRingWarn" : scoreObj?.pronunciation != null ? "scoreRingBad" : "scoreRingNA"}`} style={{ width: 85, height: 85, fontSize: 26, borderWidth: 4 }}>
              {scoreObj?.pronunciation != null ? Number(scoreObj.pronunciation).toFixed(0) : "n/a"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text2)", letterSpacing: 1 }}>PRONUNCIATION</div>
          </div>
          {/* FLUENCY */}
          <div className="scoreMetricCard">
            <div className={`scoreRing ${scoreObj?.fluency >= 80 ? "scoreRingGood" : scoreObj?.fluency >= 60 ? "scoreRingWarn" : scoreObj?.fluency != null ? "scoreRingBad" : "scoreRingNA"}`} style={{ width: 85, height: 85, fontSize: 26, borderWidth: 4 }}>
              {scoreObj?.fluency != null ? Number(scoreObj.fluency).toFixed(0) : "n/a"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text2)", letterSpacing: 1 }}>FLUENCY</div>
          </div>
          {/* GRAMMAR */}
          <div className="scoreMetricCard">
            <div className={`scoreRing ${scoreObj?.grammar >= 80 ? "scoreRingGood" : scoreObj?.grammar >= 60 ? "scoreRingWarn" : scoreObj?.grammar != null ? "scoreRingBad" : "scoreRingNA"}`} style={{ width: 85, height: 85, fontSize: 26, borderWidth: 4 }}>
              {task === "reading" ? "n/a" : scoreObj?.grammar != null ? Number(scoreObj.grammar).toFixed(0) : "n/a"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text2)", letterSpacing: 1 }}>GRAMMAR</div>
          </div>
          {/* COHERENCE */}
          <div className="scoreMetricCard">
            <div className={`scoreRing ${scoreObj?.coherence >= 80 ? "scoreRingGood" : scoreObj?.coherence >= 60 ? "scoreRingWarn" : scoreObj?.coherence != null ? "scoreRingBad" : "scoreRingNA"}`} style={{ width: 85, height: 85, fontSize: 26, borderWidth: 4 }}>
              {task === "reading" ? "n/a" : scoreObj?.coherence != null ? Number(scoreObj.coherence).toFixed(0) : "n/a"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text2)", letterSpacing: 1 }}>COHERENCE</div>
          </div>
          {/* VOCAB */}
          <div className="scoreMetricCard">
            <div className={`scoreRing ${scoreObj?.vocab >= 80 ? "scoreRingGood" : scoreObj?.vocab >= 60 ? "scoreRingWarn" : scoreObj?.vocab != null ? "scoreRingBad" : "scoreRingNA"}`} style={{ width: 85, height: 85, fontSize: 26, borderWidth: 4 }}>
              {task === "reading" ? "n/a" : scoreObj?.vocab != null ? Number(scoreObj.vocab).toFixed(0) : "n/a"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text2)", letterSpacing: 1 }}>VOCABULARY</div>
          </div>
        </div>
      </div>
    );
  }, [overall, scoreObj, task]);

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

  const renderExercisesPanel = () => {
    return (
      <div>
        <div className="divider" style={{ marginTop: 14 }} />
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <div style={{ fontWeight: 1000 }}>🧩 Bài tập</div>
          <span className="badge accentBadge">Tổng: {exercises.length}</span>
        </div>

        {!exercises.length ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Chưa có bài tập. Bấm “Tạo bài tập mới” ở menu trái.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Cột trên: danh sách bài tập */}
            <div className="exList">
              <div style={{ display: "grid", gap: 10 }}>
                {exercises.map((ex) => (
                  <div key={ex.id} className="quickCard">
                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontWeight: 1000 }}>{ex.title}</div>
                      <span className="badge accentBadge">
                        {ex.task} • {ex.level}
                      </span>
                    </div>

                    <div className="muted" style={{ marginTop: 6 }}>
                      New: <b>{ex.newContent?.title}</b>
                    </div>

                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <button
                        className={`btn3d ${openExerciseId === ex.id ? "btnPrimary" : ""}`}
                        onClick={() => {
                          setOpenExerciseId(ex.id);
                          setRightTab("exercises");
                        }}
                      >
                        {openExerciseId === ex.id ? "✅ Đang mở" : "📌 Mở"}
                      </button>

                      {ex.task === "reading" ? (
                        <button
                          className="btn3d"
                          onClick={() => {
                            setTask("reading");
                            setMode("custom");
                            setCustomTitle(ex.newContent?.title || "Generated passage");
                            setCustomText(ex.newContent?.text || "");
                            setRightTab("score");
                          }}
                        >
                          Dùng làm Reading
                        </button>
                      ) : null}

                      {ex.task === "open-ended" ? (
                        <button
                          className="btn3d"
                          onClick={() => {
                            setTask("open-ended");
                            setOpenPrompt(ex.newContent?.text || "");
                            setRightTab("score");
                          }}
                        >
                          Dùng làm Prompt
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn3d btnTiny btnDanger"
                        title="Xóa bài tập"
                        onClick={() => deleteExerciseById(ex.id)}
                        style={{
                          padding: "2px 2.5px",
                          minWidth: 6,
                          justifyContent: "center",
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Cột phải: viewer bài tập */}
            <div className="exViewer">
              {!openExercise ? (
                <div className="quickCard">
                  <div style={{ fontWeight: 1000 }}>Chưa chọn bài tập</div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Bấm “Mở” ở danh sách bên trái để xem chi tiết.
                  </div>
                </div>
              ) : (
                <div className="quickCard">
                  <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontWeight: 1000 }}>{openExercise.title}</div>
                    <span className="badge accentBadge">
                      {openExercise.task} • {openExercise.level}
                    </span>
                  </div>

                  <div className="muted" style={{ marginTop: 8 }}>
                    New content: <b>{openExercise.newContent?.title}</b>
                  </div>

                  <div
                    style={{
                      marginTop: 10,
                      padding: 12,
                      borderRadius: 14,
                      border: "1px solid var(--border2)",
                      background: "var(--surface2)",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.65,
                      color: "var(--text)",
                    }}
                  >
                    {openExercise.newContent?.text || ""}
                  </div>

                  <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                    <button className="btn3d" onClick={() => toggleTts(openExercise.newContent?.text || "")}>
                      {ttsSpeaking ? "⏹ Stop mẫu (TTS)" : "🔈 Nghe New content (TTS)"}
                    </button>
                  </div>

                  <div className="divider" style={{ marginTop: 12 }} />
                  <div style={{ fontWeight: 1000, marginTop: 10 }}>📝 Câu hỏi</div>

                  <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
                    {(() => {
                      const items = Array.isArray(openExercise.exercises) ? openExercise.exercises : [];
                      const byType = (t: string) => items.find((x: any) => String(x?.type || "").toLowerCase() === t);

                      const mcq = byType("mcq");
                      const gap = byType("gap_fill");
                      const vocab = byType("vocab_pack");
                      const pron = byType("pronunciation_drill");
                      const spk = byType("speaking_outline");
                      const mis = byType("common_mistakes");

                      const exId = openExercise.id;

                      return (
                        <>
                          {/* 1) MCQ */}
                          {mcq ? (
                            <div className="quickCard" style={{ borderLeft: "6px solid var(--accent)" }}>
                              <div style={{ fontWeight: 1000 }}>1) Trắc nghiệm (MCQ)</div>
                              <div className="muted" style={{ marginTop: 6 }}>
                                Chọn đáp án A/B/C/D
                              </div>

                              <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
                                {(Array.isArray((mcq as any).questions) ? (mcq as any).questions : []).map(
                                  (q: any, idx: number) => {
                                    const qid = String(q?.id || `q${idx + 1}`);
                                    const userAns = String(getExerciseAnswer(exId, qid) || "").trim().toUpperCase();

                                    const correctRaw = String(q?.answer ?? openExercise.answerKey?.[qid] ?? "").trim();
                                    const mcqView = buildShuffledMcqView(q, correctRaw, `mcq:${exId}:${qid}`);

                                    const optionList = mcqView.optionList;
                                    const correct = mcqView.correct;

                                    const locked = !!userAns; // ✅ đã chọn thì khóa luôn
                                    const isCorrect =
                                      locked && correct
                                        ? String(userAns).trim().toUpperCase() === String(correct).trim().toUpperCase()
                                        : false;


                                    return (
                                      <div
                                        key={qid}
                                        style={{ border: "1px solid rgba(15,23,42,.08)", borderRadius: 14, padding: 10 }}
                                      >
                                        <div
                                          className="row"
                                          style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}
                                        >
                                          <div style={{ fontWeight: 900 }}>
                                            {idx + 1}. {String(q?.q || q?.question || "(Không có câu hỏi)")}
                                          </div>
                                          {userAns ? (
                                            <span className={`badge ${isCorrect ? "accentBadge" : ""}`}>
                                              {isCorrect ? "✅ Đúng" : "❌ Sai"}
                                            </span>
                                          ) : (
                                            <span className="badge">Chưa chọn</span>
                                          )}
                                        </div>

                                        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                                          {optionList.map((op) => {
                                            const isSelected = userAns === op.k;

                                            // ✅ đúng: màu xanh
                                            const isCorrectOpt = locked && correct && op.k === correct;

                                            // ✅ sai: lựa chọn của user màu đỏ
                                            const isWrongSelected = locked && correct && isSelected && op.k !== correct;

                                            const boxStyle: CSSProperties = isCorrectOpt
                                              ? { border: "1px solid rgba(34,197,94,.40)", background: "rgba(34,197,94,.12)" }
                                              : isWrongSelected
                                                ? { border: "1px solid rgba(239,68,68,.40)", background: "rgba(239,68,68,.12)" }
                                                : { border: "1px solid rgba(15,23,42,.08)", background: "transparent" };

                                            const textStyle: CSSProperties = isCorrectOpt
                                              ? { color: "rgb(21 128 61)", fontWeight: 900 }
                                              : isWrongSelected
                                                ? { color: "rgb(185 28 28)", fontWeight: 900 }
                                                : {};

                                            return (
                                              <label
                                                key={op.k}
                                                className="row"
                                                style={{
                                                  gap: 10,
                                                  cursor: locked ? "default" : "pointer",
                                                  padding: 8,
                                                  borderRadius: 12,
                                                  ...boxStyle,
                                                }}
                                              >
                                                <input
                                                  type="radio"
                                                  name={`${exId}::${qid}`}
                                                  checked={isSelected}
                                                  disabled={locked} // ✅ khóa sau khi chọn
                                                  onChange={() => {
                                                    if (locked) return;
                                                    setExerciseAnswer(exId, qid, op.k);
                                                  }}
                                                />
                                                <span style={textStyle}>
                                                  <b>{op.k}.</b> {op.v}
                                                </span>
                                              </label>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  }
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="muted">Thiếu item type="mcq" trong exercises[]</div>
                          )}

                          {/* 2) GAP FILL */}
                          {gap ? (
                            <div className="quickCard" style={{ borderLeft: "6px solid var(--accent)" }}>
                              <div style={{ fontWeight: 1000 }}>2) Điền từ (Gap fill)</div>

                              {(() => {
                                const itemId = String((gap as any).id || "gap1");
                                const text = String((gap as any).text || "");

                                const bank: string[] = Array.isArray((gap as any).bank) ? (gap as any).bank.map(String) : [];

                                const correctArr: string[] = Array.isArray((gap as any).answers)
                                  ? (gap as any).answers.map(String)
                                  : Array.isArray(openExercise.answerKey?.[itemId])
                                    ? openExercise.answerKey[itemId].map(String)
                                    : [];

                                // ✅ Đếm blanks chuẩn:
                                // - Nếu text có (1)(2)(3) → đếm theo số thứ tự
                                // - Nếu text có ________ → đếm theo cụm "_" dài (>=3 dấu _ tính là 1 blank)
                                const numberedCount = (text.match(/\(\d+\)/g) || []).length;
                                const underscoreRuns = (text.match(/_{3,}/g) || []).length;

                                // Lấy số lớn nhất để không bị thiếu ô
                                const blanks = Math.max(numberedCount, underscoreRuns, correctArr.length, 4);

                                const ans = getOrInitArrayAnswer(exId, itemId, blanks);

                                // ✅ key ổn định để lưu trạng thái “Kiểm tra / Ẩn đáp án”
                                const revealKey = `gap:${exId}:${itemId}`;
                                const reveal = !!revealAnswerMap[revealKey];

                                // ✅ xáo trộn word bank ổn định theo bài
                                const bankShuffled = seededShuffle(bank, revealKey);

                                const fillFirstEmpty = (w: string) => {
                                  const next = [...ans];
                                  const i = next.findIndex((x) => !String(x || "").trim());
                                  if (i >= 0) {
                                    next[i] = w;
                                    setArrayAnswer(exId, itemId, next);
                                  }
                                };

                                return (
                                  <>
                                    <div className="muted" style={{ marginTop: 6 }}>
                                      Bấm từ trong “Word bank” để điền nhanh, hoặc tự gõ.
                                      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
                                        <button
                                          type="button"
                                          className="btn3d btnTiny"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setRevealAnswerMap((prev) => ({ ...prev, [revealKey]: !reveal }));
                                          }}
                                        >
                                          {reveal ? "Ẩn đáp án" : "Kiểm tra"}
                                        </button>
                                      </div>
                                    </div>

                                    <div style={{ marginTop: 10, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{text}</div>

                                    {bankShuffled.length ? (
                                      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                                        {bankShuffled.map((w, i) => (
                                          <button
                                            type="button"
                                            key={`${revealKey}:w:${i}`}
                                            className="btn3d btnTiny"
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              fillFirstEmpty(w);
                                            }}
                                          >
                                            {w}
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}

                                    <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                                      {Array.from({ length: blanks }).map((_, i) => {
                                        const user = ans[i] || "";
                                        const correct = String(correctArr[i] || "");

                                        const locked = !!String(user || "").trim(); // ✅ đã điền thì khóa
                                        const ok = locked && correct ? user.trim().toLowerCase() === correct.trim().toLowerCase() : false;
                                        const show = reveal; // ✅ chỉ hiện đáp án khi bấm "Kiểm tra"

                                        return (
                                          <div key={`${revealKey}:blank:${i}`} className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                                            <span className="badge">Ô trống {i + 1}</span>

                                            <input
                                              className="input"
                                              value={user}
                                              disabled={locked} // ✅ khóa
                                              onClick={(e) => e.stopPropagation()}
                                              onFocus={(e) => e.stopPropagation()}
                                              onChange={(e) => {
                                                if (locked) return;
                                                const next = [...ans];
                                                next[i] = e.target.value;
                                                setArrayAnswer(exId, itemId, next);
                                              }}
                                              placeholder="Điền đáp án..."
                                              style={{
                                                maxWidth: 320,
                                                borderColor: locked && show ? (ok ? "rgba(34,197,94,.40)" : "rgba(239,68,68,.40)") : undefined,
                                              }}
                                            />

                                            {show && locked && correct ? (
                                              ok ? (
                                                <span style={{ color: "rgb(21 128 61)", fontWeight: 1000 }}>✅ Đúng</span>
                                              ) : (
                                                <>
                                                  <span style={{ color: "rgb(185 28 28)", fontWeight: 1000 }}>❌ Sai</span>
                                                  <span style={{ color: "rgb(21 128 61)", fontWeight: 1000 }}>
                                                    Đáp án đúng: <b>{correct}</b>
                                                  </span>
                                                </>
                                              )
                                            ) : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </>
                                );
                              })()}

                            </div>
                          ) : (
                            <div className="muted">Thiếu item type="gap_fill"</div>
                          )}

                          {/* 3) VOCAB PACK */}
                          {vocab ? (
                            <div className="quickCard" style={{ borderLeft: "6px solid var(--accent)" }}>
                              <div style={{ fontWeight: 1000 }}>3) Từ vựng (Vocab pack)</div>

                              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                                {(Array.isArray((vocab as any).items) ? (vocab as any).items : []).map(
                                  (it: any, i: number) => (
                                    <div
                                      key={i}
                                      style={{ border: "1px solid rgba(15,23,42,.08)", borderRadius: 14, padding: 10 }}
                                    >
                                      <div style={{ fontWeight: 1000 }}>{String(it?.word || "")}</div>
                                      <div className="muted" style={{ marginTop: 6 }}>
                                        Nghĩa: <b>{String(it?.meaning_vi || "")}</b>
                                      </div>
                                      {it?.collocation ? (
                                        <div className="muted" style={{ marginTop: 6 }}>
                                          Collocation: <b>{String(it.collocation)}</b>
                                        </div>
                                      ) : null}
                                      {it?.example ? (
                                        <div className="muted" style={{ marginTop: 6 }}>
                                          Example: <b>{String(it.example)}</b>
                                        </div>
                                      ) : null}
                                    </div>
                                  )
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="muted">Thiếu item type="vocab_pack"</div>
                          )}

                          {/* 4) PRONUNCIATION DRILL */}
                          {pron ? (
                            <div className="quickCard" style={{ borderLeft: "6px solid var(--accent)" }}>
                              <div style={{ fontWeight: 1000 }}>4) Luyện phát âm (Pronunciation drill)</div>

                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontWeight: 900 }}>Cặp âm dễ nhầm</div>
                                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                                  {(Array.isArray((pron as any).minimalPairs)
                                    ? (pron as any).minimalPairs
                                    : []
                                  ).map((p: any, i: number) => (
                                    <div
                                      key={i}
                                      className="row"
                                      style={{ justifyContent: "space-between", flexWrap: "wrap" }}
                                    >
                                      <div>
                                        <b>{String(p?.[0] || "")}</b> ↔ <b>{String(p?.[1] || "")}</b>
                                      </div>
                                      <button
                                        className="btn3d btnTiny"
                                        onClick={() => toggleTts(`${p?.[0] || ""} ... ${p?.[1] || ""}`)}
                                      >
                                        🔈 Nghe mẫu (TTS)
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <div className="divider" style={{ marginTop: 12 }} />

                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontWeight: 900 }}>Shadowing sentences</div>
                                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                                  {(Array.isArray((pron as any).shadowingSentences)
                                    ? (pron as any).shadowingSentences
                                    : []
                                  ).map((s: any, i: number) => (
                                    <div
                                      key={i}
                                      className="row"
                                      style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}
                                    >
                                      <div style={{ lineHeight: 1.6, flex: 1 }}>{String(s || "")}</div>
                                      <button className="btn3d btnTiny" onClick={() => toggleTts(String(s || ""))}>
                                        🔈 Nghe mẫu (TTS)
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="muted">Thiếu item type="pronunciation_drill"</div>
                          )}

                          {/* 5) SPEAKING OUTLINE */}
                          {spk ? (
                            <div className="quickCard" style={{ borderLeft: "6px solid var(--accent)" }}>
                              <div style={{ fontWeight: 1000 }}>5) Dàn ý nói (Speaking outline)</div>

                              {(() => {
                                const itemId = String((spk as any).id || "spk1");
                                const outline = (spk as any).outline || {};
                                const followUps: string[] = Array.isArray((spk as any).followUps)
                                  ? (spk as any).followUps.map(String)
                                  : [];
                                const draft = String(getExerciseAnswer(exId, itemId) || "");

                                const list = (arr: any) =>
                                  Array.isArray(arr) ? (
                                    <ul className="exUl">
                                      {arr.map((x: any, i: number) => (
                                        <li key={i}>{String(x)}</li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <div className="muted">Không có dữ liệu</div>
                                  );

                                return (
                                  <>
                                    <div style={{ marginTop: 10 }}>
                                      <div style={{ fontWeight: 900 }}>Mở bài</div>
                                      {list(outline.intro)}
                                    </div>
                                    <div style={{ marginTop: 10 }}>
                                      <div style={{ fontWeight: 900 }}>Thân bài</div>
                                      {list(outline.body)}
                                    </div>
                                    <div style={{ marginTop: 10 }}>
                                      <div style={{ fontWeight: 900 }}>Kết bài</div>
                                      {list(outline.conclusion)}
                                    </div>

                                    {followUps.length ? (
                                      <div style={{ marginTop: 10 }}>
                                        <div style={{ fontWeight: 900 }}>Câu hỏi phụ</div>
                                        {list(followUps)}
                                      </div>
                                    ) : null}

                                    <div className="divider" style={{ marginTop: 12 }} />

                                    <div style={{ marginTop: 10, fontWeight: 900 }}>Bài nói của bạn (nháp)</div>
                                    <textarea
                                      className="textarea"
                                      value={draft}
                                      onChange={(e) => setExerciseAnswer(exId, itemId, e.target.value)}
                                      placeholder="Gõ dàn ý / bài nói của bạn..."
                                      style={{ minHeight: 110, marginTop: 8 }}
                                    />
                                  </>
                                );
                              })()}
                            </div>
                          ) : (
                            <div className="muted">Thiếu item type="speaking_outline"</div>
                          )}

                          {/* 6) COMMON MISTAKES */}
                          {mis ? (
                            <div className="quickCard" style={{ borderLeft: "6px solid var(--accent)" }}>
                              <div style={{ fontWeight: 1000 }}>6) Lỗi hay gặp (Common mistakes)</div>

                              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                                {(Array.isArray((mis as any).mistakes) ? (mis as any).mistakes : []).map(
                                  (m: any, i: number) => (
                                    <div
                                      key={i}
                                      style={{ border: "1px solid rgba(15,23,42,.08)", borderRadius: 14, padding: 10 }}
                                    >
                                      <div className="muted">
                                        Sai: <b>{String(m?.wrong || "")}</b>
                                      </div>
                                      <div className="muted" style={{ marginTop: 6 }}>
                                        Sửa: <b>{String(m?.fix || "")}</b>
                                      </div>
                                      {m?.note ? (
                                        <div className="muted" style={{ marginTop: 6 }}>
                                          Ghi chú: <b>{String(m.note)}</b>
                                        </div>
                                      ) : null}
                                    </div>
                                  )
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="muted">Thiếu item type="common_mistakes"</div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {openExercise.rubric ? (
                    <>
                      <div className="divider" style={{ marginTop: 12 }} />
                      <div style={{ fontWeight: 1000, marginTop: 10 }}>🎯 Tiêu chí chấm (Rubric tham khảo)</div>
                      <div className="kvList" style={{ marginTop: 10 }}>
                        {Object.entries(openExercise.rubric).map(([k, v]) => (
                          <div key={k} className="kvRow">
                            <div className="kvKey">{k}</div>
                            <div className="kvVal">{String(v)}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===== Score panel (rightTab === "score") =====
  // ✅ có kết quả ở BẤT KỲ tab nào thì mới cho gửi
  const hasAnyResult = Object.values(taskState).some((st) => st.result != null);

  const scorePanel = (
    <>
      {!result ? (
        <div className="muted" style={{ marginTop: 12 }}>
          Chưa có kết quả. Hãy ghi âm hoặc upload file ở menu bên trái rồi bấm chấm.
        </div>
      ) : (
        <>

          {/* RELEVANCE FALSE WARNING */}
          {task === "relevance" && String(relevanceClass).toUpperCase() === "FALSE" && (
            <div style={{
              marginTop: 12,
              padding: "10px 14px",
              borderRadius: 12,
              background: "rgba(239,68,68,.10)",
              border: "1px solid rgba(239,68,68,.30)",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
            }}>
              <span style={{ fontSize: 18, lineHeight: 1 }}>⚠️</span>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(255,255,255,.85)" }}>
                <b style={{ color: "#f87171" }}>Lạc đề — điểm phát âm không được tính</b>
                <br />
                Điểm trên phản ánh <b>chất lượng phát âm tiếng Anh</b> (pronunciation, fluency…), nhưng bài nói <b>không bám đúng chủ đề</b> nên không có giá trị thực tế.
                <br />
                <span style={{ color: "rgba(255,255,255,.5)", fontSize: 12 }}>
                  Tip: nhắc lại keyword của đề, trả lời đúng câu hỏi được hỏi.
                </span>
              </div>
            </div>
          )}

          {/* EXTRA EXAMS */}
          {(ieltsObj || pteObj || toeicObj || cefrObj) ? (
            <>
              <div className="divider" style={{ marginTop: 14 }} />
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Scores tham khảo</div>
              <div className="kvList">
                {ieltsObj ? (
                  <div className="kvRow">
                    <div className="kvKey">IELTS</div>
                    <div className="kvVal">{JSON.stringify(ieltsObj)}</div>
                  </div>
                ) : null}
                {pteObj ? (
                  <div className="kvRow">
                    <div className="kvKey">PTE</div>
                    <div className="kvVal">{JSON.stringify(pteObj)}</div>
                  </div>
                ) : null}
                {toeicObj ? (
                  <div className="kvRow">
                    <div className="kvKey">TOEIC</div>
                    <div className="kvVal">{JSON.stringify(toeicObj)}</div>
                  </div>
                ) : null}
                {cefrObj ? (
                  <div className="kvRow">
                    <div className="kvKey">CEFR</div>
                    <div className="kvVal">{JSON.stringify(cefrObj)}</div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {/* AUDIO */}
          <div className="divider" style={{ marginTop: 14 }} />
          <div className="quickCard">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontWeight: 1000 }}>🎧 Audio</div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="btn3d btnTiny" onClick={() => void ensureFreshAudioUrl()} disabled={!result?.audioKey}>
                  🔄 Refresh URL
                </button>
              </div>
            </div>

            <audio
              ref={audioRef}
              controls
              src={audioUrl || undefined}
              style={{ width: "100%", marginTop: 10 }}
            />
            {!audioUrl ? (
              <div className="muted" style={{ marginTop: 8 }}>
                (Chưa có audioUrl — bấm Refresh URL nếu cần)
              </div>
            ) : null}
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

              {/* Transcript */}
              {transcript && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>🎙 Transcript (SpeechAce nghe được)</div>
                  <div style={{
                    padding: 12, borderRadius: 12,
                    background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)",
                    lineHeight: 1.7, fontSize: 14,
                  }}>
                    {transcript}
                  </div>
                </div>
              )}
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
              <div style={{ fontWeight: 900, marginBottom: 8, marginTop: 12 }}>Highlight theo word-score <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>(Click vào từ để nghe lại đúng từ)</span></div>

              {!hasHighlight ? (
                <div className="muted">
                  Chưa thấy word_score_list để highlight. Nếu SpeechAce trả về word_score_list, UI sẽ bôi màu theo quality_score.
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
                      ? { background: "rgba(34,197,94,.20)", border: "1px solid rgba(34,197,94,.40)", color: "#4ade80" }
                      : band === "warn"
                        ? { background: "rgba(245,158,11,.20)", border: "1px solid rgba(245,158,11,.40)", color: "#fbbf24" }
                        : band === "bad"
                          ? { background: "rgba(239,68,68,.20)", border: "1px solid rgba(239,68,68,.40)", color: "#f87171" }
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
                      {h.task === "relevance" ? <span className="badge">Rel: {h.relevanceClass ?? "n/a"}</span> : null}
                      <button
                        type="button"
                        className="btn3d btnTiny btnPrimary"
                        onClick={() => setShowSubmitModal(true)}
                        disabled={!hasAnyResult || !canStart() || busy || sending}
                      >
                        {sending ? "📤 Đang gửi..." : "📤 Gửi bài tập"}
                      </button>

                      {sendOk ? <span className="badge accentBadge">✅ Đã gửi</span> : null}

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
                background: "var(--surface2)",
                color: "var(--text2)",
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
    </>
  );

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
          {/* 2 nút đổi tab */}
          <button
            type="button"
            className={`btn3d btnTiny ${rightTab === "score" ? "btnPrimary" : ""}`}
            onClick={() => setRightTab("score")}
          >
            📊 Chấm điểm
          </button>
          <button
            type="button"
            className={`btn3d btnTiny ${rightTab === "exercises" ? "btnPrimary" : ""}`}
            onClick={() => setRightTab("exercises")}
          >
            🧩 Bài tập
          </button>

          <button
            type="button"
            className="btn3d btnTiny btnPrimary"
            onClick={() => setShowSubmitModal(true)}
            disabled={!hasAnyResult || !canStart() || busy || sending}
            title="Gửi toàn bộ kết quả + bài tập"
          >
            {sending ? "📤 Đang gửi..." : "📤 Gửi bài tập"}
          </button>
          {sendOk ? <span className="badge accentBadge">✅ Đã gửi</span> : null}

          {/* giữ lại badge cũ */}
          <span className="badge accentBadge">{task}</span>
          {typeof overall === "number" ? <span className="badge accentBadge">Overall: {overall.toFixed(1)}</span> : null}
          {busy ? <span className="badge">⏳ Đang chấm…</span> : null}
        </div>
      </div>

      {err ? <div className="alertError">Lỗi: {err}</div> : null}
      {sendErr ? <div className="alertError">Gửi lỗi: {sendErr}</div> : null}

      {rightTab === "exercises" ? renderExercisesPanel() : scorePanel}
    </div>
  );

  return (
    <div
      className="appShell"
      onClick={() => {
        setClickPop(null);
      }}
    >
      {/* ===== SIDEBAR ===== */}
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div className="sidebarOverlay" onClick={() => setMobileMenuOpen(false)} />
      )}
      <nav className={`sidebar ${mobileMenuOpen ? "sidebarOpen" : ""}`}>
        <div className="sidebarInner">
          {/* Logo */}
          <div className="sidebarLogo">
            <img src="/ChatGPT Image 22_43_36 29 thg 3, 2026.png" alt="K" style={{ width: 40, height: 40, borderRadius: 14, objectFit: "cover", flexShrink: 0 }} />
            <div>
              <div className="sidebarLogoText">KieuTrangAI</div>
              <div className="sidebarLogoSub">AI Practice</div>
            </div>
          </div>

          {/* Task Nav */}
          <div className="sidebarSection">Task</div>
          <button
            className={`sidebarItem ${task === "reading" ? "active" : ""}`}
            onClick={() => { setHover(null); setClickPop(null); setTask("reading"); setMobileMenuOpen(false); }}
            disabled={busy || recording}
          >
            <span className="sidebarItemIcon">📘</span> Reading
          </button>
          <button
            className={`sidebarItem ${task === "open-ended" ? "active" : ""}`}
            onClick={() => { setHover(null); setClickPop(null); setTask("open-ended"); setMobileMenuOpen(false); }}
            disabled={busy || recording}
          >
            <span className="sidebarItemIcon">🗣️</span> Open-ended
          </button>
          <button
            className={`sidebarItem ${task === "relevance" ? "active" : ""}`}
            onClick={() => { setHover(null); setClickPop(null); setTask("relevance"); setMobileMenuOpen(false); }}
            disabled={busy || recording}
          >
            <span className="sidebarItemIcon">🎯</span> Relevance
          </button>

          <div className="sidebarDivider" />

          {/* User Info */}
          <div className="sidebarSection">Thông tin</div>
          <div style={{ padding: "0 4px", display: "grid", gap: 8 }}>
            {userInfoLocked ? (
              /* ===== Compact view when logged in ===== */
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%",
                    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, flexShrink: 0, color: "#fff", fontWeight: 700
                  }}>
                    {fullName.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#fff", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fullName}</div>
                    <div style={{ color: "var(--side-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</div>
                  </div>
                  <button
                    className="btn3d btnTiny"
                    onClick={logoutUser}
                    disabled={busy || recording}
                    title="Đổi người dùng"
                    style={{ padding: "4px 8px", fontSize: 11 }}
                  >✏️</button>
                </div>
                {/* User switcher dropdown */}
                {userProfiles.length > 1 && (
                  <div style={{ display: "flex", gap: 4 }}>
                    <select
                      className="select"
                      value={activeUserId}
                      onChange={(e) => e.target.value && switchToUser(e.target.value)}
                      disabled={busy || recording}
                      style={{ flex: 1, fontSize: 11 }}
                    >
                      {userProfiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.fullName} ({p.email})</option>
                      ))}
                    </select>
                    <button
                      className="btn3d btnTiny btnDanger"
                      title="Xóa người dùng đang chọn"
                      disabled={!activeUserId || busy || recording}
                      onClick={() => {
                        if (!activeUserId) return;
                        if (!confirm(`Xóa "${userProfiles.find(p => p.id === activeUserId)?.fullName}"?`)) return;
                        const newProfiles = userProfiles.filter(p => p.id !== activeUserId);
                        saveUserProfiles(newProfiles);
                        setUserProfiles(newProfiles);
                        try { localStorage.removeItem(userExKey(activeUserId)); } catch {}
                        try { localStorage.removeItem(userAnsKey(activeUserId)); } catch {}
                        try { localStorage.removeItem(userHistKey(activeUserId)); } catch {}
                        try { localStorage.removeItem(userResultsKey(activeUserId)); } catch {}
                        logoutUser();
                      }}
                      style={{ padding: "4px 8px", fontSize: 11 }}
                    >🗑️</button>
                  </div>
                )}
              </>
            ) : (
              /* ===== Full form when NOT logged in ===== */
              <>
                <div className="fieldGroup" style={{ marginBottom: 0 }}>
                  <label className="label">Họ tên *</label>
                  <input
                    className="input"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Nguyễn Văn A"
                    disabled={busy || recording}
                  />
                </div>
                <div className="fieldGroup" style={{ marginBottom: 0 }}>
                  <label className="label">Email *</label>
                  <input
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    disabled={busy || recording}
                  />
                </div>
                <button
                  className="btn3d btnPrimary"
                  onClick={saveCurrentUser}
                  disabled={!fullName.trim() || !email.trim() || busy || recording}
                  style={{ width: "100%" }}
                >
                  💾 Lưu thông tin
                </button>
                {/* Danh sách người dùng đã lưu */}
                {userProfiles.length > 0 && (
                  <div>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Người dùng đã lưu:</div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <select
                        className="select"
                        value={activeUserId}
                        onChange={(e) => e.target.value && switchToUser(e.target.value)}
                        disabled={busy || recording}
                        style={{ flex: 1, fontSize: 12 }}
                      >
                        <option value="">— Chọn —</option>
                        {userProfiles.map((p) => (
                          <option key={p.id} value={p.id}>{p.fullName} ({p.email})</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="fieldGroup" style={{ marginBottom: 0 }}>
              <label className="label">Dialect</label>
              <select className="select" value={dialect} onChange={(e) => setDialect(e.target.value as any)} disabled={busy || recording}>
                {DIALECTS.map((d) => (
                  <option key={d} value={d}>{d === "en-gb" ? "English (UK)" : "English (US)"}</option>
                ))}
              </select>
            </div>
            <div className="fieldGroup" style={{ marginBottom: 0 }}>
              <label className="label">Chấm điểm</label>
              <select className="select" value={pronunciationScoreMode} onChange={(e) => setPronunciationScoreMode(e.target.value as any)} disabled={busy || recording}>
                <option value="default">Default</option>
                <option value="strict">Strict</option>
              </select>
            </div>
            <label className="row" style={{ gap: 8, cursor: "pointer", padding: "2px 0" }}>
              <input type="checkbox" checked={detectDialect} onChange={(e) => setDetectDialect(e.target.checked)} disabled={busy || recording} />
              <span className="muted" style={{ fontSize: 12 }}>Detect dialect</span>
            </label>
          </div>

          <div className="sidebarDivider" />

          {/* Exercise Generator */}
          <div className="sidebarSection">AI Exercise</div>
          <div style={{ padding: "0 4px", display: "grid", gap: 8 }}>
            <div className="fieldGroup" style={{ marginBottom: 0 }}>
              <label className="label">Level</label>
              <select className="select" value={exerciseLevel} onChange={(e) => setExerciseLevel(e.target.value)} disabled={exerciseLoading || busy || recording}>
                <option value="A2">A2</option>
                <option value="B1">B1</option>
                <option value="B2">B2</option>
                <option value="C1">C1</option>
              </select>
            </div>
            <button
              className="btn3d btnPrimary"
              onClick={() => void generateExerciseNow()}
              disabled={exerciseLoading || busy || recording || task === "relevance"}
              style={{ width: "100%" }}
            >
              {exerciseLoading ? "⏳ Đang tạo..." : "✨ Tạo bài tập AI"}
            </button>
            {exerciseErr ? <div className="alert alertErr" style={{ marginTop: 6, padding: "8px 10px", fontSize: 12 }}>{exerciseErr}</div> : null}
          </div>

        </div>
      </nav>

      {/* ===== MAIN CONTENT ===== */}
      <div className="mainContent">
        {/* Top Bar */}
        <header className="topBar">
          <button
            className="mobileMenuBtn"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Menu"
          >
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
          <div className="topBarTitle">
            {task === "reading" ? "📘 Reading Practice" : task === "open-ended" ? "🗣️ Open-ended Speaking" : "🎯 Relevance Check"}
            {recording && (
              <span className="recTimer" style={{ marginLeft: 12, fontSize: 13 }}>
                <span className="recDot" />
                REC {seconds}s
              </span>
            )}
          </div>
          <div className="topBarActions">
            {busy && <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />}
            {typeof overall === "number" && (
              <span className="badge badgeAccent">Overall: {overall.toFixed(1)}</span>
            )}
            {userInfoLocked && fullName && (
              <span
                className="badge badgeAccent"
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "4px 12px" }}
                onClick={logoutUser}
                title="Bấm để đổi người dùng"
              >
                👤 {fullName}
              </span>
            )}
          </div>
        </header>

        {/* Page Body */}
        <div className="pageContent">
          <div className="singleCol">
            {/* LEFT COLUMN: Input / Text */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Task-specific input */}
              {task === "reading" ? (
                <div className="card">
                  <div className="cardTitle">
                    <div className="cardTitleIcon">📄</div>
                    Reference Text
                    <span className="badge badgeMuted" style={{ marginLeft: "auto" }}>{wordsCount(refText)} từ</span>
                  </div>

                  <div className="tabs" style={{ marginBottom: 12 }}>
                    <button className={`tabItem ${mode === "library" ? "active" : ""}`} onClick={() => setMode("library")} disabled={busy || recording}>Văn mẫu</button>
                    <button className={`tabItem ${mode === "custom" ? "active" : ""}`} onClick={() => setMode("custom")} disabled={busy || recording}>Tự nhập</button>
                  </div>

                  {mode === "library" ? (
                    <>
                      <div className="fieldGroup">
                        <label className="label">Chọn văn mẫu</label>
                        <select className="select" value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={busy || recording}>
                          {passages.map((p) => (<option key={p.id} value={p.id}>{p.title}</option>))}
                        </select>
                      </div>
                      <div style={{ borderRadius: "var(--r-md)", border: "1px solid var(--border)", background: "var(--surface2)", padding: 12, whiteSpace: "pre-wrap", lineHeight: 1.65, fontSize: 14, color: "var(--text2)" }}>
                        {selected?.text || ""}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="fieldGroup">
                        <label className="label">Tiêu đề</label>
                        <input className="input" value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} disabled={busy || recording} placeholder="My passage" />
                      </div>
                      <div className="fieldGroup">
                        <label className="label">Reference text *</label>
                        <textarea className="textarea" value={customText} onChange={(e) => setCustomText(e.target.value)} disabled={busy || recording} placeholder="Dán đoạn văn bạn muốn luyện đọc..." />
                      </div>
                      <div className="row">
                        <button className="btn3d" onClick={addCustomPassageToLibrary} disabled={busy || recording}>Lưu vào thư viện</button>
                        <span className="badge badgeMuted">{wordsCount(customText)} từ</span>
                      </div>
                    </>
                  )}

                  <div className="divider" />
                  <button className="btn3d" onClick={() => toggleTts(refText || selected?.text || "")} disabled={busy || recording || wordsCount(refText || selected?.text || "") < 1} style={{ width: "100%" }}>
                    {ttsSpeaking ? "⏹ Dừng TTS" : "🔈 Nghe mẫu (TTS)"}
                  </button>
                </div>
              ) : task === "open-ended" ? (
                <div className="card">
                  <div className="cardTitle">
                    <div className="cardTitleIcon">💬</div>
                    Prompt
                  </div>
                  <div className="fieldGroup">
                    <label className="label">Câu hỏi / chủ đề nói</label>
                    <textarea className="textarea" value={openPrompt} onChange={(e) => setOpenPrompt(e.target.value)} disabled={busy || recording} />
                  </div>
                  <p className="muted">Tip: nói tự nhiên 1–2 phút, có mở bài – thân bài – kết.</p>
                </div>
              ) : (
                <div className="card">
                  <div className="cardTitle">
                    <div className="cardTitleIcon">🎯</div>
                    Relevance Context
                    {relevanceClass && <span className={`badge ${relevanceClass === "TRUE" ? "badgeSuccess" : "badgeDanger"}`} style={{ marginLeft: "auto" }}>{relevanceClass}</span>}
                  </div>
                  <div className="fieldGroup">
                    <label className="label">Context / Chủ đề</label>
                    <textarea className="textarea" value={relevanceContext} onChange={(e) => setRelevanceContext(e.target.value)} disabled={busy || recording} />
                  </div>
                  <p className="muted">Tip: nói đúng trọng tâm đề bài để relevance lên TRUE.</p>
                </div>
              )}

              {/* Compact Recording Bar */}
              <div className="card recordBar" style={{ padding: "12px 20px", display: "flex", flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap", background: "rgba(10, 10, 20, 0.4)", backdropFilter: "blur(20px)", border: "1px solid rgba(0, 212, 255, 0.1)" }}>
                
                {/* Nút Ghi Âm & Timer (Cột trái) */}
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <button
                    onClick={() => recording ? void stopRec() : void startRec()}
                    disabled={busy}
                    suppressHydrationWarning
                    type="button"
                    style={{
                      width: 48, height: 48, borderRadius: "50%",
                      border: "none", cursor: busy ? "not-allowed" : "pointer",
                      background: recording ? "linear-gradient(135deg, #ef4444, #f97316)" : "linear-gradient(135deg, #00d4ff, #8b5cf6)",
                      boxShadow: recording ? "0 0 20px rgba(239, 68, 68, 0.5)" : "0 0 15px rgba(0, 212, 255, 0.3)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "#fff", fontSize: 20, transition: "transform 0.2s",
                      transform: recording ? "scale(1.05)" : "scale(1)"
                    }}
                    title="Ghi âm"
                  >
                    {recording ? "⏹" : "🎤"}
                  </button>
                  <div style={{ fontSize: 28, fontWeight: 300, letterSpacing: 1, fontFamily: "monospace", color: recording ? "#ef4444" : "var(--text)", minWidth: 80 }} suppressHydrationWarning>
                    {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
                  </div>
                </div>

                {/* Sóng âm giả lập mini (Giữa) */}
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 3, height: 24, opacity: recording ? 1 : 0.15 }}>
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div key={i} style={{ flex: 1, background: recording ? "#ef4444" : "#00d4ff", borderRadius: 2, height: recording ? `${20 + Math.random() * 80}%` : "20%", transition: "height 0.1s" }} />
                  ))}
                </div>

                {/* Nút Phụ (Cột phải) */}
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                      ref={fileInputRef}
                      key={`file-${task}`}
                      type="file"
                      accept="audio/*"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        resetRunState(task);
                        updateTaskState({ uploadedFile: f }, task);
                      }}
                  />
                  {uploadedFile ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="muted" style={{ fontSize: 12, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uploadedFile.name}</span>
                      <button type="button" className="btn3d btnPrimary" disabled={busy || recording} onClick={() => void scoreUploadedFile()} style={{ padding: "8px 16px", fontSize: 12, borderRadius: 8 }}>
                        ✨ Chấm ngay
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn3d" disabled={busy || recording} onClick={() => fileInputRef.current?.click()} style={{ background: "transparent", border: "1px dashed rgba(255,255,255,0.2)", color: "var(--text2)", padding: "8px 16px", fontSize: 13, borderRadius: 8 }}>
                      📁 Tải Audio lên
                    </button>
                  )}
                </div>

              </div>
              
              {busy && (
                <div className="alert alertInfo" style={{ padding: "8px 12px", fontSize: 13 }}>⏳ Đang upload & tiến hành chấm điểm. Vui lòng đợi...</div>
              )}
              {err && <div className="alert alertErr" style={{ padding: "8px 12px", fontSize: 13 }}>⚠ {err}</div>}
            </div>
          </div>
        </div>
      </div>

      {/* ===== RIGHT PANEL (Column 3) ===== */}
      <aside className="insightPanel">
            {/* Results Header */}
              <div className="card">
                <div className="sectionHeader">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>Kết quả chấm</div>
                    <div className="muted" style={{ marginTop: 2 }}>
                      {task === "reading" ? "Reading – theo reference text" : task === "open-ended" ? "Open-ended – theo prompt" : "Relevance – theo context"}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <button type="button" className={`btn3d ${rightTab === "score" ? "btnPrimary" : ""}`} style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setRightTab("score")}>📊 Điểm</button>
                    <button type="button" className={`btn3d ${rightTab === "exercises" ? "btnPrimary" : ""}`} style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setRightTab("exercises")}>🧩 Bài tập ({exercises.length})</button>
                    <button
                      type="button"
                      className="btn3d btnPrimary"
                      style={{ padding: "6px 12px", fontSize: 12 }}
                      onClick={() => setShowSubmitModal(true)}
                      disabled={!hasAnyResult || !canStart() || busy || sending}
                    >
                      {sending ? "📤 Đang gửi..." : "📤 Gửi bài tập"}
                    </button>
                    {sendOk && <span className="badge badgeSuccess">✅ Đã gửi</span>}
                  </div>
                </div>

                {sendErr && <div className="alert alertErr">{sendErr}</div>}

                {rightTab === "exercises" ? null : (
                  /* 2x3 Circular Score Metrics Grid — MEMOIZED to prevent flicker */
                  typeof overall === "number" ? (
                    memoizedScoreGrid
                  ) : (
                    !busy && result ? null : (
                      <div className="muted" style={{ marginTop: 12, padding: "40px 0", textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                        <div style={{ fontSize: 40, opacity: 0.2 }}>⭕</div>
                        {busy ? "⏳ Đang chấm điểm..." : "Chưa có kết quả. Hãy ghi âm hoặc upload audio."}
                      </div>
                    )
                  )
                )}
              </div>

              {/* Score or Exercise Panel */}
              <div className="card" style={{ padding: rightTab === "exercises" ? 16 : 0, border: rightTab === "exercises" ? undefined : "none", background: rightTab === "exercises" ? undefined : "transparent", boxShadow: rightTab === "exercises" ? undefined : "none" }}>
                {rightTab === "exercises" ? renderExercisesPanel() : scorePanel}
              </div>
      </aside>


      {/* ===== SUBMIT CONFIRMATION MODAL ===== */}
      {showSubmitModal && mounted && createPortal(
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 10000,
            background: "rgba(0,0,0,.65)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => !sending && setShowSubmitModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(520px, 92vw)", maxHeight: "80vh", overflow: "auto",
              background: "var(--card-s, #1e293b)", borderRadius: 20,
              border: "1px solid var(--border, rgba(255,255,255,.08))",
              boxShadow: "0 24px 60px rgba(0,0,0,.55)", padding: 24,
            }}
          >
            <div style={{ fontWeight: 1000, fontSize: 18, marginBottom: 16 }}>
              📋 Xác nhận gửi bài tập
            </div>

            {/* ── Thông tin học viên ── */}
            <div style={{ marginBottom: 14, padding: 12, borderRadius: 14, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.06)" }}>
              <div><b>👤 Họ tên:</b> {fullName || "—"}</div>
              <div><b>📧 Email:</b> {email || "—"}</div>
              <div><b>🗣 Dialect:</b> {dialect}</div>
            </div>

            {/* ── Chọn lớp (bắt buộc) ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>
                🏫 Lớp học <span style={{ color: "#f87171", fontWeight: 400, fontSize: 12 }}>* bắt buộc</span>
              </div>
              <select
                className="select"
                value={classCode}
                onChange={(e) => setClassCode(e.target.value)}
                disabled={sending}
                style={{ width: "100%", fontSize: 15, fontWeight: classCode ? 700 : 400 }}
              >
                <option value="">— Chọn lớp của bạn —</option>
                {CLASS_LIST.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {!classCode && (
                <div style={{ color: "#f87171", fontSize: 12, marginTop: 4 }}>
                  ⚠️ Vui lòng chọn lớp trước khi gửi bài
                </div>
              )}
            </div>

            {/* ── Danh sách các phần đã chấm ── */}
            <div style={{ fontWeight: 900, marginBottom: 8 }}>📝 Kết quả chấm điểm</div>
            {(["reading", "open-ended", "relevance"] as Task[]).map((t) => {
              const taskLabel = t === "reading" ? "📘 Reading" : t === "open-ended" ? "🗣️ Open-ended" : "🎯 Relevance";
              const st = taskState[t];
              if (!st.result) return (
                <div key={t} style={{ marginBottom: 8, padding: 10, borderRadius: 12, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.05)", opacity: 0.5 }}>
                  <b>{taskLabel}</b>
                  <span className="muted" style={{ marginLeft: 8 }}>— Chưa làm</span>
                </div>
              );

              const sp = st.result?.speechace;
              const scoreObj = t === "reading"
                ? sp?.text_score?.speechace_score ?? sp?.speechace_score ?? null
                : sp?.speech_score?.speechace_score ?? sp?.speechace_score ?? null;
              const ov = t === "reading"
                ? sp?.text_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? st.result?.overall ?? null
                : sp?.speech_score?.speechace_score?.overall ?? sp?.speechace_score?.overall ?? st.result?.overall ?? null;

              const relClass = t === "relevance" ? (st.result?.relevanceClass ?? null) : null;
              return (
                <div key={t} style={{ marginBottom: 8, padding: 12, borderRadius: 14, background: "rgba(59,130,246,.08)", border: "1px solid rgba(59,130,246,.15)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <b>{taskLabel}</b>
                    <div style={{ display: "flex", gap: 6 }}>
                      {relClass && <span className={`badge ${String(relClass).toUpperCase() === "TRUE" ? "badgeSuccess" : "badgeDanger"}`}>{relClass}</span>}
                      <span className="badge accentBadge">Overall: {ov != null ? Number(ov).toFixed(1) : "n/a"}</span>
                    </div>
                  </div>
                  <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                    P: {scoreObj?.pronunciation ?? "n/a"} · F: {scoreObj?.fluency ?? "n/a"} · G: {scoreObj?.grammar ?? "n/a"} · C: {scoreObj?.coherence ?? "n/a"} · V: {scoreObj?.vocab ?? "n/a"}
                  </div>
                  <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                    🎧 Audio: {st.result?.audioKey ? "✅ Có file ghi âm" : "❌ Không có"}
                  </div>
                </div>
              );
            })}

            {/* ── Bài tập ── */}
            <div style={{ fontWeight: 900, marginTop: 14, marginBottom: 8 }}>🧩 Bài tập ({exercises.length})</div>
            {exercises.length === 0 ? (
              <div className="muted" style={{ padding: 10, borderRadius: 12, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.05)" }}>
                Chưa có bài tập nào
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {exercises.map((ex) => {
                  const taskLabel = ex.task === "reading" ? "📘 Reading" : ex.task === "open-ended" ? "🗣️ Open-ended" : ex.task;
                  return (
                    <div key={ex.id} style={{ padding: 10, borderRadius: 12, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.06)", fontSize: 13 }}>
                      <b>{ex.title || "Exercise"}</b>
                      <span className="muted" style={{ marginLeft: 8 }}>{taskLabel} · {ex.level}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Buttons ── */}
            {sendOk && !sending ? (
              <div style={{ marginTop: 18, textAlign: "center" }}>
                <span className="badge accentBadge" style={{ fontSize: 15, padding: "8px 16px" }}>✅ Đã gửi thành công!</span>
                <div style={{ marginTop: 12 }}>
                  <button className="btn3d btnTiny" onClick={() => { setShowSubmitModal(false); setSendOk(false); }}>
                    Đóng
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button
                  className="btn3d btnTiny"
                  onClick={() => setShowSubmitModal(false)}
                  disabled={sending}
                >
                  ❌ Hủy
                </button>
                <button
                  className="btn3d btnTiny btnPrimary"
                  onClick={async () => {
                    await sendToTelegram();
                  }}
                  disabled={sending || !classCode.trim()}
                  title={!classCode.trim() ? "Vui lòng chọn lớp trước" : ""}
                  style={{ minWidth: 140 }}
                >
                  {sending ? "📤 Đang gửi..." : "📤 Xác nhận gửi"}
                </button>
              </div>
            )}

            {sendErr ? <div className="alertError" style={{ marginTop: 10 }}>Lỗi: {sendErr}</div> : null}
          </div>
        </div>,
        document.body
      )}

      {renderPopups}
    </div>
  );
}

