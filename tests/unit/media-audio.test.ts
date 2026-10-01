import { constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingAttachment, IncomingMessage, LogicalInput, Run, Scope } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { openStore } from "../../src/storage/index.js";
import { checkAudioReadiness, createMediaPipeline, MediaError, runManagedProcess,
  type AudioSettings, type MediaPipeline, type ProcessRunner } from "../../src/media/index.js";

const scope: Scope = { ownerId: 222, botId: "voice-bot", chatId: 222, topicId: null };
let root: string;
let runtime: string;
let workspace: string;
let store: StateStore;
let modelPath: string;
let pipeline: MediaPipeline;
let voice: IncomingAttachment;
let voiceBytes: Buffer;
let run: Run;
let input: LogicalInput;
const signal = () => new AbortController().signal;
const diagnostics = { record: vi.fn() };

function wav(): Buffer {
  const dataSize = 3200;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}
function fakeRunner(duration = "0.1", transcript: string | Buffer = "Синтетична транскрипція"): ProcessRunner {
  return async (executable, args, options) => {
    options.signal.throwIfAborted();
    if (executable === "ffprobe") return { stdout: JSON.stringify({
      format: { duration }, streams: [{ codec_type: "audio", duration }],
    }), stderr: "" };
    if (executable === "ffmpeg") await writeFile(args.at(-1)!, wav(), { flag: "wx" });
    else if (executable === "whisper-cli") await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, transcript);
    else throw new MediaError("MEDIA_AUDIO_TOOLS_MISSING");
    return { stdout: "", stderr: "" };
  };
}
function setup(audio: AudioSettings = {}): MediaPipeline {
  return createMediaPipeline({ config: { runtimeDataPath: runtime, workspacePath: workspace }, store,
    download: async (_bot, _id, path, abort) => {
      abort.throwIfAborted();
      expect(existsSync(path)).toBe(false);
      const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(voiceBytes); } finally { await handle.close(); }
    }, diagnostics, audio: { modelPath, processRunner: fakeRunner(), ...audio } });
}
function audioFiles(): string[] { return readdirSync(join(runtime, "media", "audio")); }

