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
  if (!w?.phones?.length) return "";
  const parts = w.phones.slice(0, 10).map((p) => {
    const q = typeof p.quality === "number" ? Math.round(p.quality) : null;
    const sm = p.soundMostLike ? `→${p.soundMostLike}` : "";
    return `${p.phone}${q == null ? "" : `(${q})`}${sm}`;
  });
  return parts.join("  ");
}

/**
 * SpeechAce có extent theo đơn vị 10ms (theo docs).
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
 * Timing lấy ưu tiên từ phone_score_list[].extent (10ms), nếu không có thì fallback timingFromItem().
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
      const candidateWord = normalizeWord(list[k]?.word || list[k]?.text || "");
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
    if (m[1]) {
      tokens.push({ kind: "space", text: m[1] });
    } else if (m[2]) {
      const attach = wordDisplays?.[wi] || null;
      tokens.push({ kind: "word", text: m[2], attach });
      wi++;
    } else if (m[3]) {
      tokens.push({ kind: "punct", text: m[3] });
    }
  }

  return tokens;
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

  // ==== Per-task state (GIỮ KẾT QUẢ KHI ĐỔI TAB) ====
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

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // playback anti-race
  const playTokenRef = useRef(0);
  const segmentRef = useRef<{ endSec: number; token: number } | null>(null);
  const segmentTimerRef = useRef<any>(null);

  const [hover, setHover] = useState<{ w: WordDisplay; x: number; y: number } | null>(null);
  const [clickPop, setClickPop] = useState<{ w: WordDisplay; x: number; y: number } | null>(null);

  // MediaRecorder path
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
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
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(USER_PASSAGES_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setPassages([...DEFAULT_PASSAGES, ...parsed]);
    } catch {}
  }, []);

  // Cleanup timer + tts on unmount
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
    // nếu url còn mới (tạm giả định 50s), khỏi xin lại
    if (audioUrl && active.audioUrlAt && now - active.audioUrlAt < 50_000) return audioUrl;

    try {
      const r = await fetch(`/api/audio-url?key=${encodeURIComponent(key)}`);
      const j = await r.json();
      const url = j?.url || null;

      updateTaskState({ audioUrl: url, audioUrlAt: url ? Date.now() : null });

      // set trực tiếp cho audio element để play ngay lập tức
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

    // token chống race
    playTokenRef.current += 1;
    const token = playTokenRef.current;

    try {
      a.pause();
    } catch {}

    // đảm bảo có src
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

      // LUÔN catch play()
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

    // nếu chưa có metadata thì đợi
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

    // stop audio
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
    // luôn xin lại url nếu có nguy cơ hết hạn
    const url = await ensureFreshAudioUrl();
    if (!url) return;

    stopTts();
    stopSegmentTimer();

    const t: any = (w as any).timing;
    if (!t || typeof t.startSec !== "number" || typeof t.endSec !== "number") {
      // KHÔNG fallback phát từ đầu nữa
      updateTaskState({ err: "Từ này không có timing → không thể phát đúng theo từ (hãy đảm bảo SpeechAce trả extent)." });
      return;
    }

    const start = Math.max(0, t.startSec - 0.05);
    const end = Math.max(start + 0.02, t.endSec);

    await playSegment(start, end);
  }

  async function startRec() {
    resetRunState(task);

    if (!canStart()) return updateTaskState({ err: "Bạn phải nhập Họ tên + Email trước khi bắt đầu." });

    if (task === "reading" && wordsCount(refText) < 1) {
      return updateTaskState({ err: "Bạn phải nạp Reference text trước khi ghi âm." });
    }

    if (uploadedFile) updateTaskState({ uploadedFile: null });

    // reset timer
    secondsRef.current = 0;
    setSeconds(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
    }, 1000);

    try {
      const gum = (navigator as any)?.mediaDevices?.getUserMedia;
      if (!gum)
        throw new Error(
          "Trình duyệt không hỗ trợ getUserMedia (hoặc đang chạy HTTP). Hãy dùng HTTPS hoặc Upload audio."
        );

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

              // ✅ Nếu blob rỗng: báo lỗi rõ
              if (!blob || blob.size < 1000) {
                updateTaskState({
                  err:
                    "Không thu được audio (blob rỗng). Hãy thử Chrome khác / cấp quyền micro lại / hoặc dùng Upload file.",
                });
                return;
              }

              await uploadThenScore(blob, secondsRef.current);
            } catch (e: any) {
              updateTaskState({ err: e?.message || "Stop recording failed" });
            }
          };


        mrRef.current = mr;

        // QUAN TRỌNG: start theo timeslice để chắc chắn có ondataavailable
        mr.start(250);

        setRecording(true);
        return;
      }

      // WAV fallback
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
        updateTaskState({
          err: "Không tìm thấy micro trên máy. Cắm micro/chọn đúng Input trong Windows, hoặc dùng Upload audio.",
        });
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

    // MediaRecorder path
    if (mrRef.current) {
      mrRef.current.stop();
      mrRef.current = null;
      return;
    }

    // WAV fallback path
    const stop = wavStopperRef.current;
    wavStopperRef.current = null;

    if (timerRef.current) clearInterval(timerRef.current);

    if (!stop) return updateTaskState({ err: "Recorder not ready" });

    try {
      const rec = await stop();
      const dur = Number.isFinite(rec.durationSec) ? rec.durationSec : secondsRef.current;
      await uploadThenScore(rec.blob, dur);
    } catch (e: any) {
      updateTaskState({ err: e?.message || "Stop recording failed" });
    }
  }

  async function uploadThenScore(audioBlob: Blob, durationSec?: number) {
    try {
      setBusy(true);
      updateTaskState({ err: null });

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

      if (task === "reading") {
        if (wordsCount(refText) < 1) throw new Error("Reference text is empty");
        payload.text = refText;
        endpoint = "/api/score";
      } else if (task === "open-ended") {
        payload.prompt = openPrompt.trim();
        endpoint = "/api/open-ended";
      } else {
        payload.relevanceContext = relevanceContext.trim();
        endpoint = "/api/relevance";
      }

      console.log("[score] task =", task, "endpoint =", endpoint, "payload =", payload);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });

    // ✅ đọc raw text trước để không phụ thuộc res.json()
    const raw = await res.text();
    console.log("[score] status =", res.status, "raw(head) =", raw?.slice(0, 200));
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { raw }; // nếu API trả text/html thì vẫn có debug
    }

    if (!res.ok) {
      throw new Error(json?.error || json?.message || raw || "Scoring failed");
    }

    // ✅ luôn spread object an toàn
    updateTaskState({
      result: { ...(json ?? {}), usedText: task === "reading" ? refText : undefined },
      audioUrl: null,
      audioUrlAt: null,
    });

    } catch (e: any) {
      updateTaskState({ err: e?.message || "Error" });
    } finally {
      setBusy(false);
    }
  }

  async function scoreUploadedFile() {
    resetRunState(task);
    if (!uploadedFile) return;
    if (!canStart()) return updateTaskState({ err: "Bạn phải nhập Họ tên + Email trước khi bắt đầu." });
    if (task === "reading" && wordsCount(refText) < 1)
      return updateTaskState({ err: "Bạn phải nạp Reference text trước khi chấm." });
    await uploadThenScore(uploadedFile, undefined);
  }

  // Fetch audioUrl when current task result has audioKey (and keep per task)
  useEffect(() => {
    let cancelled = false;

    async function run() {
      const key = result?.audioKey;
      if (!key) return;

      // nếu task này đã có url thì không cần fetch lại ngay
      if (active.audioUrl && active.audioUrlAt) return;

      try {
        const r = await fetch(`/api/audio-url?key=${encodeURIComponent(key)}`);
        const j = await r.json();
        if (!cancelled) {
          updateTaskState({ audioUrl: j?.url || null, audioUrlAt: j?.url ? Date.now() : null });
        }
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

  // Timeupdate pause at segment end (with token)
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
    task === "reading" &&
    tokens.some((t) => t.kind === "word" && t.attach && typeof t.attach.quality === "number");

  const ielts = result?.ielts ?? result?.speechace?.ielts ?? result?.speechace?.ielts_score ?? null;
  const relevanceClass = result?.relevanceClass ?? null;
  const relevanceScore = result?.relevanceScore ?? null;

  // ===== POPUP clamp =====
  const clampLeft = (x: number, w: number) =>
    Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1024) - w - 12);

  const clampTop = (y: number, h: number) =>
    Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 768) - h - 12);

  // ===== POPUP portal =====
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
                  top: clampTop(clickPop.y + 12, 210),
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
                  <span className="badge">
                    {clickPop.w.quality == null ? "n/a" : (clickPop.w.quality as number).toFixed(0)}
                  </span>
                </div>

                <div className="muted" style={{ marginTop: 6 }}>
                  {formatPhonesForTooltip(clickPop.w) || "(no phone detail)"}
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
                  top: clampTop(hover.y + 12, 180),
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
                  <span className="badge">{hover.w.quality == null ? "n/a" : (hover.w.quality as number).toFixed(0)}</span>
                </div>

                <div className="muted" style={{ marginTop: 6 }}>
                  {formatPhonesForTooltip(hover.w) || "(no phone detail)"}
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
          Reading / Open-ended / Relevance. Upload hoặc ghi âm → chấm. (Audio user phát lại qua presigned URL; mẫu phát âm dùng Browser TTS nếu cần.)
        </p>

        {/* Tabs */}
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button
            className={`btn3d ${task === "reading" ? "btnPrimary btnActive" : ""}`}
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
            className={`btn3d ${task === "open-ended" ? "btnPrimary btnActive" : ""}`}
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
            className={`btn3d ${task === "relevance" ? "btnPrimary btnActive" : ""}`}
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

        <div className="divider" style={{ marginTop: 16 }} />

        <div className="appGrid">
          <div className="leftCol">
            {/* User Info */}
            <div className="section">
              <div className="sectionTitle">
                <span>Thông tin người dùng</span>
                <span className="badge">Dialect: {dialect}</span>
              </div>

              <div className="grid2">
                <div className="field">
                  <label>Họ tên (bắt buộc)</label>
                  <input
                    className="input"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Nguyễn Văn A"
                  />
                </div>

                <div className="field">
                  <label>Email (bắt buộc)</label>
                  <input
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
              </div>

              <div className="divider" />

              <div className="grid2">
                <div className="field">
                  <label>Dialect</label>
                  <select
                    className="select"
                    value={dialect}
                    onChange={(e) => setDialect(e.target.value as any)}
                    disabled={busy || recording}
                  >
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
                  <input
                    type="checkbox"
                    checked={detectDialect}
                    onChange={(e) => setDetectDialect(e.target.checked)}
                    disabled={busy || recording}
                  />
                  <span className="muted">Detect dialect (SpeechAce)</span>
                </label>
              </div>
            </div>

            {/* Task-specific input */}
            {task === "reading" ? (
              <div className="section">
                <div className="sectionTitle">
                  <span>Reference text</span>
                  <span className="badge">Words: {wordsCount(refText)}</span>
                </div>

                <div className="grid2">
                  <div className="field">
                    <label>Reference source</label>
                    <div className="row">
                      <button
                        className={`btn3d ${mode === "library" ? "btnPrimary btnActive" : ""}`}
                        onClick={() => setMode("library")}
                        disabled={busy || recording}
                      >
                        Văn mẫu
                      </button>
                      <button
                        className={`btn3d ${mode === "custom" ? "btnPrimary btnActive" : ""}`}
                        onClick={() => setMode("custom")}
                        disabled={busy || recording}
                      >
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

                <div className="divider" />

                {mode === "library" ? (
                  <>
                    <div className="field">
                      <label>Chọn văn mẫu</label>
                      <select
                        className="select"
                        value={selectedId}
                        onChange={(e) => setSelectedId(e.target.value)}
                        disabled={busy || recording}
                      >
                        {passages.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="divider" />

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
                      <input
                        className="input"
                        value={customTitle}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        disabled={busy || recording}
                        placeholder="My passage"
                      />
                    </div>

                    <div className="field" style={{ marginTop: 10 }}>
                      <label>Reference text (bắt buộc)</label>
                      <textarea
                        className="textarea"
                        value={customText}
                        onChange={(e) => setCustomText(e.target.value)}
                        disabled={busy || recording}
                        placeholder="Dán đoạn bạn muốn user đọc..."
                      />
                    </div>

                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn3d" onClick={addCustomPassageToLibrary} disabled={busy || recording}>
                        Lưu vào thư viện
                      </button>
                      <span className="badge">Words: {wordsCount(customText)}</span>
                    </div>
                  </>
                )}
              </div>
            ) : task === "open-ended" ? (
              <div className="section">
                <div className="sectionTitle">
                  <span>Open-ended prompt</span>
                  <span className="badge">IELTS feedback: {ielts ? "ON" : "n/a"}</span>
                </div>
                <div className="field">
                  <label>Prompt</label>
                  <textarea
                    className="textarea"
                    value={openPrompt}
                    onChange={(e) => setOpenPrompt(e.target.value)}
                    disabled={busy || recording}
                  />
                </div>
                <div className="muted" style={{ marginTop: 8 }}>
                  Tip: nói tự nhiên 20–45s, có mở bài – thân bài – kết.
                </div>
              </div>
            ) : (
              <div className="section">
                <div className="sectionTitle">
                  <span>Relevance context</span>
                  <span className="badge">Class: {relevanceClass ?? "n/a"}</span>
                </div>
                <div className="field">
                  <label>Context</label>
                  <textarea
                    className="textarea"
                    value={relevanceContext}
                    onChange={(e) => setRelevanceContext(e.target.value)}
                    disabled={busy || recording}
                  />
                </div>
                <div className="muted" style={{ marginTop: 8 }}>
                  Tip: nói đúng trọng tâm đề bài để relevance lên class cao.
                </div>
              </div>
            )}

            {/* Record / Upload */}
            <div className="section">
              <div className="sectionTitle">
                <span>Ghi âm / Upload audio</span>
                <span className="badge">Recorder: {recorderName}</span>
              </div>

              <div className="row">
                <button className="btn3d btnPrimary" onClick={() => void startRec()} disabled={busy || recording}>
                  🎙️ Bắt đầu ghi
                </button>
                <button className="btn3d btnDanger" onClick={() => void stopRec()} disabled={busy || !recording}>
                  ⏹ Dừng ({seconds}s)
                </button>
                <span className="badge">Time: {seconds}s</span>
              </div>
              {busy ? (
                <div className="muted" style={{ marginTop: 8 }}>
                  Đang upload &amp; chấm điểm... (đợi chút)
                </div>
              ) : null}
              <div className="divider" />

              <div className="field">
                <label>Upload audio file (mp3/wav/webm/…)</label>
                <input
                  className="input"
                  type="file"
                  accept="audio/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    resetRunState(task);
                    updateTaskState({ uploadedFile: f });
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

              {err ? (
                <div
                  style={{
                    marginTop: 12,
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(255,0,0,.25)",
                    background: "rgba(255,0,0,.06)",
                  }}
                >
                  <b>Lỗi:</b> {err}
                </div>
              ) : null}

              {!result ? (
                <div className="muted" style={{ marginTop: 12 }}>
                  Chưa có kết quả. Hãy ghi âm hoặc upload file rồi chấm.
                </div>
              ) : (
                <>
                  <div className="divider" />

                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontWeight: 900 }}>
                      Kết quả {typeof overall === "number" ? `(Overall: ${overall.toFixed(1)})` : ""}
                    </div>
                    {task === "relevance" && relevanceScore != null ? (
                      <span className="badge">Score: {relevanceScore}</span>
                    ) : null}
                  </div>

                  {audioUrl ? (
                    <div style={{ marginTop: 10 }}>
                      <audio
                        ref={audioRef}
                        src={audioUrl}
                        controls
                        style={{ width: "100%" }}
                        onError={() => {
                          // nếu url hết hạn, tự xin lại
                          void ensureFreshAudioUrl();
                        }}
                      />
                      {task === "reading" ? (
                        <div className="muted" style={{ marginTop: 10 }}>
                          click vào từ để nghe lại đúng từ
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 10 }}>
                      Chưa có audioUrl (nếu R2 private thì cần presign).
                    </div>
                  )}

                  {task === "reading" ? (
                    <>
                      <div className="divider" />
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Highlight theo word-score</div>

                      {!hasHighlight ? (
                        <div className="muted">
                          Chưa thấy word_score_list để highlight. Nếu SpeechAce trả về word_score_list, UI sẽ bôi màu theo quality_score.
                        </div>
                      ) : null}

                      <div style={{ lineHeight: 2, fontSize: 16 }}>
                        {tokens.map((t, idx) => {
                          if (t.kind === "space") return <span key={idx}>{t.text}</span>;
                          if (t.kind === "punct") return <span key={idx}>{t.text}</span>;

                          const w = t.attach;
                          const band = qualityBand(w?.quality ?? null);

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
                  ) : (
                    <>
                      <div className="divider" />
                      <div style={{ fontWeight: 900, marginBottom: 8 }}>Tóm tắt</div>

                      {task === "open-ended" && ielts ? (
                        <div className="muted">
                          IELTS (ước lượng): Fluency {ielts?.fluency ?? "n/a"} • Lexical {ielts?.lexical_resource ?? "n/a"} • Grammar {ielts?.grammar ?? "n/a"} • Pronunciation {ielts?.pronunciation ?? "n/a"}
                        </div>
                      ) : task === "relevance" ? (
                        <div className="muted">
                          Relevance class: <b>{relevanceClass ?? "n/a"}</b> {relevanceScore != null ? `• score: ${relevanceScore}` : ""}
                        </div>
                      ) : (
                        <div className="muted">Chưa có dữ liệu tóm tắt theo task này.</div>
                      )}

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
                    </>
                  )}

                  {task === "reading" ? (
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ cursor: "pointer" }}>Xem JSON SpeechAce (debug)</summary>
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
                        {JSON.stringify(result?.speechace, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </>
              )}
            </div>

            <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
              *Audio user phát lại qua presigned URL (R2). Sample là Browser TTS.
            </p>
          </div>
        </div>
      </div>

      {renderPopups}
    </div>
  );
}
