import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { checkAbort, MediaError } from "./errors.js";
import { MEDIA_LIMITS } from "./limits.js";
import { checkedPath, readBounded } from "./paths.js";
import { runManagedProcess, SerialQueue, type ProcessRunner } from "./process.js";
import type { SpeechGate } from "./speech-gate.js";
import { checkVadModel, checkWhisperModel, vocabularyPrompt, whisperArgs } from "./whisper.js";

export interface AudioSettings {
  ffprobePath?: string;
  ffmpegPath?: string;
  whisperPath?: string;
  modelPath?: string;
  language?: string;
  threads?: number;
  vocabulary?: string[];
  vadModelPath?: string;
  probeTimeoutMs?: number;
  decodeTimeoutMs?: number;
  asrTimeoutMs?: number;
  processRunner?: ProcessRunner;
}

/** whisper.cpp VAD defaults for voice messages when a VAD model is configured. */
const VOICE_VAD = Object.freeze({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 100, padMs: 30 });

export interface AudioReadiness {
  ready: boolean;
  code: "MEDIA_AUDIO_READY" | "MEDIA_AUDIO_TOOLS_MISSING" | "MEDIA_AUDIO_MODEL_MISSING" | "MEDIA_AUDIO_MODEL_ENGLISH_ONLY" |
    "MEDIA_AUDIO_MODEL_UNSUPPORTED" | "MEDIA_AUDIO_VAD_MODEL_INVALID";
}

/** Any multilingual whisper.cpp model (tiny…large-v3/turbo, quantized); English-only and damaged files are rejected. */
async function checkModel(path: string | undefined): Promise<void> {
  const code = await checkWhisperModel(path);
  if (code !== "MEDIA_AUDIO_READY") throw new MediaError(code);
}

async function executableExists(command: string): Promise<boolean> {
  const paths = isAbsolute(command) ? [command] :
    (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path, command));
  for (const path of paths) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return true; } catch { /* Try the next PATH entry. */ }
  }
  return false;
}

export async function checkAudioReadiness(settings: AudioSettings = {}): Promise<AudioReadiness> {
  for (const binary of [settings.ffprobePath ?? "ffprobe", settings.ffmpegPath ?? "ffmpeg", settings.whisperPath ?? "whisper-cli"]) {
    if (!await executableExists(binary)) return { ready: false, code: "MEDIA_AUDIO_TOOLS_MISSING" };
  }
  const model = await checkWhisperModel(settings.modelPath);
  if (model !== "MEDIA_AUDIO_READY") return { ready: false, code: model };
  if (settings.vadModelPath !== undefined && await checkVadModel(settings.vadModelPath) !== "MEDIA_AUDIO_READY") {
    return { ready: false, code: "MEDIA_AUDIO_VAD_MODEL_INVALID" };
  }
  return { ready: true, code: "MEDIA_AUDIO_READY" };
}

