import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { MediaError } from "./errors.js";
import { checkedPath } from "./paths.js";

export type WhisperModelCode = "MEDIA_AUDIO_READY" | "MEDIA_AUDIO_MODEL_MISSING" |
  "MEDIA_AUDIO_MODEL_ENGLISH_ONLY" | "MEDIA_AUDIO_MODEL_UNSUPPORTED";

/** Legacy ggml magic ("ggml" as LE uint32); used by whisper.cpp models and the Silero VAD model. */
const GGML_MAGIC = 0x67676d6c;
/** (n_audio_state, n_audio_layer) for tiny, base, small, medium, large. */
const SIZES = new Map([[384, 4], [512, 6], [768, 12], [1024, 24], [1280, 32]]);

/** Read up to `length` header bytes from a safe regular file; undefined when missing/unsafe/unreadable. */
async function readHeader(path: string | undefined, length: number): Promise<Buffer | undefined> {
  if (!path) return undefined;
  try {
    await checkedPath(path, "file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const header = Buffer.alloc(length);
      const result = await handle.read(header, 0, length, 0);
      return header.subarray(0, result.bytesRead);
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** Accepts any multilingual whisper.cpp GGML model (tiny…large-v3, large-v3-turbo, quantized). Never throws. */
export async function checkWhisperModel(path: string | undefined): Promise<WhisperModelCode> {
  const header = await readHeader(path, 48);
  if (!header) return "MEDIA_AUDIO_MODEL_MISSING";
  if (header.length < 48 || header.readUInt32LE(0) !== GGML_MAGIC) return "MEDIA_AUDIO_MODEL_UNSUPPORTED";
  const [vocab, , audioState, audioHead, audioLayer, , textState, textHead, textLayer, mels] =
    Array.from({ length: 10 }, (_, index) => header.readInt32LE(4 + index * 4));
  const shapeOk = SIZES.get(audioState!) === audioLayer && audioHead === audioState! / 64 &&
    textState === audioState && textHead === audioHead && (textLayer === audioLayer || textLayer === 4) &&
    (mels === 80 || mels === 128);
  if (!shapeOk) return "MEDIA_AUDIO_MODEL_UNSUPPORTED";
  if (vocab === 51864) return "MEDIA_AUDIO_MODEL_ENGLISH_ONLY";
  return vocab === 51865 || vocab === 51866 ? "MEDIA_AUDIO_READY" : "MEDIA_AUDIO_MODEL_UNSUPPORTED";
}

/** whisper.cpp Silero VAD model (ggml-silero-*.bin): observed to start with the same ggml magic. Never throws. */
export async function checkVadModel(path: string | undefined): Promise<"MEDIA_AUDIO_READY" | "MEDIA_AUDIO_VAD_MODEL_INVALID"> {
  const header = await readHeader(path, 4);
  return header?.length === 4 && header.readUInt32LE(0) === GGML_MAGIC ? "MEDIA_AUDIO_READY" : "MEDIA_AUDIO_VAD_MODEL_INVALID";
}

const DTW_PRESETS = new Set(["tiny", "base", "small", "medium", "large.v2", "large.v3", "large.v3.turbo"]);

/**
 * The whisper.cpp `-dtw` preset of a multilingual model, from its header (large-v3-turbo has 4 text layers;
 * large-v3 has 128 mel bins, earlier large models 80); undefined when unknown. Never throws.
 */
export async function whisperDtwPreset(path: string | undefined): Promise<string | undefined> {
  if (await checkWhisperModel(path) !== "MEDIA_AUDIO_READY") return undefined;
  const header = (await readHeader(path, 48))!;
  const [audioState, , audioLayer, , , , textLayer, mels] = Array.from({ length: 8 }, (_, index) => header.readInt32LE(12 + index * 4));
  if (audioState === 1280 && audioLayer === 32) return textLayer === 4 ? "large.v3.turbo" : mels === 128 ? "large.v3" : "large.v2";
  return ({ 384: "tiny", 512: "base", 768: "small", 1024: "medium" } as Record<number, string>)[audioState!];
}

export interface VadSettings { threshold: number; minSpeechMs: number; minSilenceMs: number; padMs: number }

export interface WhisperRunOptions {
  model: string;
  wav: string;
  outputPrefix: string;
  /** "auto" or a 2–3 letter lowercase language code. */
  language: string;
  /** Floored and clamped to 1..8. */
  threads: number;
  prompt?: string | undefined;
  vad?: (VadSettings & { modelPath: string }) | undefined;
  /** `-sns`: suppress non-speech tokens ("[музика]" and the like). */
  suppressNonSpeech?: boolean | undefined;
  /** `-mc`: text context carried between windows; 0 stops loops from propagating. Omitted = whisper default. */
  maxContext?: number | undefined;
  progress?: boolean;
  /**
   * Full JSON (`-oj -ojf`, token times) instead of plain text (`-otxt`); `-np` is then left out so stderr keeps
   * the "VAD segment" lines that map token times back to the original audio.
   */
  json?: boolean | undefined;
  /** `-dtw <preset>` token timestamps (needs `-nfa`); see `whisperDtwPreset`. */
  dtw?: string | undefined;
  /** More files decoded in the same run (the model loads once); whisper-cli pairs each `-f` with `-of` by position. */
  moreInputs?: readonly { wav: string; outputPrefix: string }[] | undefined;
}

export function whisperArgs(options: WhisperRunOptions): string[] {
  if (!/^(?:auto|[a-z]{2,3})$/.test(options.language)) throw new MediaError("MEDIA_AUDIO_FAILED");
  if (!Number.isFinite(options.threads)) throw new MediaError("MEDIA_AUDIO_FAILED");
  const threads = Math.max(1, Math.min(8, Math.floor(options.threads)));
  const args = ["-m", options.model, "-f", options.wav, "-l", options.language, "-t", String(threads),
    ...options.json ? ["-oj", "-ojf"] : ["-otxt"], "-of", options.outputPrefix, ...options.json ? [] : ["-np"], "-nt"];
  if (options.dtw !== undefined) {
    if (!DTW_PRESETS.has(options.dtw)) throw new MediaError("MEDIA_AUDIO_FAILED");
    args.push("-nfa", "-dtw", options.dtw);
  }
  if (options.prompt) args.push("--prompt", options.prompt);
  const vad = options.vad;
  if (vad) {
    args.push("--vad", "-vm", vad.modelPath, "-vt", String(vad.threshold), "-vspd", String(vad.minSpeechMs),
      "-vsd", String(vad.minSilenceMs), "-vp", String(vad.padMs));
  }
  if (options.suppressNonSpeech) args.push("-sns");
  if (options.maxContext !== undefined) {
    if (!Number.isInteger(options.maxContext)) throw new MediaError("MEDIA_AUDIO_FAILED");
    args.push("-mc", String(options.maxContext));
  }
  if (options.progress) args.push("-pp");
  for (const input of options.moreInputs ?? []) args.push("-f", input.wav, "-of", input.outputPrefix);
  return args;
}

export function vocabularyPrompt(vocabulary: readonly string[] | undefined): string | undefined {
  const terms = (vocabulary ?? []).map((term) => term.trim()).filter(Boolean);
  return terms.length ? terms.join(", ") : undefined;
}
