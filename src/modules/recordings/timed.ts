/**
 * Timed transcripts (spec 006, FR-001…FR-004): words with times from whisper.cpp's full JSON, speakers from
 * diarization, phrases split at speaker changes. Pure functions only; `transcribe.ts` runs the tools.
 */
import type { SpeakerTurn } from "./speakers/index.js";

/** Seconds from the start of the media; `text` is the word as spoken. */
export interface TimedWord { start: number; end: number; text: string }
export interface TranscriptPhrase { start: number; end: number; speaker: string; text: string; words: TimedWord[] }
/** `<key>.words.json`: the readable transcript's phrases with per-word timing (same text, same labels). */
export interface TimedTranscript { version: 1; language?: string; speakers: string[]; phrases: TranscriptPhrase[] }

export const NO_SPEECH = "[no speech detected]";
/** Label of every phrase when speakers could not be separated (plan D3). */
export const UNSEPARATED = "Speaker";

/** A word's end when nothing follows it closely: its last token time plus this. */
const WORD_TAIL_SECONDS = 0.3;
const MAX_WORD_GAP_SECONDS = 1;
/** A speaker change this short (words, seconds) at a segment edge or inside it is boundary jitter, not a turn. */
const ISLAND_WORDS = 2;
const ISLAND_SECONDS = 1;
/** A pause that starts a new phrase of the same speaker: after a sentence end, or any pause this long. */
const SENTENCE_PAUSE_SECONDS = 1.5;
const PAUSE_SECONDS = 3;

interface WhisperToken { text?: unknown; offsets?: { from?: unknown; to?: unknown }; t_dtw?: unknown }
interface WhisperSegment { offsets?: { from?: unknown; to?: unknown }; tokens?: unknown }
/** One whisper segment's words; segments are the natural phrase units before speaker splits. */
export interface TimedSegment { start: number; end: number; words: TimedWord[] }

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Words from whisper.cpp `-oj -ojf` output. A token starting with a space starts a word; special tokens
 * (`[_BEG_]`, `[_TT_…]`, `<|…|>`) are skipped. A word starts at its first token's DTW time (`t_dtw`,
 * centiseconds) when present, else at the token offset (ms). All times are relative to the decoded chunk,
 * which starts `offset` seconds into the recording.
 */
