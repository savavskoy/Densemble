export interface ReelCut {
  /** Seconds from the start of the source video. */
  start: number;
  end: number;
  title: string;
  /** Burned-in karaoke subtitles; default true. */
  subtitles?: boolean;
  /** Title during the first seconds; default true. */
  showTitle?: boolean;
}

export const MIN_REEL_SECONDS = 5;
export const MAX_REEL_SECONDS = 180;
export const MAX_REELS = 20;
export const MAX_TITLE_CHARS = 120;

export const CUT_ISSUE_CODES = ["REELS_CUTS_EMPTY", "REELS_CUTS_TOO_MANY", "REELS_SOURCE_DURATION_INVALID",
  "REELS_CUT_INVALID", "REELS_CUT_OUT_OF_RANGE", "REELS_CUT_TOO_SHORT", "REELS_CUT_TOO_LONG", "REELS_CUT_OVERLAP",
  "REELS_CUT_TITLE_INVALID"] as const;
export type CutIssueCode = typeof CUT_ISSUE_CODES[number];

/** `index` is the 0-based entry, null for list-level issues; `other` is the entry an overlap is with. */
export interface CutIssue { index: number | null; code: CutIssueCode; other?: number }
export type CutValidation = { ok: true; cuts: ReelCut[] } | { ok: false; issues: CutIssue[] };

const CONTROL = /[\p{Cc}\u2028\u2029]/u;

export function titleValid(title: unknown): title is string {
  if (typeof title !== "string" || CONTROL.test(title) || /[\uD800-\uDFFF]/u.test(title)) return false;
  const trimmed = title.trim();
  return trimmed.length > 0 && [...trimmed].length <= MAX_TITLE_CHARS;
}

/**
 * Checks the whole list before anything is cut (FR-012): any issue rejects the list. Every entry gets each
 * applicable code once; touching ranges (one ends where the next starts) do not overlap.
 */
export function validateCuts(cuts: readonly ReelCut[], durationSeconds: number): CutValidation {
  const issues: CutIssue[] = [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) issues.push({ index: null, code: "REELS_SOURCE_DURATION_INVALID" });
  if (cuts.length === 0) issues.push({ index: null, code: "REELS_CUTS_EMPTY" });
  if (cuts.length > MAX_REELS) issues.push({ index: null, code: "REELS_CUTS_TOO_MANY" });
  const ranged: number[] = [];
  cuts.forEach((cut, index) => {
    const add = (code: CutIssueCode) => issues.push({ index, code });
    if (!titleValid(cut.title)) add("REELS_CUT_TITLE_INVALID");
    const options = [cut.subtitles, cut.showTitle].every((value) => value === undefined || typeof value === "boolean");
    if (!options || typeof cut.start !== "number" || typeof cut.end !== "number" || !Number.isFinite(cut.start) ||
        !Number.isFinite(cut.end) || cut.end <= cut.start) { add("REELS_CUT_INVALID"); return; }
    if (cut.start < 0 || (Number.isFinite(durationSeconds) && cut.end > durationSeconds)) add("REELS_CUT_OUT_OF_RANGE");
    const length = cut.end - cut.start;
    if (length < MIN_REEL_SECONDS) add("REELS_CUT_TOO_SHORT");
    if (length > MAX_REEL_SECONDS) add("REELS_CUT_TOO_LONG");
    ranged.push(index);
  });
  for (const a of ranged) {
    const other = ranged.find((b) => b !== a && cuts[a]!.start < cuts[b]!.end && cuts[b]!.start < cuts[a]!.end);
    if (other !== undefined) issues.push({ index: a, code: "REELS_CUT_OVERLAP", other });
  }
  issues.sort((x, y) => (x.index ?? -1) - (y.index ?? -1));
  return issues.length ? { ok: false, issues } : { ok: true, cuts: cuts.map((cut) => ({ ...cut, title: cut.title.trim() })) };
}

const TIMECODE = /^(?:(?:(\d+):)?(\d+):)?(\d+(?:[.,]\d{1,3})?)$/;

/**
 * Seconds from `HH:MM:SS(.mmm)`, `MM:SS(.mmm)`, `SS(.mmm)` (a comma is accepted for the fraction) or a
 * non-negative finite number; undefined otherwise. In colon forms seconds must be < 60, and minutes too when hours
 * are given (`75:30` is 75 minutes 30 seconds).
 */
export function parseTimecode(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = TIMECODE.exec(value.trim());
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  const secondsValue = Number(seconds!.replace(",", "."));
  if (minutes !== undefined && secondsValue >= 60) return undefined;
  if (hours !== undefined && Number(minutes) >= 60) return undefined;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + secondsValue;
}