/** Voice messages enter the speech gate, so background recording transcription yields to them. */
export function createAudioTranscriber(settings: AudioSettings = {}, gate?: SpeechGate) {
  const queue = new SerialQueue();
  const runner = settings.processRunner ?? runManagedProcess;
  return {
    run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> { return queue.run(signal, operation); },
    async transcribe(path: string, signal: AbortSignal, guard: () => void = () => {}): Promise<string> {
      const check = () => { checkAbort(signal); guard(); };
      check();
      await checkModel(settings.modelPath);
      if (settings.vadModelPath !== undefined && await checkVadModel(settings.vadModelPath) !== "MEDIA_AUDIO_READY") {
        throw new MediaError("MEDIA_AUDIO_VAD_MODEL_INVALID");
      }
      check();
      const release = gate?.enterVoice();
      try { return await recognise(path, signal, check); }
      finally { release?.(); }
    },
  };
  async function recognise(path: string, signal: AbortSignal, check: () => void): Promise<string> {
    const directory = join(path, "..");
    const probe = await runner(settings.ffprobePath ?? "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", "-i", path], {
      signal, timeoutMs: Math.min(settings.probeTimeoutMs ?? MEDIA_LIMITS.probeTimeoutMs, MEDIA_LIMITS.probeTimeoutMs),
    });
    check();
    let duration: number;
    try {
      const parsed = JSON.parse(probe.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; duration?: string }[] };
      if (!parsed.streams?.length || parsed.streams.some((stream) => stream.codec_type !== "audio")) {
        throw new MediaError("MEDIA_AUDIO_INVALID");
      }
      const durations = [Number(parsed.format?.duration), ...parsed.streams
        .filter((stream) => stream.duration !== undefined).map((stream) => Number(stream.duration))];
      if (durations.some((value) => !Number.isFinite(value) || value <= 0)) throw new MediaError("MEDIA_AUDIO_INVALID");
      duration = Math.max(...durations);
    } catch { throw new MediaError("MEDIA_AUDIO_INVALID"); }
    if (duration > MEDIA_LIMITS.audioSeconds) throw new MediaError("MEDIA_AUDIO_TOO_LONG");
    const wav = join(directory, "decoded.wav");
    await runner(settings.ffmpegPath ?? "ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-threads", "1",
      "-protocol_whitelist", "file,pipe", "-i", path, "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-t", String(MEDIA_LIMITS.audioSeconds + 1), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-fs", String(MEDIA_LIMITS.audioWavBytes), "-f", "wav", "-n", wav], {
      signal, timeoutMs: Math.min(settings.decodeTimeoutMs ?? MEDIA_LIMITS.decodeTimeoutMs, MEDIA_LIMITS.decodeTimeoutMs),
    });
    check();
    await checkedPath(wav, "file");
    if ((await stat(wav)).size > MEDIA_LIMITS.audioWavBytes) throw new MediaError("MEDIA_AUDIO_TOO_LONG");
    check();
    const decoded = await runner(settings.ffprobePath ?? "ffprobe", ["-v", "error", "-show_entries",
      "format=duration", "-of", "json", "-i", wav], { signal, timeoutMs: MEDIA_LIMITS.probeTimeoutMs });
    let decodedDuration: number;
    try { decodedDuration = Number((JSON.parse(decoded.stdout) as { format?: { duration?: string } }).format?.duration); }
    catch { throw new MediaError("MEDIA_AUDIO_INVALID"); }
    if (!Number.isFinite(decodedDuration) || decodedDuration <= 0) throw new MediaError("MEDIA_AUDIO_INVALID");
    if (decodedDuration > MEDIA_LIMITS.audioSeconds) throw new MediaError("MEDIA_AUDIO_TOO_LONG");
    check();
    const prefix = join(directory, "transcript");
    await runner(settings.whisperPath ?? "whisper-cli", whisperArgs({
      model: settings.modelPath!, wav, outputPrefix: prefix, language: settings.language ?? "auto",
      threads: settings.threads ?? 4, prompt: vocabularyPrompt(settings.vocabulary),
      vad: settings.vadModelPath ? { modelPath: settings.vadModelPath, ...VOICE_VAD } : undefined,
    }), {
      signal, timeoutMs: Math.min(settings.asrTimeoutMs ?? MEDIA_LIMITS.asrTimeoutMs, MEDIA_LIMITS.asrTimeoutMs),
      maxOutputBytes: MEDIA_LIMITS.textCharacters * 4, cwd: directory,
    });
    check();
    const bytes = await readBounded(`${prefix}.txt`, MEDIA_LIMITS.textCharacters * 4);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
    catch { throw new MediaError("MEDIA_INVALID_UTF8"); }
    if (text.includes("\0")) throw new MediaError("MEDIA_INVALID_UTF8");
    if (text.length > MEDIA_LIMITS.textCharacters) throw new MediaError("MEDIA_TEXT_TOO_LARGE");
    if (!text) throw new MediaError("MEDIA_EMPTY");
    return text;
  }
}