export function whisperSegments(json: unknown, offset: number): { language?: string; segments: TimedSegment[] } {
  const root = (json ?? {}) as { result?: { language?: unknown }; transcription?: unknown };
  if (!Array.isArray(root.transcription)) throw new Error("OUTPUT_INVALID");
  const segments: TimedSegment[] = [];
  for (const raw of root.transcription as WhisperSegment[]) {
    const from = raw.offsets?.from;
    const to = raw.offsets?.to;
    if (!finite(from) || !finite(to) || !Array.isArray(raw.tokens)) throw new Error("OUTPUT_INVALID");
    const segmentStart = offset + from / 1000;
    const segmentEnd = Math.max(segmentStart, offset + to / 1000);
    const pieces: { text: string; first: number; last: number }[] = [];
    for (const token of raw.tokens as WhisperToken[]) {
      if (typeof token.text !== "string" || /^\s*(?:\[_|<\|)/u.test(token.text)) continue;
      const time = finite(token.t_dtw) && token.t_dtw >= 0 ? token.t_dtw / 100
        : finite(token.offsets?.from) ? token.offsets.from / 1000 : undefined;
      if (time === undefined) continue;
      const at = Math.min(segmentEnd, Math.max(segmentStart, offset + time));
      const current = pieces.at(-1);
      if (!current || /^\s/u.test(token.text)) pieces.push({ text: token.text, first: at, last: at });
      else { current.text += token.text; current.last = at; }
    }
    const words: TimedWord[] = [];
    pieces.forEach((piece, index) => {
      const text = piece.text.replace(/�/gu, "").trim().replace(/\s+/gu, " ");
      if (!text) return;
      const next = pieces[index + 1]?.first;
      const tail = Math.min(segmentEnd, piece.last + WORD_TAIL_SECONDS);
      const end = next !== undefined && next - piece.first <= MAX_WORD_GAP_SECONDS + WORD_TAIL_SECONDS ? Math.max(piece.last, next) : tail;
      words.push({ start: round(piece.first), end: round(Math.max(piece.first + 0.05, end)), text });
    });
    segments.push({ start: round(segmentStart), end: round(segmentEnd), words });
  }
  const language = typeof root.result?.language === "string" ? root.result.language : undefined;
  return { ...(language ? { language } : {}), segments };
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Keeps one copy (the last) of any run of 3+ equal consecutive items; runs of two are kept as spoken. */
export function collapseRuns<T>(items: readonly T[], same: (a: T, b: T) => boolean): T[] {
  const kept: T[] = [];
  for (let index = 0; index < items.length;) {
    let end = index;
    while (end + 1 < items.length && same(items[end + 1]!, items[index]!)) end++;
    const run = end - index + 1;
    if (run >= 3) kept.push(items[end]!);
    else for (let copy = index; copy <= end; copy++) kept.push(items[copy]!);
    index = end + 1;
  }
  return kept;
}

const TAG = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)$/u;
const textOf = (words: readonly TimedWord[]) => words.map((word) => word.text).join(" ");
const key = (text: string) => text.replace(/[\s,.!?…]+$/u, "").trim().toLocaleLowerCase();

/**
 * Spec 004's post-filter (research R6) on timed words: tag-only segments ("[музика]", "(Music)") are dropped,
 * a clause repeated 3+ times in a row within a segment is kept once, and so is a segment repeated 3+ times.
 */
export function filterSegments(segments: readonly TimedSegment[]): TimedSegment[] {
  const cleaned = segments.map((segment) => {
    const clauses: TimedWord[][] = [];
    for (const word of segment.words) {
      const current = clauses.at(-1);
      if (!current || /[,.!?…]$/u.test(current.at(-1)!.text)) clauses.push([word]);
      else current.push(word);
    }
    const kept = collapseRuns(clauses, (a, b) => key(textOf(a)) !== "" && key(textOf(a)) === key(textOf(b))).flat();
    return { ...segment, words: kept };
  }).filter((segment) => segment.words.length && !TAG.test(textOf(segment.words).trim()));
  return collapseRuns(cleaned, (a, b) => textOf(a.words) === textOf(b.words));
}

/** The diarization cluster of each word: most overlap, else the nearest turn within 1 s, else the previous word's. */
export function assignSpeakers(words: readonly TimedWord[], turns: readonly SpeakerTurn[]): (number | undefined)[] {
  let previous: number | undefined;
  return words.map((word) => {
    let best: { speaker: number; overlap: number; distance: number } | undefined;
    for (const turn of turns) {
      if (turn.start > word.end + 1) break;
      const overlap = Math.min(word.end, turn.end) - Math.max(word.start, turn.start);
      const distance = overlap > 0 ? 0 : Math.max(turn.start - word.end, word.start - turn.end);
      if (distance > 1) continue;
      if (!best || overlap > best.overlap || (best.overlap <= 0 && overlap <= 0 && distance < best.distance)) {
        best = { speaker: turn.speaker, overlap, distance };
      }
    }
    previous = best?.speaker ?? previous;
    return previous;
  });
}

/**
 * Within one whisper segment, a run of at most 2 words (under 1 s) of another speaker takes its neighbour's
 * speaker: the one before it, or, at the segment start, the one after it.
 */
export function smoothSpeakers(segmentWords: readonly TimedWord[], clusters: (number | undefined)[],
  options: { sentences?: boolean } = {}): (number | undefined)[] {
  const result = [...clusters];
  const runs: { from: number; to: number }[] = [];
  for (let index = 0; index < result.length; index++) {
    const run = runs.at(-1);
    if (run && result[run.from] === result[index]) run.to = index;
    else runs.push({ from: index, to: index });
  }
  if (runs.length < 2) return result;
  runs.forEach((run, index) => {
    const words = run.to - run.from + 1;
    const seconds = segmentWords[run.to]!.end - segmentWords[run.from]!.start;
    if (words > ISLAND_WORDS || seconds >= ISLAND_SECONDS) return;
    let neighbour = index > 0 ? result[runs[index - 1]!.to] : result[runs[index + 1]!.from];
    if (options.sentences) {
      // Across segments only an island inside an unfinished sentence moves: it continues the words before it,
      // or the sentence it starts goes on after it. "Так." between two other voices stays.
      const before = segmentWords[run.from - 1];
      const after = segmentWords[run.to + 1];
      const ends = (word: TimedWord | undefined) => word === undefined || /[.!?…]$/u.test(word.text);
      if (before && !ends(before) && before.end > segmentWords[run.from]!.start - ISLAND_SECONDS) neighbour = result[run.from - 1];
      else if (after && !ends(segmentWords[run.to]) && after.start < segmentWords[run.to]!.end + ISLAND_SECONDS) neighbour = result[run.to + 1];
      else return;
    }
    for (let at = run.from; at <= run.to; at++) result[at] = neighbour;
  });
  return result;
}

/**
 * Phrases with labels (plan D4): the owner's cluster → `ownerName`; other clusters `Speaker N` by first
 * appearance, from 2 when the owner was matched, else from 1. Without diarization every phrase is `Speaker`.
 * A phrase is one whisper segment, split wherever the speaker changes (after `smoothSpeakers`) and at long pauses.
 */
export function buildPhrases(segments: readonly TimedSegment[], diarization: { turns: readonly SpeakerTurn[]; ownerSpeaker?: number } | undefined,
  ownerName: string): TimedTranscript {
  const labels = new Map<number, string>();
  const owner = diarization?.ownerSpeaker;
  let next = owner === undefined ? 1 : 2;
  const label = (cluster: number | undefined): string => {
    if (!diarization || cluster === undefined) return UNSEPARATED;
    if (cluster === owner) return ownerName;
    let name = labels.get(cluster);
    if (!name) { name = `Speaker ${next++}`; labels.set(cluster, name); }
    return name;
  };
  const words = segments.flatMap((segment) => segment.words);
  const assigned = diarization ? smoothSpeakers(words, assignSpeakers(words, diarization.turns), { sentences: true }) : [];
  const phrases: TranscriptPhrase[] = [];
  let index = 0;
  for (const segment of segments) {
    let current: TranscriptPhrase | undefined;
    const clusters = smoothSpeakers(segment.words, assigned.slice(index, index + segment.words.length));
    index += segment.words.length;
    segment.words.forEach((word, at) => {
      const speaker = label(clusters[at]);
      const previous = current?.words.at(-1);
      const pause = previous ? word.start - previous.end : 0;
      if (!current || current.speaker !== speaker || pause >= PAUSE_SECONDS ||
          (pause >= SENTENCE_PAUSE_SECONDS && /[.!?…]$/u.test(previous!.text))) {
        current = { start: word.start, end: word.end, speaker, text: "", words: [] };
        phrases.push(current);
      }
      current.words.push(word);
      current.end = Math.max(current.end, word.end);
    });
  }
  for (const phrase of phrases) phrase.text = textOf(phrase.words);
  const speakers = [...new Set(phrases.map((phrase) => phrase.speaker))];
  return { version: 1, speakers, phrases };
}

/** "HH:MM:SS" of a phrase start. */
export function timecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}`;
}

/** The readable transcript: one `[HH:MM:SS] Label: text` line per phrase, or the no-speech marker. */
export function formatTranscript(transcript: Pick<TimedTranscript, "phrases">): string {
  if (!transcript.phrases.length) return `${NO_SPEECH}\n`;
  return `${transcript.phrases.map((phrase) => `[${timecode(phrase.start)}] ${phrase.speaker}: ${phrase.text}`).join("\n")}\n`;
}

/** Validates a parsed `<key>.words.json`; undefined when it is not one. */
export function parseTimedTranscript(value: unknown): TimedTranscript | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = value as Partial<TimedTranscript>;
  const word = (item: unknown) => {
    const { start, end, text } = (item ?? {}) as Partial<TimedWord>;
    return finite(start) && finite(end) && end >= start && typeof text === "string";
  };
  if (data.version !== 1 || !Array.isArray(data.speakers) || !data.speakers.every((name) => typeof name === "string") ||
      !Array.isArray(data.phrases)) return undefined;
  const valid = data.phrases.every((phrase) => {
    const { start, end, speaker, text, words } = (phrase ?? {}) as Partial<TranscriptPhrase>;
    return finite(start) && finite(end) && typeof speaker === "string" && typeof text === "string" &&
      Array.isArray(words) && words.every(word);
  });
  return valid ? data as TimedTranscript : undefined;
}
