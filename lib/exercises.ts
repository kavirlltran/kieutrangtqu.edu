// lib/exercises.ts
import type { WordDisplay } from "@/lib/speechace";

export type Task = "reading" | "open-ended" | "relevance";

export type BlankPart = {
  kind: "blank";
  id: string;
  answer: string; // đáp án gốc
  hint: string;   // gợi ý: chữ cái đầu + độ dài
};

export type ClozeExercise = {
  id: string;
  ts: number;
  partsBySentence: (string | BlankPart)[][];
  wordBank: string[];
};

export type WeakWordItem = {
  word: string;
  quality: number | null;
  phonesHint?: string;
};

export type ReadingExercises = {
  cloze: ClozeExercise;
  weakWords: WeakWordItem[];
  shadowingSentences: string[];
};

export type OpenEndedExercises = {
  outline: { intro: string[]; body: string[]; conclusion: string[] };
  fillers: { filler: string; count: number }[];
  rewrite: { id: string; sentence: string; wordCount: number }[];
};

const STOPWORDS = new Set(
  [
    "a","an","the","and","or","but","so","because","if","then","than",
    "i","you","he","she","it","we","they","me","him","her","us","them",
    "my","your","his","her","its","our","their","mine","yours","ours","theirs",
    "to","of","in","on","at","for","from","with","without","into","onto","over","under","between","among",
    "is","am","are","was","were","be","been","being",
    "do","does","did","done","doing",
    "have","has","had",
    "this","that","these","those",
    "as","by","about","around","before","after","during","while","until",
    "can","could","will","would","should","may","might","must",
    "not","no","yes",
    "there","here","what","which","who","whom","whose","when","where","why","how",
    "also","very","really","just","like"
  ]
);

function normalizeWord(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .trim();
}

function splitSentences(text: string): string[] {
  const t = (text || "").trim();
  if (!t) return [];
  // Tách theo dấu câu + xuống dòng
  const rough = t
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // Nếu không có dấu câu rõ ràng, fallback tách theo 20-30 từ
  if (rough.length <= 1) return [t];
  return rough;
}

function wordTokens(s: string): string[] {
  return (s.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?/g) || []).map((x) => x.trim()).filter(Boolean);
}

function phonesHintFromWordDisplay(w: WordDisplay | null | undefined) {
  if (!w?.phones?.length) return "";
  // gợi ý ngắn: phone + quality
  return w.phones
    .slice(0, 6)
    .map((p) => {
      const q = typeof p.quality === "number" ? Math.round(p.quality) : null;
      return `${p.phone}${q == null ? "" : `(${q})`}${p.soundMostLike ? `→${p.soundMostLike}` : ""}`;
    })
    .join("  ");
}

