import type { ReelCut } from "./cuts.js";
import { cleanWords, type TimedWord } from "./words.js";

export const SNAP_PAD_SECONDS = 0.15;

export interface SnapOptions {
  /** Source length; the snapped range never passes it. */
  durationSeconds?: number;
  padSeconds?: number;
}
/** The cut with whole-word boundaries; `snapped` is false when no word fell in the range and it was kept as given. */
export type SnappedCut = ReelCut & { snapped: boolean };

/**
 * Moves the boundaries onto whole words (FR-011, SC-005). The words the range touches — those overlapping
 * (start, end) — are kept whole: a start inside a word moves back to that word's start, a start in a gap moves
 * forward to the next word's start; an end inside a word moves to that word's end, an end in a gap moves back to
 * the previous word's end. A pad (0.15 s) is then added on each side so the first and last words are not
 * clipped, but never into a neighbouring word and never past 0 or the source length. A range with no words
 * (music, silence) is kept as given, clamped to the source. Neighbouring cuts that end and start inside the same
 * word both keep that word.
 */
export function snapToWords(cut: ReelCut, words: readonly TimedWord[], options: SnapOptions = {}): SnappedCut {
  const pad = Math.max(0, options.padSeconds ?? SNAP_PAD_SECONDS);
  const limit = options.durationSeconds !== undefined && Number.isFinite(options.durationSeconds) ?
    options.durationSeconds : Number.POSITIVE_INFINITY;
  const clamp = (value: number) => Math.min(limit, Math.max(0, value));
  const all = cleanWords(words);
  const inside = all.filter((word) => word.end > cut.start && word.start < cut.end);
  if (!inside.length) return { ...cut, start: clamp(cut.start), end: clamp(cut.end), snapped: false };
  const first = Math.min(...inside.map((word) => word.start));
  const last = Math.max(...inside.map((word) => word.end));
  const outside = all.filter((word) => !inside.includes(word));
  const previousEnd = Math.max(0, ...outside.filter((word) => word.end <= first).map((word) => word.end));
  const nextStart = Math.min(limit, ...outside.filter((word) => word.start >= last).map((word) => word.start));
  return {
    ...cut,
    start: clamp(Math.min(first, Math.max(first - pad, previousEnd))),
    end: clamp(Math.max(last, Math.min(last + pad, nextStart))),
    snapped: true,
  };
}
