// Pure file contract of the watched recordings folder, shared with the
// meeting-transcriber bash tool (transcribe-new-recordings.sh, review.sh):
//   <root>/review-log.tsv                          time \t verdict \t transcript_rel \t recording_rel \t reason
//   <root>/<recording>.<ext>                       filed into a day folder once finished
//   <root>/YYYY/MM/DD/<name>.<ext>
//   <root>/YYYY/MM/DD/[<label>_]transcript_YYYY-MM-DD_<name, spaces as _>.txt
//   <root>/YYYY/MM/DD/transcript_…<key>.attempt-N.txt   earlier attempt kept by review.sh
//   <root>/YYYY/MM/DD/.densemble-<uuid>.partial    our temp file, never a transcript

export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "m4a", "mp3", "wav", "mp4", "mkv", "mov", "flv", "webm", "ogg", "opus", "aac",
]);
export const PARTIAL_PATTERN = /^\.densemble-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/;
const OBS_NAME = /^(\d{4})-(\d{2})-(\d{2}) \d{2}-\d{2}-\d{2}\./;
const DAY_FOLDER = /^(\d{4})\/(\d{2})\/(\d{2})$/;

export function isMediaName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return !name.startsWith(".") && dot > 0 && MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Name without the last extension, like bash `${base%.*}`. */
export function recordingName(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? file : file.slice(0, dot);
}

function realDate(year: string, month: string, day: string): string | undefined {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) ? `${year}-${month}-${day}` : undefined;
}

/** Date of an OBS-style name "YYYY-MM-DD HH-MM-SS.ext", only if it is a real calendar date. */
export function obsDate(file: string): string | undefined {
  const match = OBS_NAME.exec(file);
  return match ? realDate(match[1]!, match[2]!, match[3]!) : undefined;
}

export function localDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Day a root recording is filed under: its OBS name date, otherwise its local mtime date. */
export function rootTargetDate(file: string, mtimeMs: number): string {
  return obsDate(file) ?? localDate(mtimeMs);
}

export function dayFolder(date: string): string {
  return date.replaceAll("-", "/");
}

/** "YYYY/MM/DD" (posix separators, nothing else) -> "YYYY-MM-DD". */
export function parseDayFolder(rel: string): string | undefined {
  const match = DAY_FOLDER.exec(rel);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

export function transcriptKey(date: string, file: string): string {
  return `transcript_${date}_${recordingName(file).replaceAll(" ", "_")}`;
}

export interface ReviewLog { retranscribe: ReadonlySet<string> }

/** Transcript paths (relative to the root) that review.sh queued for a retry. */
export function parseReviewLog(text: string): ReviewLog {
  const retranscribe = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length >= 3 && fields[1] === "retranscribe" && fields[2]) retranscribe.add(fields[2]);
  }
  return { retranscribe };
}

export interface DayMedia { name: string; mtimeMs: number }
export type Classification = { kind: "new" } | { kind: "retry" } | { kind: "done" } | { kind: "conflict"; reason: "SAME_KEY" };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What to do with one recording in a day folder. Only `entries` decide "done", so a
 * transcript keeps its recording "done" even after the recording is deleted; whether
 * the recording still exists is the caller's concern. Media sharing one transcript key
 * ("a.mp4", "a.m4a"): the oldest (then lexicographically first) proceeds, the rest
 * are reported as conflicts instead of being silently skipped.
 */
export function classify(input: { dayRel: string; file: string; media: DayMedia[]; entries: string[]; log: ReviewLog }): Classification {
  const date = parseDayFolder(input.dayRel);
  if (date === undefined) throw new Error("RECORDINGS_DAY_FOLDER_INVALID");
  const key = transcriptKey(date, input.file);
  const rivals = input.media.filter((media) => transcriptKey(date, media.name) === key);
  if (rivals.length > 1) {
    const winner = rivals.reduce((best, media) =>
      media.mtimeMs < best.mtimeMs || (media.mtimeMs === best.mtimeMs && media.name < best.name) ? media : best);
    if (winner.name !== input.file) return { kind: "conflict", reason: "SAME_KEY" };
  }
  const own = `${key}.txt`;
  const attempt = new RegExp(`^${escapeRegExp(key)}\\.attempt-\\d+\\.txt$`);
  const hasTranscript = input.entries.some((entry) => entry === own || entry.endsWith(`_${own}`));
  const hasAttempt = input.entries.some((entry) => attempt.test(entry));
  if (input.log.retranscribe.has(`${input.dayRel}/${own}`) && !hasTranscript) return { kind: "retry" };
  return hasTranscript || hasAttempt ? { kind: "done" } : { kind: "new" };
}
