import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaError } from "../../src/media/errors.js";
import type { ProcessRunner } from "../../src/media/process.js";
import { whisperArgs, whisperDtwPreset } from "../../src/media/whisper.js";
import { readTimedTranscript } from "../../src/modules/recordings/api.js";
import { RECORDING_DEFAULTS, type RecordingSettings } from "../../src/modules/recordings/settings.js";
import { checkSpeakerModels, diarize, type SpeakerSettings } from "../../src/modules/recordings/speakers/index.js";
import {
  assignSpeakers, buildPhrases, smoothSpeakers, filterSegments, formatTranscript, timecode, whisperSegments,
  type TimedSegment,
} from "../../src/modules/recordings/timed.js";
import { transcribeRecording } from "../../src/modules/recordings/transcribe.js";

let tmp: string;
beforeEach(() => { tmp = resolve(".cache", `recordings-timed-${randomUUID()}`); mkdirSync(tmp, { recursive: true }); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A silent 16 kHz mono 16-bit PCM WAV of `seconds`. */
function pcmWav(seconds: number): Buffer {
  const body = Buffer.alloc(seconds * 32_000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + body.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

const word = (start: number, end: number, text: string) => ({ start, end, text });
const segment = (...words: ReturnType<typeof word>[]): TimedSegment => ({ start: words[0]!.start, end: words.at(-1)!.end, words });

describe("whisper JSON → timed words (spec 006, FR-004)", () => {
  it("builds words from tokens, preferring DTW times and skipping special tokens, shifted by the chunk start", () => {
    const json = { result: { language: "uk" }, transcription: [{
      offsets: { from: 29_960, to: 35_000 },
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 }, t_dtw: -1 },
        { text: " Д", offsets: { from: 30_000, to: 30_390 }, t_dtw: 3150 },
        { text: "обре", offsets: { from: 30_520, to: 31_410 }, t_dtw: 3170 },
        { text: ",", offsets: { from: 31_410, to: 31_500 }, t_dtw: 3200 },
        { text: " у", offsets: { from: 33_480, to: 33_680 }, t_dtw: 3260 },
        { text: "яви", offsets: { from: 33_680, to: 34_590 }, t_dtw: 3290 },
        { text: "[_TT_150]", offsets: { from: 34_590, to: 34_590 }, t_dtw: -1 },
      ],
    }] };
    const { language, segments } = whisperSegments(json, 17);
    expect(language).toBe("uk");
    expect(segments).toEqual([{ start: 46.96, end: 52, words: [
      { start: 48.5, end: 49.6, text: "Добре," }, { start: 49.6, end: 50.2, text: "уяви" },
    ] }]);
    expect(() => whisperSegments({}, 0)).toThrow();
  });

  it("applies spec 004's filter to timed segments", () => {
    const segments = [segment(word(0, 1, "[музика]")), segment(word(1, 2, "так")), segment(word(2, 3, "так")),
      segment(word(3, 4, "так")), segment(word(4, 5, "що"), word(5, 6, "вийде,"), word(6, 7, "що"), word(7, 8, "вийде,"),
        word(8, 9, "що"), word(9, 10, "вийде."))];
    expect(filterSegments(segments).map((item) => item.words.map((entry) => entry.text).join(" "))).toEqual(["так", "що вийде."]);
    expect(filterSegments(segments)[0]!.start).toBe(3);
  });
});

describe("speakers and phrases (spec 006, FR-002/FR-003)", () => {
  const segments = [segment(word(0, 0.5, "Привіт,"), word(0.6, 1, "як"), word(1.1, 1.5, "справи?"), word(2, 3.2, "Добре.")),
    segment(word(10, 10.5, "Далі."))];
  const turns = [{ start: 0, end: 1.6, speaker: 1 }, { start: 1.9, end: 3.3, speaker: 0 }, { start: 9.8, end: 11, speaker: 1 }];

  it("assigns each word the turn it overlaps most, else a near one, else the previous word's", () => {
    expect(assignSpeakers([word(0, 1, "a"), word(1.5, 2.5, "b"), word(5, 6, "c")], turns)).toEqual([1, 0, 0]);
  });

  it("labels the owner by name and others by first appearance, splitting phrases at speaker changes", () => {
    const owned = buildPhrases(segments, { turns, ownerSpeaker: 0 }, "Owner");
    expect(owned.speakers).toEqual(["Speaker 2", "Owner"]);
    expect(formatTranscript(owned)).toBe("[00:00:00] Speaker 2: Привіт, як справи?\n[00:00:02] Owner: Добре.\n[00:00:10] Speaker 2: Далі.\n");
    expect(owned.phrases[1]).toEqual({ start: 2, end: 3.2, speaker: "Owner", text: "Добре.", words: [word(2, 3.2, "Добре.")] });
    expect(buildPhrases(segments, { turns }, "Owner").speakers).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("absorbs short speaker islands at segment edges and splits phrases at long pauses", () => {
    const words = [word(0, 0.3, "з"), word(0.3, 0.5, "1"), word(0.6, 2, "числа"), word(2, 3, "почне.")];
    expect(smoothSpeakers(words, [0, 0, 1, 1])).toEqual([1, 1, 1, 1]);
    expect(smoothSpeakers(words, [1, 0, 0, 0])).toEqual([0, 0, 0, 0]);
    expect(smoothSpeakers([...words, word(3, 5, "далі")], [0, 0, 0, 1, 1])).toEqual([0, 0, 0, 1, 1]);
    const paused = buildPhrases([segment(word(0, 1, "Раз."), word(2.6, 3, "Два"), word(6.5, 7, "три"))], undefined, "Owner");
    expect(paused.phrases.map((phrase) => phrase.text)).toEqual(["Раз.", "Два", "три"]);
  });

  it("labels everything Speaker without diarization and marks no speech", () => {
    expect(formatTranscript(buildPhrases(segments, undefined, "Owner"))).toBe("[00:00:00] Speaker: Привіт, як справи? Добре.\n[00:00:10] Speaker: Далі.\n");
    expect(formatTranscript(buildPhrases([], undefined, "Owner"))).toBe("[no speech detected]\n");
    expect(timecode(3_725.9)).toBe("01:02:05");
  });
});

describe("whisper flags", () => {
  const base = { model: "m.bin", wav: "a.wav", outputPrefix: "out", language: "uk", threads: 4 };
  it("keeps voice-message flags unchanged and switches timed runs to full JSON with DTW", () => {
    expect(whisperArgs(base)).toEqual(["-m", "m.bin", "-f", "a.wav", "-l", "uk", "-t", "4", "-otxt", "-of", "out", "-np", "-nt"]);
    expect(whisperArgs({ ...base, json: true, dtw: "large.v3.turbo" })).toEqual(["-m", "m.bin", "-f", "a.wav", "-l", "uk", "-t", "4",
      "-oj", "-ojf", "-of", "out", "-nt", "-nfa", "-dtw", "large.v3.turbo"]);
    expect(() => whisperArgs({ ...base, dtw: "x; rm" })).toThrow();
  });
  it("derives the DTW preset from the model header", async () => {
    const header = (fields: number[]) => {
      const bytes = Buffer.alloc(48);
      [0x67676d6c, ...fields].forEach((value, index) => bytes.writeInt32LE(value, index * 4));
      return bytes;
    };
    const write = (name: string, fields: number[]) => { writeFileSync(join(tmp, name), header(fields)); return join(tmp, name); };
    expect(await whisperDtwPreset(write("turbo.bin", [51866, 1500, 1280, 20, 32, 448, 1280, 20, 4, 128]))).toBe("large.v3.turbo");
    expect(await whisperDtwPreset(write("v3.bin", [51866, 1500, 1280, 20, 32, 448, 1280, 20, 32, 128]))).toBe("large.v3");
    expect(await whisperDtwPreset(write("small.bin", [51865, 1500, 768, 12, 12, 448, 768, 12, 12, 80]))).toBe("small");
    expect(await whisperDtwPreset(join(tmp, "absent.bin"))).toBeUndefined();
  });
});

describe("diarization runner contract", () => {
  function models(): SpeakerSettings {
    for (const name of ["seg.onnx", "emb.onnx"]) { writeFileSync(join(tmp, name), ""); truncateSync(join(tmp, name), 200_000); }
    return { segmentationModelPath: join(tmp, "seg.onnx"), embeddingModelPath: join(tmp, "emb.onnx"), ownerName: "Owner" };
  }
  const worker = (result: unknown): ProcessRunner => async (executable, args, options) => {
    if (basename(executable).startsWith("node")) {
      const request = JSON.parse(readFileSync(args.at(-1)!, "utf8")) as { output: string; ownerWav?: string; clusterThreshold: number };
      options.onStderrLine?.("progress = 40%");
      writeFileSync(request.output, JSON.stringify(result));
    } else writeFileSync(args.at(-1)!, "RIFF");
    return { stdout: "", stderr: "" };
  };

  it("checks models and runs the worker out of process, decoding the owner sample first", async () => {
    expect(await checkSpeakerModels({ segmentationModelPath: join(tmp, "x"), embeddingModelPath: join(tmp, "y"), ownerName: "O" }))
      .toBe("SPEAKERS_MODEL_MISSING");
    const settings = { ...models(), ownerSamplePath: join(tmp, "me.m4a") };
    expect(await checkSpeakerModels(settings)).toBe("SPEAKERS_READY");
    const calls: string[] = [];
    const progress: number[] = [];
    const runner: ProcessRunner = async (executable, args, options) => { calls.push(basename(executable)); return worker({
      turns: [{ start: 2, end: 3, speaker: 1 }, { start: 0, end: 1, speaker: 0 }], ownerSpeaker: 1 })(executable, args, options); };
    const result = await diarize(join(tmp, "a.wav"), settings, { runner, signal: new AbortController().signal, workDir: tmp,
      ffmpegPath: "/x/ffmpeg", timeoutMs: 1_000, onProgress: (value) => progress.push(value) });
    expect(calls[0]).toBe("ffmpeg");
    expect(calls[1]).toMatch(/^node/);
    expect(result).toEqual({ turns: [{ start: 0, end: 1, speaker: 0 }, { start: 2, end: 3, speaker: 1 }], ownerSpeaker: 1 });
    expect(progress).toEqual([40]);
  });

  it("fails with a fixed code on bad output and propagates an abort", async () => {
    const settings = models();
    const options = { signal: new AbortController().signal, workDir: tmp, ffmpegPath: "/x/ffmpeg", timeoutMs: 1_000 };
    await expect(diarize(join(tmp, "a.wav"), settings, { ...options, runner: worker({ turns: [{ start: 2, end: 1, speaker: 0 }] }) }))
      .rejects.toMatchObject({ code: "SPEAKERS_FAILED" });
    rmSync(join(tmp, "speakers-request.json"));
    await expect(diarize(join(tmp, "a.wav"), settings, { ...options,
      runner: async () => { throw new MediaError("MEDIA_ABORTED"); } })).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
  });
});

describe("transcribeRecording with speakers", () => {
  it("publishes a labelled transcript and its words.json; failed separation falls back to Speaker", async () => {
    const header = Buffer.alloc(48);
    [0x67676d6c, 51866, 1500, 1280, 20, 32, 448, 1280, 20, 4, 128].forEach((value, index) => header.writeInt32LE(value, index * 4));
    writeFileSync(join(tmp, "model.bin"), header);
    writeFileSync(join(tmp, "vad.bin"), Buffer.from([0x6c, 0x6d, 0x67, 0x67]));
    for (const name of ["seg.onnx", "emb.onnx"]) { writeFileSync(join(tmp, name), ""); truncateSync(join(tmp, name), 200_000); }
    const out = join(tmp, "out");
    const work = join(tmp, "work");
    mkdirSync(out); mkdirSync(work);
    const speakers = { segmentationModelPath: join(tmp, "seg.onnx"), embeddingModelPath: join(tmp, "emb.onnx"), ownerName: "Owner" };
    const settings: RecordingSettings = {
      path: tmp, modelPath: join(tmp, "model.bin"), vadModelPath: join(tmp, "vad.bin"), ffmpegPath: "/x/ffmpeg", ffprobePath: "/x/ffprobe",
      whisperPath: "/x/whisper-cli", language: "auto", threads: 4, vocabulary: [], quietMinutes: 2, pollIntervalMs: 60_000,
      vad: { ...RECORDING_DEFAULTS.vad }, ...RECORDING_DEFAULTS.decoding,
      retry: { modelPath: join(tmp, "model.bin"), vad: { ...RECORDING_DEFAULTS.vad }, ...RECORDING_DEFAULTS.decoding },
      silence: { ...RECORDING_DEFAULTS.silence }, notifications: false, speakers,
    };
    let diarizationOk = true;
    let whisperArgsSeen: string[] = [];
    const runner: ProcessRunner = async (executable, args, options) => {
      const name = basename(executable);
      if (name === "whisper-vad-speech-segments") return { stdout: "Detected 1 speech segments:\nSpeech segment 0: start = 520.00, end = 780.00\n", stderr: "" };
      if (name === "whisper-cli") {
        whisperArgsSeen = args;
        options.onStderrLine?.("main: processing 'chunk-00000.wav' (48000 samples, 3.0 sec), 4 threads, 1 processors");
        // Times relative to the chunk, which starts at 5.00 (VAD 5.20 minus the 0.2 s pad).
        writeFileSync(join(options.cwd!, `${args[args.indexOf("-of") + 1]}.json`), JSON.stringify({ transcription: [{ offsets: { from: 0, to: 3_000 },
          tokens: [{ text: " Привіт", offsets: { from: 0, to: 500 }, t_dtw: 20 }, { text: " всім.", offsets: { from: 600, to: 1_000 }, t_dtw: 120 }] }] }));
      } else if (name.startsWith("node")) {
        if (!diarizationOk) throw new MediaError("MEDIA_AUDIO_FAILED");
        const request = JSON.parse(readFileSync(args.at(-1)!, "utf8")) as { output: string };
        writeFileSync(request.output, JSON.stringify({ turns: [{ start: 5, end: 8, speaker: 0 }], ownerSpeaker: 0 }));
      } else if (!args.some((arg) => arg.startsWith("silencedetect="))) writeFileSync(args.at(-1)!, pcmWav(10));
      return { stdout: "", stderr: "" };
    };
    const progress: number[] = [];
    const job = { recording: join(tmp, "v.mp4"), dayDirectory: out, key: "transcript", durationSeconds: 10, mode: "first" as const, replace: true };
    const context = { settings, runner, workRoot: work, signal: new AbortController().signal, onProgress: (value: number) => progress.push(value) };
    const result = await transcribeRecording(job, context);
    expect(result.speakers).toBe("separated");
    expect(whisperArgsSeen).toEqual(expect.arrayContaining(["-oj", "-ojf", "-dtw", "large.v3.turbo", "-nfa"]));
    expect(whisperArgsSeen).not.toContain("-np");
    expect(whisperArgsSeen).not.toContain("--vad");
    expect(readFileSync(result.transcript, "utf8")).toBe("[00:00:05] Owner: Привіт всім.\n");
    const words = await readTimedTranscript(result.words!);
    expect(words?.phrases[0]?.words).toEqual([{ start: 5.2, end: 6.2, text: "Привіт" }, { start: 6.2, end: 6.5, text: "всім." }]);
    expect(progress).toContain(85);

    diarizationOk = false;
    const fallback = await transcribeRecording(job, context);
    expect(fallback.speakers).toBe("unavailable");
    expect(readFileSync(fallback.transcript, "utf8")).toBe("[00:00:05] Speaker: Привіт всім.\n");
    await expect(transcribeRecording({ ...job, replace: false }, context)).rejects.toMatchObject({ code: "RECORDING_TARGET_EXISTS" });
  });
});
