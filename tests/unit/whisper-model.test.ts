import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaError } from "../../src/media/errors.js";
import { checkVadModel, checkWhisperModel, vocabularyPrompt, whisperArgs, type WhisperRunOptions } from "../../src/media/whisper.js";

const MAGIC = 0x67676d6c;
let root: string;

interface Shape { vocab?: number; state: number; layers: number; textLayers?: number; head?: number; textHead?: number;
  textState?: number; mels?: number; ftype?: number; magic?: number }

function header(shape: Shape): Buffer {
  const head = shape.head ?? shape.state / 64;
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32LE(shape.magic ?? MAGIC, 0);
  [shape.vocab ?? 51865, 1500, shape.state, head, shape.layers, 448, shape.textState ?? shape.state,
    shape.textHead ?? head, shape.textLayers ?? shape.layers, shape.mels ?? 80, shape.ftype ?? 1]
    .forEach((value, index) => buffer.writeInt32LE(value, 4 + index * 4));
  return buffer;
}
function file(name: string, content: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  root = resolve(".cache", `whisper-model-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("checkWhisperModel", () => {
  it.each([
    ["tiny", { state: 384, layers: 4 }],
    ["base", { state: 512, layers: 6 }],
    ["small", { state: 768, layers: 12 }],
    ["medium", { state: 1024, layers: 24 }],
    ["large-v2", { state: 1280, layers: 32 }],
    ["large-v3", { state: 1280, layers: 32, vocab: 51866, mels: 128 }],
    ["large-v3-turbo", { state: 1280, layers: 32, textLayers: 4, vocab: 51866, mels: 128 }],
    ["small q5_1", { state: 768, layers: 12, ftype: 9 }],
    ["turbo q8_0", { state: 1280, layers: 32, textLayers: 4, vocab: 51866, mels: 128, ftype: 7 }],
  ] as [string, Shape][])("accepts multilingual %s", async (name, shape) => {
    await expect(checkWhisperModel(file(`${name}.bin`, header(shape)))).resolves.toBe("MEDIA_AUDIO_READY");
  });

  it("flags English-only models", async () => {
    await expect(checkWhisperModel(file("small.en.bin", header({ state: 768, layers: 12, vocab: 51864 }))))
      .resolves.toBe("MEDIA_AUDIO_MODEL_ENGLISH_ONLY");
  });

  it.each([
    ["truncated", header({ state: 768, layers: 12 }).subarray(0, 47)],
    ["empty", Buffer.alloc(0)],
    ["bad magic", header({ state: 768, layers: 12, magic: 0x67676a74 })],
    ["mismatched head", header({ state: 768, layers: 12, head: 16 })],
    ["mismatched text head", header({ state: 768, layers: 12, textHead: 8 })],
    ["mismatched text state", header({ state: 768, layers: 12, textState: 512 })],
    ["unknown size", header({ state: 640, layers: 12 })],
    ["wrong layer count", header({ state: 768, layers: 24 })],
    ["odd text layers", header({ state: 768, layers: 12, textLayers: 6 })],
    ["bad mels", header({ state: 768, layers: 12, mels: 64 })],
    ["unknown vocab", header({ state: 768, layers: 12, vocab: 50000 })],
    ["English-only with bad shape", header({ state: 640, layers: 12, vocab: 51864 })],
  ])("rejects %s", async (name, content) => {
    await expect(checkWhisperModel(file(`${name}.bin`, content))).resolves.toBe("MEDIA_AUDIO_MODEL_UNSUPPORTED");
  });

  it("treats missing, undefined, symlinked and directory paths as missing", async () => {
    const target = file("real.bin", header({ state: 768, layers: 12 }));
    const link = join(root, "link.bin");
    symlinkSync(target, link);
    await expect(checkWhisperModel(link)).resolves.toBe("MEDIA_AUDIO_MODEL_MISSING");
    await expect(checkWhisperModel(join(root, "absent.bin"))).resolves.toBe("MEDIA_AUDIO_MODEL_MISSING");
    await expect(checkWhisperModel(undefined)).resolves.toBe("MEDIA_AUDIO_MODEL_MISSING");
    await expect(checkWhisperModel(root)).resolves.toBe("MEDIA_AUDIO_MODEL_MISSING");
    await expect(checkWhisperModel("relative.bin")).resolves.toBe("MEDIA_AUDIO_MODEL_MISSING");
  });

  const small = resolve("models/ggml-small.bin");
  it.skipIf(!existsSync(small))("accepts the real ggml-small.bin", async () => {
    await expect(checkWhisperModel(small)).resolves.toBe("MEDIA_AUDIO_READY");
  });

  // large-v3-turbo is ~1.6 GB; only check it once fully downloaded.
  const turbo = resolve("models/ggml-large-v3-turbo.bin");
  it.skipIf(!existsSync(turbo) || statSync(turbo).size < 1_500_000_000)("accepts the real ggml-large-v3-turbo.bin", async () => {
    await expect(checkWhisperModel(turbo)).resolves.toBe("MEDIA_AUDIO_READY");
  });
});

describe("checkVadModel", () => {
  it("accepts a ggml-magic file and rejects everything else", async () => {
    const magic = Buffer.alloc(4);
    magic.writeUInt32LE(MAGIC, 0);
    await expect(checkVadModel(file("vad.bin", Buffer.concat([magic, Buffer.from("silero")])))).resolves.toBe("MEDIA_AUDIO_READY");
    await expect(checkVadModel(file("exact.bin", magic))).resolves.toBe("MEDIA_AUDIO_READY");
    await expect(checkVadModel(file("short.bin", magic.subarray(0, 3)))).resolves.toBe("MEDIA_AUDIO_VAD_MODEL_INVALID");
    await expect(checkVadModel(file("wrong.bin", Buffer.from("GGUF\0\0\0\0")))).resolves.toBe("MEDIA_AUDIO_VAD_MODEL_INVALID");
    const link = join(root, "vad-link.bin");
    symlinkSync(join(root, "vad.bin"), link);
    await expect(checkVadModel(link)).resolves.toBe("MEDIA_AUDIO_VAD_MODEL_INVALID");
    await expect(checkVadModel(join(root, "absent.bin"))).resolves.toBe("MEDIA_AUDIO_VAD_MODEL_INVALID");
    await expect(checkVadModel(undefined)).resolves.toBe("MEDIA_AUDIO_VAD_MODEL_INVALID");
  });

  const silero = resolve("models/ggml-silero-v5.1.2.bin");
  it.skipIf(!existsSync(silero))("accepts the real Silero VAD model", async () => {
    await expect(checkVadModel(silero)).resolves.toBe("MEDIA_AUDIO_READY");
  });
});

describe("whisperArgs", () => {
  const base: WhisperRunOptions = { model: "/m/model.bin", wav: "/w/decoded.wav", outputPrefix: "/w/transcript", language: "auto", threads: 4 };
  const baseArgs = ["-m", "/m/model.bin", "-f", "/w/decoded.wav", "-l", "auto", "-t", "4", "-otxt", "-of", "/w/transcript", "-np", "-nt"];

  it("builds the base invocation", () => {
    expect(whisperArgs(base)).toEqual(baseArgs);
    expect(whisperArgs({ ...base, prompt: "", progress: false, vad: undefined, suppressNonSpeech: undefined, maxContext: undefined })).toEqual(baseArgs);
  });

  it("adds prompt, VAD, decoding and progress options", () => {
    expect(whisperArgs({ ...base, prompt: "Densemble, Kyiv" })).toEqual([...baseArgs, "--prompt", "Densemble, Kyiv"]);
    expect(whisperArgs({ ...base, vad: { modelPath: "/m/vad.bin", threshold: 0.5, minSpeechMs: 250, minSilenceMs: 100, padMs: 30 } }))
      .toEqual([...baseArgs, "--vad", "-vm", "/m/vad.bin", "-vt", "0.5", "-vspd", "250", "-vsd", "100", "-vp", "30"]);
    expect(whisperArgs({ ...base, suppressNonSpeech: true, maxContext: 0 })).toEqual([...baseArgs, "-sns", "-mc", "0"]);
    expect(whisperArgs({ ...base, suppressNonSpeech: false, maxContext: 64 })).toEqual([...baseArgs, "-mc", "64"]);
    expect(whisperArgs({ ...base, progress: true })).toEqual([...baseArgs, "-pp"]);
    expect(whisperArgs({ ...base, language: "uk", prompt: "a", suppressNonSpeech: true, maxContext: 0, progress: true }))
      .toEqual(["-m", "/m/model.bin", "-f", "/w/decoded.wav", "-l", "uk", "-t", "4", "-otxt", "-of", "/w/transcript", "-np", "-nt",
        "--prompt", "a", "-sns", "-mc", "0", "-pp"]);
  });

  it("clamps threads and validates inputs", () => {
    expect(whisperArgs({ ...base, threads: 0 })[7]).toBe("1");
    expect(whisperArgs({ ...base, threads: 3.9 })[7]).toBe("3");
    expect(whisperArgs({ ...base, threads: 64 })[7]).toBe("8");
    expect(() => whisperArgs({ ...base, maxContext: 1.5 })).toThrow(MediaError);
    for (const threads of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => whisperArgs({ ...base, threads })).toThrow(MediaError);
    }
    for (const language of ["", "EN", "english", "u", "uk-UA", "auto "]) {
      expect(() => whisperArgs({ ...base, language })).toThrow(expect.objectContaining({ code: "MEDIA_AUDIO_FAILED" }));
    }
  });
});

describe("vocabularyPrompt", () => {
  it("joins trimmed non-empty terms", () => {
    expect(vocabularyPrompt([" Densemble ", "", "  ", "Kyiv"])).toBe("Densemble, Kyiv");
    expect(vocabularyPrompt([])).toBeUndefined();
    expect(vocabularyPrompt(["  "])).toBeUndefined();
    expect(vocabularyPrompt(undefined)).toBeUndefined();
  });
});