function uniqByNorm(words: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const k = normalizeWord(w);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeHint(answer: string) {
  const clean = answer.replace(/[^A-Za-z]/g, "");
  const first = clean.slice(0, 1) || answer.slice(0, 1) || "?";
  return `${first.toUpperCase()}… (${answer.length})`;
}

function pickWeakWordsFromDisplays(wordDisplays: WordDisplay[] | null | undefined, max = 10): WeakWordItem[] {
  const list = Array.isArray(wordDisplays) ? wordDisplays : [];
  if (!list.length) return [];

  // lấy unique theo normalize, chọn quality thấp
  const map = new Map<string, WordDisplay>();
  for (const w of list) {
    const k = normalizeWord(w.word);
    if (!k) continue;
    const cur = map.get(k);
    const q = typeof w.quality === "number" ? w.quality : null;
    const cq = cur && typeof (cur as any).quality === "number" ? (cur as any).quality : null;
    // giữ cái quality thấp hơn (yếu hơn)
    if (!cur) map.set(k, w);
    else if (q != null && (cq == null || q < cq)) map.set(k, w);
  }

  const sorted = Array.from(map.values()).sort((a, b) => {
    const qa = typeof a.quality === "number" ? a.quality : 9999;
    const qb = typeof b.quality === "number" ? b.quality : 9999;
    return qa - qb;
  });

  return sorted.slice(0, max).map((w) => ({
    word: w.word,
    quality: typeof w.quality === "number" ? w.quality : null,
    phonesHint: phonesHintFromWordDisplay(w),
  }));
}

function buildClozeFromSentences(sentences: string[], preferredTargetsNorm: Set<string>, blanksTotal = 8) {
  const chosenSentences = sentences.slice(0, 4); // lấy 3-4 câu đầu
  const partsBySentence: (string | BlankPart)[][] = [];

  const pickedAnswers: string[] = [];
  const pickedNorm = new Set<string>();

  // chọn target words ưu tiên từ weakWords có trong câu
  const candidatesBySentence = chosenSentences.map((s) => {
    const ws = wordTokens(s);
    const good = ws
      .filter((w) => {
        const k = normalizeWord(w);
        if (!k) return false;
        if (STOPWORDS.has(k)) return false;
        if (k.length < 4) return false;
        return true;
      })
      .map((w) => ({ raw: w, norm: normalizeWord(w) }));

    return { sentence: s, words: good };
  });

  // pass 1: lấy từ trong preferredTargets trước
  for (const it of candidatesBySentence) {
    if (pickedAnswers.length >= blanksTotal) break;
    for (const w of it.words) {
      if (pickedAnswers.length >= blanksTotal) break;
      if (!preferredTargetsNorm.has(w.norm)) continue;
      if (pickedNorm.has(w.norm)) continue;
      pickedNorm.add(w.norm);
      pickedAnswers.push(w.raw);
      break;
    }
  }

  // pass 2: bổ sung bằng từ dài/ít stopwords
  if (pickedAnswers.length < blanksTotal) {
    const pool = candidatesBySentence
      .flatMap((x) => x.words)
      .filter((w) => !pickedNorm.has(w.norm))
      .sort((a, b) => b.norm.length - a.norm.length);

    for (const w of pool) {
      if (pickedAnswers.length >= blanksTotal) break;
      pickedNorm.add(w.norm);
      pickedAnswers.push(w.raw);
    }
  }

  const targetsNorm = new Set(pickedAnswers.map((a) => normalizeWord(a)));

  // render parts: replace word -> <blank>
  let blankIdx = 0;
  for (let si = 0; si < chosenSentences.length; si++) {
    const s = chosenSentences[si];
    const re = /(\s+)|([A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?)|([^A-Za-z0-9\s]+)/g;
    let m: RegExpExecArray | null;

    const parts: (string | BlankPart)[] = [];

    while ((m = re.exec(s)) !== null) {
      const space = m[1];
      const word = m[2];
      const punct = m[3];

      if (space) {
        parts.push(space);
        continue;
      }
      if (punct) {
        parts.push(punct);
        continue;
      }

      if (word) {
        const k = normalizeWord(word);
        if (targetsNorm.has(k) && blankIdx < blanksTotal) {
          const id = `cloze_${Date.now()}_${si}_${blankIdx}`;
          blankIdx += 1;
          parts.push({
            kind: "blank",
            id,
            answer: word,
            hint: makeHint(word),
          });
        } else {
          parts.push(word);
        }
      }
    }

    partsBySentence.push(parts);
  }

  // wordBank = đáp án unique
  const bank = uniqByNorm(
    partsBySentence
      .flatMap((parts) => parts)
      .filter((p): p is BlankPart => typeof p === "object" && (p as any).kind === "blank")
      .map((b) => b.answer)
  );

  return {
    partsBySentence,
    wordBank: shuffle(bank),
  };
}

export function buildReadingExercises(refText: string, wordDisplays?: WordDisplay[] | null): ReadingExercises {
  const sentences = splitSentences(refText);
  const weakWords = pickWeakWordsFromDisplays(wordDisplays || [], 10);

  const preferred = new Set<string>(weakWords.map((w) => normalizeWord(w.word)).filter(Boolean));

  const clozeRaw = buildClozeFromSentences(sentences, preferred, 8);

  // shadowing: chọn 3 câu có nhiều “từ ưu tiên”
  const scored = sentences.map((s) => {
    const ws = wordTokens(s).map(normalizeWord);
    const hit = ws.filter((k) => preferred.has(k)).length;
    return { s, hit };
  });

  const shadowingSentences = scored
    .sort((a, b) => b.hit - a.hit)
    .slice(0, 3)
    .map((x) => x.s);

  return {
    cloze: {
      id: `cloze_${Date.now()}`,
      ts: Date.now(),
      partsBySentence: clozeRaw.partsBySentence,
      wordBank: clozeRaw.wordBank,
    },
    weakWords,
    shadowingSentences,
  };
}

export function buildOpenEndedExercises(transcript: string): OpenEndedExercises {
  const sentences = splitSentences(transcript);
  const intro = sentences.slice(0, 2);
  const conclusion = sentences.length >= 2 ? sentences.slice(-2) : sentences.slice(-1);
  const body = sentences.slice(intro.length, Math.max(intro.length, sentences.length - conclusion.length));

  // filler detection (rule-based)
  const fillerPatterns: { label: string; re: RegExp }[] = [
    { label: "um", re: /\bum+\b/gi },
    { label: "uh", re: /\buh+\b/gi },
    { label: "like", re: /\blike\b/gi },
    { label: "you know", re: /\byou\s+know\b/gi },
    { label: "actually", re: /\bactually\b/gi },
    { label: "basically", re: /\bbasically\b/gi },
    { label: "i mean", re: /\bi\s+mean\b/gi },
  ];

  const fillers = fillerPatterns
    .map((p) => ({ filler: p.label, count: (transcript.match(p.re) || []).length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  // chọn câu dài để rewrite
  const rewrite = sentences
    .map((s) => ({ s, wc: wordTokens(s).length }))
    .filter((x) => x.wc >= 10)
    .sort((a, b) => b.wc - a.wc)
    .slice(0, 5)
    .map((x, idx) => ({ id: `rw_${Date.now()}_${idx}`, sentence: x.s, wordCount: x.wc }));

  return {
    outline: { intro, body: body.slice(0, 5), conclusion },
    fillers,
    rewrite,
  };
}
