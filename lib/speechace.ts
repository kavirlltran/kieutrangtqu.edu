// lib/speechace.ts
export type PhoneScore = {
  phone: string | null;
  quality_score?: number | null;
  sound_most_like?: string | null;
};

export type WordScoreListItem = {
  word?: string;
  text?: string; //
  quality_score?: number | null;

  // timing fields may vary by API version
  start_time?: number | string | null;
  end_time?: number | string | null;
  start?: number | string | null;
  end?: number | string | null;

  phone_score_list?: PhoneScore[] | null;
};

export type WordTiming = { startSec: number; endSec: number };

export type WordPhone = {
  phone: string;
  quality: number | null;
  soundMostLike?: string | null;
};

export type WordDisplay = {
  idx: number;
  word: string;
  quality: number | null;
  timing?: WordTiming;
  phones: WordPhone[];
};

/** Try to find word_score_list across multiple SpeechAce response shapes */
export function getWordScoreList(speechace: any): WordScoreListItem[] {
  const candidates =
    speechace?.text_score?.speechace_score?.word_score_list ??
    speechace?.text_score?.word_score_list ??
    speechace?.speechace_score?.word_score_list ??
    speechace?.word_score_list ??
    null;

  return Array.isArray(candidates) ? candidates : [];
}

function toNumberSec(x: any): number | null {
  if (x == null) return null;
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  if (!Number.isFinite(n)) return null;

  // SpeechAce timing sometimes is ms; sometimes sec.
  // Heuristic: if > 1000 => ms
  if (n > 1000) return n / 1000;
  return n;
}

export function timingFromItem(item: WordScoreListItem): WordTiming | undefined {
  const s = toNumberSec(item.start_time ?? item.start);
  const e = toNumberSec(item.end_time ?? item.end);
  if (s == null || e == null) return undefined;
  return { startSec: Math.max(0, s), endSec: Math.max(0, e) };
}

function normalizeWord(w: string) {
  return (w || "")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Build WordDisplay list from SpeechAce response (order-based, tolerant) */
export function buildWordDisplays(referenceText: string, speechace: any): WordDisplay[] {
  const list = getWordScoreList(speechace);

  // Build fallback words from reference text
  const refWords =
    referenceText
      ?.trim()
      .split(/\s+/)
      .map((w) => normalizeWord(w))
      .filter(Boolean) ?? [];

  return list.map((it, idx) => {
    const rawWord = (it.word || "").toString();
    const word = normalizeWord(rawWord) || refWords[idx] || rawWord || `w${idx + 1}`;

    const phones: WordPhone[] = Array.isArray(it.phone_score_list)
      ? it.phone_score_list
          .filter((p) => p && p.phone)
          .map((p) => ({
            phone: (p.phone || "").toString(),
            quality: p.quality_score == null ? null : Number(p.quality_score),
            soundMostLike: p.sound_most_like ?? null,
          }))
      : [];

    return {
      idx,
      word,
      quality: it.quality_score == null ? null : Number(it.quality_score),
      timing: timingFromItem(it),
      phones,
    };
  });
}

/**
 * Tokenize text (keep spaces + punctuation) and attach WordDisplay by sequence
 * return: [{kind:'word'|'space'|'punct', text, attach?}]
 */
export function tokenizeAndAttach(text: string, wordDisplays: WordDisplay[]) {
  const tokens: any[] = [];
  const re = /(\s+|[^\p{L}\p{N}\s]+|\p{L}[\p{L}\p{N}'-]*|\p{N}+)/gu;

  let m: RegExpExecArray | null;
  let wi = 0;

  while ((m = re.exec(text)) !== null) {
    const s = m[0];
    if (/^\s+$/u.test(s)) {
      tokens.push({ kind: "space", text: s });
      continue;
    }
    if (/^[^\p{L}\p{N}\s]+$/u.test(s)) {
      tokens.push({ kind: "punct", text: s });
      continue;
    }

    const attach = wi < wordDisplays.length ? wordDisplays[wi] : null;
    wi += 1;
    tokens.push({ kind: "word", text: s, attach });
  }
  return tokens;
}

export function qualityBand(q: number | null) {
  if (q == null || !Number.isFinite(q)) return "na";
  if (q >= 80) return "good";
  if (q >= 60) return "warn";
  return "bad";
}

/** Tooltip string like: dh(98) → eh(100) → ... */
export function formatPhonesForTooltip(w: WordDisplay) {
  if (!w?.phones?.length) return "";
  return w.phones
    .map((p) => {
      const q = p.quality == null || !Number.isFinite(p.quality) ? "n/a" : Math.round(p.quality).toString();
      const like = p.soundMostLike ? ` → ${p.soundMostLike}` : "";
      return `${p.phone}(${q})${like}`;
    })
    .join("  ");
}

export function topMistakes(list: WordDisplay[], n = 10) {
  return [...(list || [])]
    .filter((w) => typeof w.quality === "number" && Number.isFinite(w.quality))
    .sort((a, b) => (a.quality as number) - (b.quality as number))
    .slice(0, n);
}
