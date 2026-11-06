/**
 * Public API of the recordings module: what core and dependent modules may import (FR-012). The spec 004
 * `recordings-status` CLI reads the module's status snapshot with the module's own formatter.
 */
import { readBounded } from "../core-api.js";
import { parseTimedTranscript, type TimedTranscript } from "./timed.js";

export { formatStatus, readStatus, type RecordingStatus } from "./status.js";
export { formatTranscript, NO_SPEECH, timecode, UNSEPARATED, type TimedTranscript, type TimedWord, type TranscriptPhrase } from "./timed.js";

/** One media file to transcribe into `<outputDirectory>/<key>.txt` + `<key>.words.json` (replacing earlier ones). */
export interface TranscribeMediaRequest {
  media: string;
  /** An existing directory the caller owns. */
  outputDirectory: string;
  /** File-name stem, e.g. `transcript`. */
  key: string;
  durationSeconds: number;
  signal: AbortSignal;
  /** 0–100 over recognition and speaker separation. */
  onProgress?: (percent: number) => void;
  /** Called when the job leaves the shared queue and starts. */
  onStart?: () => void;
}
export interface TranscribeMediaResult {
  transcript: string;
  words: string;
  /** `separated`: labelled by voice; `unavailable`: every phrase is `Speaker`; `off`: speakers turned off. */
  speakers: "separated" | "unavailable" | "off";
}

/** `provides` of the recordings module (spec 006): the same transcription as the watched folder. */
export interface RecordingsApi {
  /**
   * Waits its turn on the shared lane (one transcription at a time, paused while voice messages are recognised).
   * Throws an error with a fixed `code` (`RECORDING_*`, `MEDIA_ABORTED`, `RECORDINGS_STOPPED`).
   */
  transcribeMedia(request: TranscribeMediaRequest): Promise<TranscribeMediaResult>;
}

const MAX_WORDS_BYTES = 512_000_000;

/** A `<key>.words.json`; undefined when missing, unreadable or not a timed transcript. */
export async function readTimedTranscript(path: string): Promise<TimedTranscript | undefined> {
  try {
    return parseTimedTranscript(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(path, MAX_WORDS_BYTES))));
  } catch { return undefined; }
}
