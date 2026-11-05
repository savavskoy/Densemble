/**
 * Chunked recognition (2026-11-05): whisper.cpp decodes one long input in 30 s windows and, on repeated takes,
 * jumps to the window end and drops the rest (a 44-min recording lost a third of its words, whole sentences
 * included). VAD now runs once on its own, and every chunk of speech (at most 25 s) is decoded as its own file.
 */
import { open } from "node:fs/promises";

/** Seconds of the original audio. */
export interface SpeechSpan { start: number; end: number }

/** `-vmsd` for the VAD run and the chunk length cap: under whisper's 30 s window, so it never slides. */
export const CHUNK_MAX_SECONDS = 25;
/** Neighbouring speech closer than this joins one chunk (more context per decode, fewer files). */
const CHUNK_JOIN_GAP_SECONDS = 1.5;
/** Extra audio on both sides of a chunk so a word at a VAD edge is not cut. */
const CHUNK_PAD_SECONDS = 0.2;

const SPEECH_LINE = /^Speech segment \d+: start = (\d+(?:\.\d+)?), end = (\d+(?:\.\d+)?)/gmu;

/** `whisper-vad-speech-segments -np` stdout: "Speech segment N: start = S, end = E", in centiseconds. */
export function parseSpeechSegments(stdout: string): SpeechSpan[] {
  return [...stdout.matchAll(SPEECH_LINE)].map((match) => ({ start: Number(match[1]) / 100, end: Number(match[2]) / 100 }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start);
}

/** VAD spans → padded chunks of at most `CHUNK_MAX_SECONDS` (a longer span stays whole); chunks never overlap. */
export function speechChunks(spans: readonly SpeechSpan[]): SpeechSpan[] {
  const chunks: SpeechSpan[] = [];
  let current: SpeechSpan | undefined;
  for (const span of spans) {
    const start = Math.max(0, span.start - CHUNK_PAD_SECONDS, current?.end ?? 0);
    const end = span.end + CHUNK_PAD_SECONDS;
    if (current && start - current.end < CHUNK_JOIN_GAP_SECONDS && end - current.start <= CHUNK_MAX_SECONDS) {
      current.end = Math.max(current.end, end);
      continue;
    }
    if (end <= start) continue;
    current = { start, end };
    chunks.push(current);
  }
  return chunks.map((chunk) => ({ start: round(chunk.start), end: round(chunk.end) }));
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * Cuts PCM WAV `wav` into one WAV per chunk (`targets[i]` ← `chunks[i]`), same format, no re-encoding.
 * Throws when `wav` is not a PCM WAV.
 */
export async function writeWavChunks(wav: string, chunks: readonly SpeechSpan[], targets: readonly string[]): Promise<void> {
  const handle = await open(wav, "r");
  try {
    const size = (await handle.stat()).size;
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error("WAV_INVALID");
      return buffer;
    };
    const riff = await read(0, 12);
    if (riff.toString("latin1", 0, 4) !== "RIFF" || riff.toString("latin1", 8, 12) !== "WAVE") throw new Error("WAV_INVALID");
    let format: Buffer | undefined;
    let data: { offset: number; length: number } | undefined;
    for (let position = 12; position + 8 <= size && !data;) {
      const header = await read(position, 8);
      const id = header.toString("latin1", 0, 4);
      const length = header.readUInt32LE(4);
      if (id === "fmt ") format = await read(position + 8, Math.min(length, 16));
      // ffmpeg may leave the data size unset (0 or 0xFFFFFFFF) when it could not seek back: take the rest of the file.
      if (id === "data") data = { offset: position + 8, length: length === 0 || position + 8 + length > size ? size - position - 8 : length };
      position += 8 + length + (length % 2);
    }
    if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || !data) throw new Error("WAV_INVALID");
    const sampleRate = format.readUInt32LE(4);
    const blockAlign = format.readUInt16LE(12);
    if (!sampleRate || !blockAlign) throw new Error("WAV_INVALID");
    const frames = Math.floor(data.length / blockAlign);
    for (const [index, chunk] of chunks.entries()) {
      const from = Math.min(frames, Math.floor(chunk.start * sampleRate));
      const to = Math.min(frames, Math.ceil(chunk.end * sampleRate));
      const body = await read(data.offset + from * blockAlign, (to - from) * blockAlign);
      const header = Buffer.alloc(44);
      header.write("RIFF", 0, "latin1");
      header.writeUInt32LE(36 + body.length, 4);
      header.write("WAVEfmt ", 8, "latin1");
      header.writeUInt32LE(16, 16);
      format.copy(header, 20, 0, 16);
      header.write("data", 36, "latin1");
      header.writeUInt32LE(body.length, 40);
      const out = await open(targets[index]!, "wx", 0o600);
      try { await out.writeFile(Buffer.concat([header, body])); } finally { await out.close(); }
    }
  } finally {
    await handle.close();
  }
}