beforeEach(() => {
  root = resolve(".cache", `media-audio-unit-${randomUUID()}`);
  runtime = join(root, "runtime");
  workspace = join(root, "workspace");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(workspace);
  store = openStore({ path: join(runtime, "state.sqlite") });
  modelPath = join(root, "synthetic-small.bin");
  const header = Buffer.alloc(48);
  [0x67676d6c, 51865, 1500, 768, 12, 12, 448, 768, 12, 12, 80, 1]
    .forEach((value, index) => header.writeInt32LE(value, index * 4));
  writeFileSync(modelPath, header);
  voiceBytes = wav();
  voice = { kind: "voice", fileId: "synthetic-voice", mimeType: "audio/wav", durationSeconds: 0.1 };
  const session = store.sessions.create(scope, { agentId: "synthetic", workspace, model: "synthetic-model" });
  const message: IncomingMessage = { kind: "message", scope, chatKind: "private", updateId: 1,
    messageId: 1, receivedAt: Date.now(), text: "voice caption", attachments: [voice] };
  const admission = store.inbox.admit(message, { sessionId: session.id, reserveRun: true });
  run = admission.run!;
  input = admission.input!;
  pipeline = setup();
  diagnostics.record.mockClear();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("local-only voice preparation", () => {
  it("returns automatic transcript, preserves caption, and removes raw audio/WAV/text files on success", async () => {
    const result = await pipeline.prepare(input, run, signal());
    expect(result.text).toContain("voice caption");
    expect(result.text).toContain("[Automatic voice transcription]");
    expect(result.text).toContain("Синтетична транскрипція");
    expect(result.notices).toEqual([expect.stringContaining("you can correct it")]);
    expect(result.images).toEqual([]);
    expect(result.attachmentIds).toEqual([]);
    expect(store.attachments.list(scope, run.sessionId)).toEqual([]);
    expect(audioFiles()).toEqual([]);
  });
  it("supports stateless pending-question transcription without assuming a run identity", async () => {
    store.runs.finish(run, "cancelled");
    const transientScope = { ...scope, chatId: 333 };
    await expect(pipeline.transcribe(voice, transientScope, signal())).resolves.toBe("Синтетична транскрипція");
    expect(store.sessions.current(transientScope)).toBeNull();
    expect(audioFiles()).toEqual([]);
  });
  it("uses actual ffprobe duration, permits 600 seconds, rejects 600.001 and ignores misleading metadata", async () => {
    pipeline = setup({ processRunner: fakeRunner("600") });
    await expect(pipeline.transcribe({ ...voice, durationSeconds: 9999 }, scope, signal())).resolves.toContain("Синтетична");
    pipeline = setup({ processRunner: fakeRunner("600.001") });
    await expect(pipeline.transcribe({ ...voice, durationSeconds: 1 }, scope, signal())).rejects.toMatchObject({ code: "MEDIA_AUDIO_TOO_LONG" });
    expect(audioFiles()).toEqual([]);
    pipeline = setup({ processRunner: fakeRunner("NaN") });
    await expect(pipeline.transcribe(voice, scope, signal())).rejects.toMatchObject({ code: "MEDIA_AUDIO_INVALID" });
    expect(audioFiles()).toEqual([]);
  });
  it("detects actual decoded duration beyond a lying source duration before invoking ASR", async () => {
    const fake = fakeRunner();
    const runner = vi.fn<ProcessRunner>(async (executable, args, options) => {
      if (executable === "ffprobe" && args.at(-1)?.endsWith("decoded.wav")) return {
        stdout: JSON.stringify({ format: { duration: "600.01" } }), stderr: "",
      };
      return fake(executable, args, options);
    });
    pipeline = setup({ processRunner: runner });
    await expect(pipeline.transcribe(voice, scope, signal())).rejects.toMatchObject({ code: "MEDIA_AUDIO_TOO_LONG" });
    expect(runner.mock.calls.some((call) => call[0] === "whisper-cli")).toBe(false);
    expect(audioFiles()).toEqual([]);
  });
  it("fails actionably on missing/wrong model or missing native CLI, without automatic download/fallback", async () => {
    const missing = join(root, "not-provisioned.bin");
    const runner = vi.fn<ProcessRunner>(fakeRunner());
    pipeline = setup({ modelPath: missing, processRunner: runner });
    await expect(pipeline.transcribe(voice, scope, signal())).rejects.toMatchObject({ code: "MEDIA_AUDIO_MODEL_MISSING" });
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
    const english = Buffer.from(readFileSync(modelPath));
    english.writeInt32LE(51864, 4);
    writeFileSync(modelPath, english);
    await expect(setup().transcribe(voice, scope, signal())).rejects.toMatchObject({ code: "MEDIA_AUDIO_MODEL_MISSING" });
    expect(audioFiles()).toEqual([]);
    await expect(checkAudioReadiness({ whisperPath: join(root, "missing-whisper") }))
      .resolves.toEqual({ ready: false, code: "MEDIA_AUDIO_TOOLS_MISSING" });
    await expect(checkAudioReadiness({ ffmpegPath: process.execPath, ffprobePath: process.execPath,
      whisperPath: process.execPath, modelPath: missing })).resolves.toEqual({ ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" });
  });
  it.each([
    ["", "MEDIA_EMPTY"],
    ["x".repeat(200_001), "MEDIA_TEXT_TOO_LARGE"],
    [Buffer.from([0xc3, 0x28]), "MEDIA_INVALID_UTF8"],
    ["text\0bad", "MEDIA_INVALID_UTF8"],
  ])("rejects invalid transcripts and always removes derivative files", async (text, code) => {
    pipeline = setup({ processRunner: fakeRunner("0.1", text as string | Buffer) });
    await expect(pipeline.transcribe(voice, scope, signal())).rejects.toMatchObject({ code });
    expect(audioFiles()).toEqual([]);
  });
  it("cleans files after failures and stops preparing a stale run before the next process", async () => {
    const fake = fakeRunner();
    pipeline = setup({ processRunner: async (executable, args, options) => {
      if (executable === "ffmpeg") throw new MediaError("MEDIA_AUDIO_FAILED");
      return fake(executable, args, options);
    } });
    await expect(pipeline.transcribe(voice, scope, signal())).rejects.toMatchObject({ code: "MEDIA_AUDIO_FAILED" });
    expect(audioFiles()).toEqual([]);
    const runner = vi.fn<ProcessRunner>(async (executable, args, options) => {
      const result = await fake(executable, args, options);
      store.runs.cancel(run);
      return result;
    });
    pipeline = setup({ processRunner: runner });
    await expect(pipeline.prepare(input, run, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(audioFiles()).toEqual([]);
  });
  it("serializes ASR, cancels waiting and running requests, and never cleans active audio", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const fake = fakeRunner();
    const runner = vi.fn<ProcessRunner>(async (executable, args, options) => {
      if (executable === "whisper-cli") {
        started();
        await new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new MediaError("MEDIA_ABORTED")), { once: true });
        });
      }
      return fake(executable, args, options);
    });
    pipeline = setup({ processRunner: runner });
    const firstAbort = new AbortController();
    const first = pipeline.transcribe(voice, scope, firstAbort.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    await running;
    const waitingAbort = new AbortController();
    const second = pipeline.transcribe(voice, scope, waitingAbort.signal);
    waitingAbort.abort();
    await expect(second).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    await pipeline.cleanup();
    expect(audioFiles()).toHaveLength(1);
    expect(runner.mock.calls.filter((call) => call[0] === "whisper-cli")).toHaveLength(1);
    firstAbort.abort();
    await firstRejected;
    expect(audioFiles()).toEqual([]);
  });
  it("startup removes owned orphan audio only, including derivatives, and preserves workspace files", async () => {
    await pipeline.cleanup();
    const directory = join(runtime, "media", "audio", randomUUID());
    mkdirSync(directory);
    writeFileSync(join(directory, ".densemble-media.json"), JSON.stringify({ version: 1, id: randomUUID(),
      kind: "audio", scope, sessionId: null, runId: null }));
    for (const file of ["payload", "decoded.wav", "transcript.txt"]) writeFileSync(join(directory, file), "synthetic");
    writeFileSync(join(workspace, "keep.wav"), "workspace");
    const foreign = join(runtime, "media", "audio", "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.wav"), "foreign");
    store.recover();
    await setup().cleanup();
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(join(workspace, "keep.wav"), "utf8")).toBe("workspace");
    expect(readFileSync(join(foreign, "keep.wav"), "utf8")).toBe("foreign");
  });
});

