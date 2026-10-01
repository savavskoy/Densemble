import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { checkAbort, MediaError } from "./errors.js";
import { MEDIA_LIMITS } from "./limits.js";
import { checkedPath, readBounded } from "./paths.js";
import { runManagedProcess, SerialQueue, type ProcessRunner } from "./process.js";

export interface AudioSettings {
  ffprobePath?: string;
  ffmpegPath?: string;
  whisperPath?: string;
  modelPath?: string;
  language?: string;
  threads?: number;
  probeTimeoutMs?: number;
  decodeTimeoutMs?: number;
  asrTimeoutMs?: number;
  processRunner?: ProcessRunner;
}

export interface AudioReadiness {
  ready: boolean;
  code: "MEDIA_AUDIO_READY" | "MEDIA_AUDIO_TOOLS_MISSING" | "MEDIA_AUDIO_MODEL_MISSING";
}

async function checkModel(path: string | undefined): Promise<void> {
  if (!path) throw new MediaError("MEDIA_AUDIO_MODEL_MISSING");
  try {
    await checkedPath(path, "file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(48);
      const result = await handle.read(header, 0, header.length, 0);
      // whisper.cpp GGML multilingual small, including quantized variants; not small.en.
      if (result.bytesRead < 48 || header.readUInt32LE(0) !== 0x67676d6c ||
          header.readInt32LE(4) !== 51865 || header.readInt32LE(12) !== 768 ||
          header.readInt32LE(16) !== 12 || header.readInt32LE(20) !== 12 ||
          header.readInt32LE(28) !== 768 || header.readInt32LE(32) !== 12 ||
          header.readInt32LE(36) !== 12) throw new MediaError("MEDIA_AUDIO_MODEL_MISSING");
    } finally { await handle.close(); }
  } catch { throw new MediaError("MEDIA_AUDIO_MODEL_MISSING"); }
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
  try { await checkModel(settings.modelPath); }
  catch { return { ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" }; }
  return { ready: true, code: "MEDIA_AUDIO_READY" };
}

export function createAudioTranscriber(settings: AudioSettings = {}) {
  const queue = new SerialQueue();
  const runner = settings.processRunner ?? runManagedProcess;
  return {
    run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> { return queue.run(signal, operation); },
    async transcribe(path: string, signal: AbortSignal, guard: () => void = () => {}): Promise<string> {
      const check = () => { checkAbort(signal); guard(); };
      check();
      await checkModel(settings.modelPath);
      check();
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
      const language = settings.language ?? "auto";
      if (!/^(?:auto|[a-z]{2,3})$/.test(language)) throw new MediaError("MEDIA_AUDIO_FAILED");
      const threads = Math.max(1, Math.min(8, Math.floor(settings.threads ?? 4)));
      if (!Number.isFinite(threads)) throw new MediaError("MEDIA_AUDIO_FAILED");
      const prefix = join(directory, "transcript");
      await runner(settings.whisperPath ?? "whisper-cli", ["-m", settings.modelPath!, "-f", wav,
        "-l", language, "-t", String(threads), "-otxt", "-of", prefix, "-np", "-nt"], {
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
    },
  };
}
