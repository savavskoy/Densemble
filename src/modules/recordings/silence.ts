import type { ProcessControl, ProcessRunner } from "../core-api.js";
import type { RecordingSilenceSettings } from "./settings.js";

/** A stretch of digital silence (no audio signal), in seconds from the start of the recording. */
export interface SilenceSpan { startSeconds: number; durationSeconds: number; /** Lasts until the end of the recording. */ toEnd?: true }

const START = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const END = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

/** Parses FFmpeg `silencedetect` lines; an unterminated last stretch runs to the end of the audio. */
export function parseSilences(lines: readonly string[], durationSeconds: number, minSeconds: number): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let start: number | undefined;
  const close = (end: number) => {
    if (start === undefined) return;
    const from = Math.max(0, start);
    const duration = Math.max(0, end - from);
    if (duration >= minSeconds) {
      spans.push({ startSeconds: Math.round(from), durationSeconds: Math.round(duration), ...(end >= durationSeconds - 1 ? { toEnd: true as const } : {}) });
    }
    start = undefined;
  };
  for (const line of lines) {
    const started = START.exec(line);
    if (started) { close(Number(started[1])); start = Number(started[1]); continue; }
    const ended = END.exec(line);
    if (ended) close(Number(ended[1]));
  }
  if (start !== undefined && durationSeconds > start) close(durationSeconds);
  return spans;
}

/** Runs `silencedetect` over the decoded WAV (fast: no decoding beyond reading PCM). Throws on process failure. */
export async function detectSilences(options: {
  runner: ProcessRunner; ffmpegPath: string; wav: string; durationSeconds: number; settings: RecordingSilenceSettings;
  signal: AbortSignal; onSpawn?: ((control: ProcessControl) => void) | undefined;
}): Promise<SilenceSpan[]> {
  const lines: string[] = [];
  const { thresholdDb, minSeconds } = options.settings;
  await options.runner(options.ffmpegPath, ["-nostdin", "-hide_banner", "-nostats", "-v", "info", "-threads", "1",
    "-protocol_whitelist", "file", "-i", options.wav, "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSeconds}`,
    "-f", "null", "-"], {
    signal: options.signal, timeoutMs: Math.max(5 * 60_000, options.durationSeconds * 100), discardStdout: true,
    onStderrLine: (line) => { if (line.includes("silence_")) lines.push(line); },
    ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
  });
  return parseSilences(lines, options.durationSeconds, minSeconds);
}

/** "13:30" or "1:13:30". */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Human summary, e.g. "no audio signal from 13:23 to the end (68 min)" or "… from 5:00 for 90 s". */
export function describeSilences(spans: readonly SilenceSpan[]): string | undefined {
  if (!spans.length) return undefined;
  const length = (seconds: number) => seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
  return `no audio signal ${spans.map((span) => span.toEnd
    ? `from ${clock(span.startSeconds)} to the end (${length(span.durationSeconds)})`
    : `from ${clock(span.startSeconds)} for ${length(span.durationSeconds)}`).join(", ")}`;
}