describe("real owned subprocess management", () => {
  it("uses literal spawn arguments and bounded stdout without invoking a shell", async () => {
    const literal = "$(touch SHOULD_NOT_EXIST); & echo secret";
    await expect(runManagedProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal],
      { signal: signal(), timeoutMs: 2000 })).resolves.toMatchObject({ stdout: literal });
    await expect(runManagedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"],
      { signal: signal(), timeoutMs: 2000, maxOutputBytes: 10 })).rejects.toMatchObject({ code: "MEDIA_AUDIO_FAILED" });
    await expect(runManagedProcess(join(root, "missing-cli"), [], { signal: signal(), timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "MEDIA_AUDIO_TOOLS_MISSING" });
  });
  it("cancels its exact owned process tree and does not affect a sibling process", async () => {
    const childPidFile = join(root, "owned-child.pid");
    const otherAbort = new AbortController();
    const other = runManagedProcess(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('unaffected'),900)"],
      { signal: otherAbort.signal, timeoutMs: 3000 });
    const abort = new AbortController();
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');
      process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
    const pending = runManagedProcess(process.execPath, ["-e", source, childPidFile], { signal: abort.signal, timeoutMs: 5000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    try {
      for (let i = 0; i < 100 && !existsSync(childPidFile); i++) await delay(10);
      expect(existsSync(childPidFile)).toBe(true);
      const pid = Number(readFileSync(childPidFile, "utf8"));
      abort.abort();
      await rejected;
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await delay(10);
      }
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(other).resolves.toMatchObject({ stdout: "unaffected" });
    } finally {
      abort.abort();
      otherAbort.abort();
      await Promise.allSettled([pending, other]);
    }
  }, 10_000);
  it("times out an uncooperative real process and removes audio after real process cancellation", async () => {
    await expect(runManagedProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { signal: signal(), timeoutMs: 50 })).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
    const fake = fakeRunner();
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    pipeline = setup({ processRunner: async (executable, args, options) => {
      if (executable === "whisper-cli") {
        start();
        return runManagedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
      }
      return fake(executable, args, options);
    } });
    const abort = new AbortController();
    const pending = pipeline.transcribe(voice, scope, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    await started;
    abort.abort();
    await rejected;
    expect(audioFiles()).toEqual([]);
  });
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!hasFfmpeg)("validates and decodes real synthetic audio with installed ffmpeg/ffprobe (ASR stand-in only)", async () => {
    const generated = join(root, "synthetic.wav");
    await runManagedProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "sine=frequency=440:duration=0.2", "-c:a", "pcm_s16le", "-n", generated], { signal: signal(), timeoutMs: 5000 });
    voiceBytes = readFileSync(generated);
    const fake = fakeRunner();
    pipeline = setup({ processRunner: (executable, args, options) => executable === "whisper-cli" ?
      fake(executable, args, options) : runManagedProcess(executable, args, options) });
    await expect(pipeline.transcribe(voice, scope, signal())).resolves.toBe("Синтетична транскрипція");
    expect(audioFiles()).toEqual([]);
  }, 15_000);
});
