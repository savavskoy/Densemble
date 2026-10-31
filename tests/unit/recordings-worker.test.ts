import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MediaError } from "../../src/media/errors.js";
import type { ProcessControl, ProcessOptions, ProcessRunner } from "../../src/media/process.js";
import { SpeechGate } from "../../src/media/speech-gate.js";
import { acquireLegacyLock, legacyJobInstalled } from "../../src/recordings/legacy.js";
import type { DiagnosticSink } from "../../src/ports.js";
import { createNotifier, type RecordingNotifier } from "../../src/recordings/notify.js";
import { RECORDING_DEFAULTS, type RecordingSettings } from "../../src/recordings/settings.js";
import { readStatus, type RecordingStatus } from "../../src/recordings/status.js";
import { filterTranscript, NO_SPEECH } from "../../src/recordings/transcribe.js";
import { createRecordingWorker, type RecordingWorkerOptions } from "../../src/recordings/worker.js";

const MAGIC = 0x67676d6c;
const OBS = "2026-10-29 17-01-21.mp4";
const OBS_KEY = "transcript_2026-10-29_2026-10-29_17-01-21";

let tmp: string;
let root: string;
let runtime: string;
let clock: number;
let OLD: Date;

interface Call { executable: string; args: string[]; options: ProcessOptions }
interface WhisperContext { args: string[]; options: ProcessOptions; recording: string | undefined }
interface Fake {
  calls: Call[];
  open: Set<string>;
  inputs: string[];
  /** stderr lines the fake `silencedetect` run emits. */
  silence: string[];
  whisper: (context: WhisperContext) => Promise<string | undefined>;
  runner: ProcessRunner;
}

function makeFake(): Fake {
  const fake: Fake = {
    calls: [], open: new Set(), inputs: [], silence: [],
    whisper: async () => "Привіт\n",
    runner: async (executable, args, options) => {
      fake.calls.push({ executable, args, options });
      const ok = (stdout = "") => ({ stdout, stderr: "" });
      switch (basename(executable)) {
        case "sh": // lsof runs through sh so its own exit status is visible.
          return ok(fake.open.has(args.at(-1)!) ? "4242\nlsof-status:0\n" : "lsof-status:1\n");
        case "ffprobe":
          return ok("12.5\n");
        case "ffmpeg":
          if (args.some((arg) => arg.startsWith("silencedetect="))) {
            for (const line of fake.silence) options.onStderrLine?.(line);
            return ok();
          }
          fake.inputs.push(args[args.indexOf("-i") + 1]!);
          writeFileSync(args.at(-1)!, "RIFF....WAVE");
          return ok();
        case "whisper-cli": {
          const prefix = args[args.indexOf("-of") + 1]!;
          const text = await fake.whisper({ args, options, recording: fake.inputs.at(-1) });
          if (text !== undefined) writeFileSync(`${prefix}.txt`, text);
          return ok();
        }
        case "osascript":
          return ok();
        default:
          throw new Error(`unexpected ${executable}`);
      }
    },
  };
  return fake;
}

let fake: Fake;
let diagnostics: { record: Mock<DiagnosticSink["record"]> };
let notifier: { ready: Mock<RecordingNotifier["ready"]>; failed: Mock<RecordingNotifier["failed"]> };

function modelHeader(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32LE(MAGIC, 0);
  [51865, 1500, 768, 12, 12, 448, 768, 12, 12, 80, 1].forEach((value, index) => buffer.writeInt32LE(value, 4 + index * 4));
  return buffer;
}

function settings(overrides: Partial<RecordingSettings> = {}): RecordingSettings {
  return {
    path: root, modelPath: join(tmp, "models", "model.bin"), vadModelPath: join(tmp, "models", "vad.bin"),
    ffmpegPath: "/x/ffmpeg", ffprobePath: "/x/ffprobe", whisperPath: "/x/whisper-cli", language: "auto", threads: 4,
    vocabulary: [], quietMinutes: 2, pollIntervalMs: 60_000, vad: { ...RECORDING_DEFAULTS.vad }, ...RECORDING_DEFAULTS.decoding,
    retry: { modelPath: join(tmp, "models", "model.bin"), vad: { ...RECORDING_DEFAULTS.vad }, ...RECORDING_DEFAULTS.decoding },
    silence: { ...RECORDING_DEFAULTS.silence }, notifications: false, ...overrides,
  };
}

const legacyPlist = () => join(tmp, "legacy.plist");
const legacyLock = () => join(tmp, "legacy.lock");

function worker(extra: Partial<RecordingWorkerOptions> = {}) {
  return createRecordingWorker({
    settings: settings(), runtimeDataPath: runtime, diagnostics, runner: fake.runner, now: () => clock, notifier,
    legacy: { plist: legacyPlist(), lock: legacyLock() }, ...extra,
  });
}

/** Writes a recording relative to the watched root with an old mtime (finished unless told otherwise). */
function media(rel: string, content = "data", mtime: Date = OLD): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
  return path;
}

const statusPath = () => join(runtime, "recordings", "status.json");
const workRoot = () => join(runtime, "recordings", "work");
const status = async (): Promise<RecordingStatus> => {
  const value = await readStatus(statusPath());
  if (!value) throw new Error("no status");
  return value;
};
const codes = () => diagnostics.record.mock.calls.map((call) => call[0]);
const executables = () => fake.calls.map((call) => basename(call.executable));
const partials = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".partial"));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  tmp = resolve(".cache", `recordings-worker-unit-${randomUUID()}`);
  root = join(tmp, "Recordings");
  runtime = join(tmp, "runtime");
  mkdirSync(root, { recursive: true });
  // Most tests call pass() directly; the work directory exists as after start().
  mkdirSync(workRoot(), { recursive: true });
  mkdirSync(join(tmp, "models"));
  writeFileSync(join(tmp, "models", "model.bin"), modelHeader());
  writeFileSync(join(tmp, "models", "vad.bin"), Buffer.concat([Buffer.from([0x6c, 0x6d, 0x67, 0x67]), Buffer.alloc(16)]));
  clock = Date.now();
  OLD = new Date(clock - 3_600_000);
  fake = makeFake();
  diagnostics = { record: vi.fn<DiagnosticSink["record"]>() };
  notifier = { ready: vi.fn<RecordingNotifier["ready"]>(async () => undefined),
    failed: vi.fn<RecordingNotifier["failed"]>(async () => undefined) };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("filterTranscript", () => {
  it("drops tag-only lines and blank lines", () => {
    expect(filterTranscript("Привіт\n[музика]\n(Music)\n*аплодисменти*\n\n  світ  \r\n")).toBe("Привіт\nсвіт\n");
  });
  it("keeps runs of two and collapses runs of three or more", () => {
    expect(filterTranscript("a\na\nb\nb\nb\nc\nc\nc\nc\na\n")).toBe("a\na\nb\nc\na\n");
  });
  it("collapses a sentence or clause repeated three or more times within one line", () => {
    expect(filterTranscript("Далі. Та-да-да. Та-да-да. та-да-да. Кінець.\n")).toBe("Далі. та-да-да. Кінець.\n");
    expect(filterTranscript("І тоді, що вийде, що вийде, що вийде, що вийде. Вийде вийде.\n")).toBe("І тоді, що вийде. Вийде вийде.\n");
    expect(filterTranscript("Так, так, ні.\n")).toBe("Так, так, ні.\n");
    expect(filterTranscript("Я дуже злий. Я дуже злий. Я дуже злий на Юльку.\n")).toBe("Я дуже злий. Я дуже злий. Я дуже злий на Юльку.\n");
    expect(filterTranscript("Так. Так. Ні.\n")).toBe("Так. Так. Ні.\n");
    for (const line of ["...і далі текст", "Що?! Так… ну.. добре", "без крапки", "?!", "а. б? в! г… д", ", , , ,", "1,2,3"]) {
      expect(filterTranscript(`${line}\n`)).toBe(`${line}\n`);
    }
  });
  it("keeps lines that merely contain brackets", () => {
    expect(filterTranscript("[музика] і далі текст\n")).toBe("[музика] і далі текст\n");
  });
  it("marks empty output as no speech", () => {
    expect(filterTranscript("[музика]\n(Music)\n\n")).toBe(`${NO_SPEECH}\n`);
    expect(filterTranscript("")).toBe("[no speech detected]\n");
  });
});

describe("recording worker: filing and transcription", () => {
  it("files a finished OBS root recording and publishes a filtered transcript", async () => {
    const source = media(OBS);
    let during: RecordingStatus | undefined;
    fake.whisper = async ({ options }) => {
      clock += 10_000;
      options.onStderrLine?.("whisper_print_progress_callback: progress =  50%");
      await waitFor(async () => (await readStatus(statusPath()))?.current?.percent === 50);
      during = await status();
      return "Привіт\n[музика]\nрядок\nрядок\nрядок\nрядок\nкінець\n";
    };
    await worker().pass();

    const day = join(root, "2026", "10", "29");
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(day, OBS), "utf8")).toBe("data");
    expect(readFileSync(join(day, `${OBS_KEY}.txt`), "utf8")).toBe("Привіт\nрядок\nкінець\n");
    expect(partials(day)).toEqual([]);
    expect(readdirSync(workRoot())).toEqual([]);
    expect(during?.current).toMatchObject({ file: `2026/10/29/${OBS}`, mode: "first", percent: 50, etaSeconds: 10, paused: false });

    const lsof = fake.calls.find((call) => basename(call.executable) === "sh");
    expect(lsof?.args.slice(2)).toEqual(["/usr/sbin/lsof", source]);
    const whisper = fake.calls.find((call) => basename(call.executable) === "whisper-cli")!;
    const flag = (name: string) => whisper.args[whisper.args.indexOf(name) + 1];
    // First pass = benchmark config E: sensitive VAD, long pads, no carried context, -sns off.
    expect([flag("-m"), flag("-vt"), flag("-vspd"), flag("-vsd"), flag("-vp"), flag("-mc")])
      .toEqual([join(tmp, "models", "model.bin"), "0.35", "250", "500", "200", "0"]);
    expect(whisper.args).toContain("-pp");
    expect(whisper.args).not.toContain("-sns");
    expect(fake.inputs).toEqual([join(day, OBS)]);
    const silence = fake.calls.find((call) => call.args.some((arg) => arg.startsWith("silencedetect=")))!;
    expect(silence.args).toEqual(expect.arrayContaining(["-af", "silencedetect=noise=-80dB:d=60", "-f", "null", "-"]));
    expect(silence.args[silence.args.indexOf("-i") + 1]).toMatch(/audio\.wav$/);

    expect(codes()).toEqual(expect.arrayContaining(["RECORDING_FILED", "RECORDING_STARTED", "RECORDING_DONE"]));
    expect(diagnostics.record).toHaveBeenCalledWith("RECORDING_STARTED", { attempt: 1 });
    expect(notifier.ready).toHaveBeenCalledExactlyOnceWith(OBS, `2026/10/29/${OBS}`, undefined);
    expect(notifier.failed).not.toHaveBeenCalled();

    expect(statSync(statusPath()).mode & 0o777).toBe(0o600);
    const final = await status();
    expect(final).toMatchObject({ version: 1, enabled: true, pollIntervalMs: 60_000, current: null, queue: [], waiting: [],
      conflicts: [], failed: [] });
    expect(final.recent).toEqual([{ file: `2026/10/29/${OBS}`, transcript: `2026/10/29/${OBS_KEY}.txt`, at: expect.any(String) }]);
    expect(Object.keys(final).sort()).toEqual(["conflicts", "current", "enabled", "failed", "pollIntervalMs", "queue", "recent",
      "updatedAt", "version", "waiting"]);
  });

  it("files a non-OBS name by its local mtime date", async () => {
    media("meeting.m4a", "m", new Date(2026, 8, 3, 12, 0, 0));
    await worker().pass();
    expect(readFileSync(join(root, "2026", "09", "03", "transcript_2026-09-03_meeting.txt"), "utf8")).toBe("Привіт\n");
    expect(existsSync(join(root, "meeting.m4a"))).toBe(false);
  });

  it("leaves open or recently modified recordings in the root as waiting", async () => {
    const open = media("open.mp4");
    fake.open.add(open);
    const fresh = media("fresh.mp4", "f", new Date(clock - 30_000));
    await worker().pass();
    expect(existsSync(open) && existsSync(fresh)).toBe(true);
    expect((await status()).waiting.sort()).toEqual(["fresh.mp4", "open.mp4"]);
    expect(diagnostics.record).toHaveBeenCalledWith("RECORDING_WAITING", { count: 2 });
    expect(executables()).not.toContain("whisper-cli");

    fake.open.clear();
    clock += 5 * 60_000;
    await worker().pass();
    expect(existsSync(open) || existsSync(fresh)).toBe(false);
    expect((await status()).waiting).toEqual([]);
  });

  it("reports a root recording whose name already exists in its day folder, overwriting nothing", async () => {
    const existing = media(`2026/10/29/${OBS}`, "old");
    const source = media(OBS, "new");
    await worker().pass();
    expect(readFileSync(source, "utf8")).toBe("new");
    expect(readFileSync(existing, "utf8")).toBe("old");
    expect((await status()).conflicts).toEqual([{ file: OBS, reason: "TARGET_EXISTS" }]);
    expect(diagnostics.record).toHaveBeenCalledWith("RECORDING_CONFLICT", { reason: "TARGET_EXISTS" });
  });

  it("never re-transcribes a labelled transcript or a kept attempt, even after the recording is deleted", async () => {
    media("2026/10/29/a.mp4");
    media("2026/10/29/b.mp4");
    const day = join(root, "2026", "10", "29");
    writeFileSync(join(day, "standup_transcript_2026-10-29_a.txt"), "labelled");
    writeFileSync(join(day, "transcript_2026-10-29_b.attempt-1.txt"), "attempt");
    writeFileSync(join(day, "transcript_2026-10-29_gone.txt"), "recording deleted");
    const before = readdirSync(day).sort();
    await worker().pass();
    expect(executables()).not.toContain("whisper-cli");
    expect(executables()).not.toContain("ffmpeg");
    expect(readdirSync(day).sort()).toEqual(before);
    expect((await status()).queue).toEqual([]);
  });

  it("retranscribes a reviewed recording with the retry model and keeps the attempt", async () => {
    media("2026/10/29/x.mp4");
    const day = join(root, "2026", "10", "29");
    writeFileSync(join(day, "transcript_2026-10-29_x.attempt-1.txt"), "bad attempt");
    writeFileSync(join(root, "review-log.tsv"),
      "2026-10-29T10:00:00\tretranscribe\t2026/10/29/transcript_2026-10-29_x.txt\t2026/10/29/x.mp4\thallucination\n");
    let mode: string | undefined;
    fake.whisper = async () => { mode = (await status()).current?.mode; return "краще\n"; };
    const large = join(tmp, "models", "large.bin");
    writeFileSync(large, modelHeader());
    const base = settings();
    await worker({ settings: { ...base, retry: { ...base.retry, modelPath: large } } }).pass();
    const whisper = fake.calls.find((call) => basename(call.executable) === "whisper-cli")!;
    const flag = (name: string) => whisper.args[whisper.args.indexOf(name) + 1];
    // Stronger model, same VAD as the first pass: stricter VAD dropped real speech in the benchmark (FR-029).
    expect(flag("-m")).toBe(large);
    expect([flag("-vt"), flag("-vspd"), flag("-vsd"), flag("-vp"), flag("-mc")]).toEqual(["0.35", "250", "500", "200", "0"]);
    expect(mode).toBe("retry");
    expect(diagnostics.record).toHaveBeenCalledWith("RECORDING_STARTED", { attempt: 2 });
    expect(readFileSync(join(day, "transcript_2026-10-29_x.txt"), "utf8")).toBe("краще\n");
    expect(readFileSync(join(day, "transcript_2026-10-29_x.attempt-1.txt"), "utf8")).toBe("bad attempt");

    await worker().pass();
    expect(executables().filter((name) => name === "whisper-cli")).toHaveLength(1);
  });

  it("fails a retry with MODEL_UNAVAILABLE when the retry model is missing, first passes unaffected", async () => {
    media("2026/10/29/x.mp4");
    media("2026/10/29/y.mp4", "y", new Date(OLD.getTime() + 1_000));
    writeFileSync(join(root, "2026", "10", "29", "transcript_2026-10-29_x.attempt-1.txt"), "bad attempt");
    writeFileSync(join(root, "review-log.tsv"),
      "2026-10-29T10:00:00\tretranscribe\t2026/10/29/transcript_2026-10-29_x.txt\t2026/10/29/x.mp4\thallucination\n");
    const base = settings();
    await worker({ settings: { ...base, retry: { ...base.retry, modelPath: join(tmp, "models", "absent.bin") } } }).pass();
    expect(notifier.failed).toHaveBeenCalledWith("x.mp4", "MODEL_UNAVAILABLE", "2026/10/29/x.mp4");
    expect(existsSync(join(root, "2026", "10", "29", "transcript_2026-10-29_y.txt"))).toBe(true);
  });

  it("reports long digital silence in status and the ready notification", async () => {
    media(OBS);
    fake.silence = ["[silencedetect @ 0x1] silence_start: 810.4", "[silencedetect @ 0x1] silence_end: 5670.2 | silence_duration: 4859.8"];
    let during: RecordingStatus | undefined;
    fake.whisper = async () => {
      await waitFor(async () => (await readStatus(statusPath()))?.current?.silences !== undefined);
      during = await status();
      return "лекція\n";
    };
    await worker().pass();
    // The fake ffprobe reports 12.5 s, so the span counts as lasting to the end.
    const spans = [{ startSeconds: 810, durationSeconds: 4860, toEnd: true }];
    expect(during?.current?.silences).toEqual(spans);
    expect((await status()).recent[0]?.silences).toEqual(spans);
    expect(notifier.ready).toHaveBeenCalledExactlyOnceWith(OBS, `2026/10/29/${OBS}`, "no audio signal from 13:30 to the end (81 min)");
    expect(diagnostics.record).toHaveBeenCalledWith("RECORDING_SILENCE_FOUND", { count: 1, seconds: 4860 });
  });

  it("still publishes the transcript when the silence check fails", async () => {
    media(OBS);
    const runner = fake.runner;
    fake.runner = async (executable, args, options) => {
      if (args.some((arg) => arg.startsWith("silencedetect="))) throw new MediaError("MEDIA_AUDIO_FAILED");
      return runner(executable, args, options);
    };
    await worker({ runner: fake.runner }).pass();
    expect(existsSync(join(root, "2026", "10", "29", `${OBS_KEY}.txt`))).toBe(true);
    expect(codes()).toContain("RECORDING_SILENCE_CHECK_FAILED");
    expect((await status()).recent[0]).not.toHaveProperty("silences");
  });

  it("ignores hidden files, non-media, non-day folders and symlinks", async () => {
    const outside = join(tmp, "outside.mp4");
    writeFileSync(outside, "o");
    utimesSync(outside, OLD, OLD);
    const paths = [media(".hidden.mp4"), media("notes.txt"), media("misc/a.mp4"), media("2026/10/x.mp4"),
      media("2026/10/29/.h.mp4"), media("2026/10/29/readme.md"), media("2026/1/02/y.mp4")];
    symlinkSync(outside, join(root, "link.mp4"));
    symlinkSync(outside, join(root, "2026", "10", "29", "link.mp4"));
    await worker().pass();
    expect(fake.calls).toEqual([]);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(root, "2026", "10", "29")).sort()).toEqual([".h.mp4", "link.mp4", "readme.md"]);
    expect((await status()).waiting).toEqual([]);
  });

  it("transcribes oldest first: day folders in date order, then by mtime", async () => {
    media("2026/10/29/a.mp4", "a", new Date(clock - 9_000_000));
    media("2026/10/28/b.mp4", "b", new Date(clock - 3_600_000));
    media("2026/10/28/c.mp4", "c", new Date(clock - 7_200_000));
    media("2025/12/31/d.mp4", "d", new Date(clock - 3_600_000));
    await worker().pass();
    expect(fake.inputs.map((path) => path.slice(root.length + 1))).toEqual(
      ["2025/12/31/d.mp4", "2026/10/28/c.mp4", "2026/10/28/b.mp4", "2026/10/29/a.mp4"]);
  });

  it("marks a whisper failure once, does not retry the unchanged file, and retries after it changes", async () => {
    const recording = media("2026/10/29/a.mp4");
    const day = dirname(recording);
    fake.whisper = async () => { throw new MediaError("MEDIA_AUDIO_FAILED"); };
    const w = worker();
    await w.pass();
    expect(readdirSync(day)).toEqual(["a.mp4"]);
    expect(readdirSync(workRoot())).toEqual([]);
    expect((await status()).failed).toEqual([{ file: "2026/10/29/a.mp4", code: "ASR_FAILED", at: expect.any(String) }]);
    expect(diagnostics.record).toHaveBeenCalledWith("RECORDING_FAILED", { reason: "ASR_FAILED" });
    expect(notifier.failed).toHaveBeenCalledExactlyOnceWith("a.mp4", "ASR_FAILED", expect.stringMatching(/^\d{4}\/\d{2}\/\d{2}\/a\.mp4$/));
    expect(notifier.ready).not.toHaveBeenCalled();

    await w.pass();
    expect(executables().filter((name) => name === "whisper-cli")).toHaveLength(1);
    expect(notifier.failed).toHaveBeenCalledTimes(1);
    expect((await status()).failed).toHaveLength(1);

    fake.whisper = async () => "вдалося\n";
    const newer = new Date(OLD.getTime() + 1_000);
    utimesSync(recording, newer, newer);
    await w.pass();
    expect(executables().filter((name) => name === "whisper-cli")).toHaveLength(2);
    expect(readFileSync(join(day, "transcript_2026-10-29_a.txt"), "utf8")).toBe("вдалося\n");
  });

  it("clears the failed entry once the changed file transcribes successfully", async () => {
    const recording = media("2026/10/29/a.mp4");
    fake.whisper = async () => { throw new MediaError("MEDIA_AUDIO_FAILED"); };
    const w = worker();
    await w.pass();
    fake.whisper = async () => "ok\n";
    writeFileSync(recording, "data, re-exported");
    utimesSync(recording, OLD, OLD);
    await w.pass();
    expect(existsSync(join(dirname(recording), "transcript_2026-10-29_a.txt"))).toBe(true);
    expect((await status()).failed).toEqual([]);
  });

  it("writes a no-speech marker when whisper hears only tags", async () => {
    media("2026/10/29/a.mp4");
    fake.whisper = async () => "[музика]\n(Music)\n*аплодисменти*\n[музика]\n";
    await worker().pass();
    expect(readFileSync(join(root, "2026/10/29/transcript_2026-10-29_a.txt"), "utf8")).toBe("[no speech detected]\n");
  });

  it("fails with TARGET_EXISTS when the transcript appears during transcription, leaving it untouched", async () => {
    const recording = media("2026/10/29/a.mp4");
    const day = dirname(recording);
    const target = join(day, "transcript_2026-10-29_a.txt");
    fake.whisper = async () => { writeFileSync(target, "manual"); return "machine\n"; };
    await worker().pass();
    expect(readFileSync(target, "utf8")).toBe("manual");
    expect(partials(day)).toEqual([]);
    expect((await status()).failed).toEqual([{ file: "2026/10/29/a.mp4", code: "TARGET_EXISTS", at: expect.any(String) }]);
    expect(notifier.failed).toHaveBeenCalledExactlyOnceWith("a.mp4", "TARGET_EXISTS", expect.stringMatching(/^\d{4}\/\d{2}\/\d{2}\/a\.mp4$/));
  });

  it("fails with MODEL_UNAVAILABLE without decoding when the model is invalid", async () => {
    writeFileSync(join(tmp, "models", "model.bin"), "not a model");
    media("2026/10/29/a.mp4");
    await worker().pass();
    expect(executables()).not.toContain("ffmpeg");
    expect(executables()).not.toContain("whisper-cli");
    expect((await status()).failed).toEqual([{ file: "2026/10/29/a.mp4", code: "MODEL_UNAVAILABLE", at: expect.any(String) }]);
  });

  it("notifies through osascript when no notifier is injected", async () => {
    media("2026/10/29/a.mp4");
    await createRecordingWorker({ settings: settings({ notifications: true }), runtimeDataPath: runtime, diagnostics,
      runner: fake.runner, now: () => clock, legacy: { plist: legacyPlist(), lock: legacyLock() } }).pass();
    const osascript = fake.calls.filter((call) => basename(call.executable) === "osascript");
    expect(osascript).toHaveLength(1);
    expect(osascript[0]!.args.slice(-2)).toEqual(["Transcription ready", "a.mp4"]);
  });

  it("pass() works as a one-shot run without start()", async () => {
    rmSync(join(runtime, "recordings"), { recursive: true, force: true });
    media("2026/10/29/a.mp4");
    await worker().pass();
    expect(existsSync(join(root, "2026/10/29/transcript_2026-10-29_a.txt"))).toBe(true);
  });
});

describe("recording worker: lifecycle", () => {
  it("stop() interrupts whisper without leaving a transcript or partial", async () => {
    const recording = media("2026/10/29/a.mp4");
    const started = deferred();
    fake.whisper = ({ options }) => new Promise((_, reject) => {
      started.resolve();
      options.signal.addEventListener("abort", () => reject(new MediaError("MEDIA_ABORTED")), { once: true });
    });
    const w = worker();
    await w.start();
    await started.promise;
    await w.stop();
    const day = dirname(recording);
    expect(readdirSync(day)).toEqual(["a.mp4"]);
    expect(readdirSync(workRoot())).toEqual([]);
    expect(codes()).toContain("RECORDING_INTERRUPTED");
    expect(codes()).not.toContain("RECORDINGS_PASS_FAILED");
    expect(codes()).not.toContain("RECORDING_FAILED");
    expect(notifier.failed).not.toHaveBeenCalled();
    const final = await status();
    expect(final.current).toBeNull();
    expect(final.failed).toEqual([]);
  });

  it("start() cleans stale partials and work dirs, then picks up recordings that arrived while stopped", async () => {
    const day = join(root, "2026", "10", "29");
    mkdirSync(day, { recursive: true });
    const stalePartial = join(day, `.densemble-${randomUUID()}.partial`);
    writeFileSync(stalePartial, "half");
    const foreign = join(day, ".densemble-notes.partial");
    writeFileSync(foreign, "not ours");
    const staleWork = join(workRoot(), randomUUID());
    mkdirSync(staleWork);
    writeFileSync(join(staleWork, "audio.wav"), "old");
    media(OBS);
    const w = worker();
    await w.start();
    try {
      await waitFor(() => existsSync(join(day, `${OBS_KEY}.txt`)));
    } finally {
      await w.stop();
    }
    expect(existsSync(stalePartial)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(staleWork)).toBe(false);
    expect(fake.inputs).toEqual([join(day, OBS)]);
    expect(codes()).toContain("RECORDINGS_STARTED");
    expect(codes()).not.toContain("RECORDINGS_LEGACY_JOB_INSTALLED");
  });
});

describe("recording worker: voice first", () => {
  it("pauses whisper while a voice message is recognised and resumes after", async () => {
    media("2026/10/29/a.mp4");
    const gate = new SpeechGate();
    const control = { pause: vi.fn(), resume: vi.fn(), paused: false, pid: undefined } satisfies ProcessControl;
    const started = deferred();
    const finish = deferred();
    let whisperSignal: AbortSignal | undefined;
    fake.whisper = async ({ options }) => {
      whisperSignal = options.signal;
      options.onSpawn?.(control);
      started.resolve();
      await finish.promise;
      return "готово\n";
    };
    const running = worker({ gate }).pass();
    await started.promise;

    const release = gate.enterVoice();
    expect(control.pause).toHaveBeenCalledTimes(1);
    await waitFor(async () => (await readStatus(statusPath()))?.current?.paused === true);
    expect(codes()).toContain("RECORDING_PAUSED");

    // A voice /stop aborts its own controller only.
    new AbortController().abort();
    expect(whisperSignal?.aborted).toBe(false);

    release();
    expect(control.resume).toHaveBeenCalledTimes(1);
    await waitFor(async () => (await readStatus(statusPath()))?.current?.paused === false);
    expect(codes()).toContain("RECORDING_RESUMED");

    finish.resolve();
    await running;
    expect(readFileSync(join(root, "2026/10/29/transcript_2026-10-29_a.txt"), "utf8")).toBe("готово\n");
    // Unregistered after the job: later voice messages do not touch the finished process.
    gate.enterVoice()();
    expect(control.pause).toHaveBeenCalledTimes(1);
  });

  it("waits for an idle gate before starting a job", async () => {
    media("2026/10/29/a.mp4");
    const gate = new SpeechGate();
    const release = gate.enterVoice();
    const running = worker({ gate }).pass();
    await waitFor(() => executables().includes("ffprobe"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(executables()).not.toContain("ffmpeg");
    expect(executables()).not.toContain("whisper-cli");
    release();
    await running;
    expect(executables()).toContain("whisper-cli");
    expect(existsSync(join(root, "2026/10/29/transcript_2026-10-29_a.txt"))).toBe(true);
  });
});

describe("recording worker: legacy launchd job", () => {
  it("skips transcription and leaves a foreign lock alone", async () => {
    writeFileSync(legacyPlist(), "<plist/>");
    mkdirSync(legacyLock());
    media("2026/10/29/a.mp4");
    await worker().pass();
    expect(executables()).not.toContain("whisper-cli");
    expect(codes()).toContain("RECORDINGS_LEGACY_LOCK_BUSY");
    expect(statSync(legacyLock()).isDirectory()).toBe(true);
    expect(existsSync(join(root, "2026/10/29/transcript_2026-10-29_a.txt"))).toBe(false);
  });

  it("holds the shared lock while transcribing and removes it afterwards", async () => {
    writeFileSync(legacyPlist(), "<plist/>");
    media("2026/10/29/a.mp4");
    let held: boolean | undefined;
    fake.whisper = async () => { held = existsSync(legacyLock()); return "x\n"; };
    await worker().pass();
    expect(held).toBe(true);
    expect(existsSync(legacyLock())).toBe(false);
  });

  it("releases the lock after a failed job too", async () => {
    writeFileSync(legacyPlist(), "<plist/>");
    media("2026/10/29/a.mp4");
    fake.whisper = async () => { throw new MediaError("MEDIA_AUDIO_FAILED"); };
    await worker().pass();
    expect(existsSync(legacyLock())).toBe(false);
  });

  it("creates no lock when the legacy job is not installed", async () => {
    media("2026/10/29/a.mp4");
    let held: boolean | undefined;
    fake.whisper = async () => { held = existsSync(legacyLock()); return "x\n"; };
    await worker().pass();
    expect(held).toBe(false);
    expect(existsSync(legacyLock())).toBe(false);
  });

  it("start() reports an installed legacy job", async () => {
    writeFileSync(legacyPlist(), "<plist/>");
    const w = worker();
    await w.start();
    await w.stop();
    expect(codes()).toContain("RECORDINGS_LEGACY_JOB_INSTALLED");
  });
});

describe("legacy helpers", () => {
  it("detects the plist", async () => {
    expect(await legacyJobInstalled(join(tmp, "missing.plist"))).toBe(false);
    writeFileSync(legacyPlist(), "<plist/>");
    expect(await legacyJobInstalled(legacyPlist())).toBe(true);
  });

  it("acquires once, refuses while held, releases idempotently", async () => {
    const release = await acquireLegacyLock(legacyLock());
    expect(release).toBeDefined();
    expect(statSync(legacyLock()).mode & 0o777).toBe(0o700);
    expect(await acquireLegacyLock(legacyLock())).toBeUndefined();
    await release!();
    expect(existsSync(legacyLock())).toBe(false);
    mkdirSync(legacyLock());
    await release!();
    expect(existsSync(legacyLock())).toBe(true);
  });

  it("propagates errors other than EEXIST", async () => {
    await expect(acquireLegacyLock(join(tmp, "missing", "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("createNotifier", () => {
  function setup(enabled = true, fail = false) {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (fail) throw new MediaError("MEDIA_AUDIO_FAILED");
      return { stdout: "", stderr: "" };
    };
    const notify = createNotifier({ runner, enabled, diagnostics, signal: new AbortController().signal });
    return { calls, notify };
  }

  it("passes title and body as argv, never interpolated into the script", async () => {
    const { calls, notify } = setup();
    await notify.ready("a \"b\" & c.mp4");
    await notify.failed("a \"b\" & c.mp4", "ASR_FAILED");
    expect(calls).toEqual([
      ["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run", "Transcription ready", "a \"b\" & c.mp4"],
      ["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run", "Transcription failed", "a \"b\" & c.mp4 — ASR_FAILED"],
    ]);
  });

  it("notifies once per outcome per file", async () => {
    const { calls, notify } = setup();
    await notify.ready("a.mp4");
    await notify.ready("a.mp4");
    await notify.ready("b.mp4");
    await notify.failed("a.mp4", "ASR_FAILED");
    await notify.failed("a.mp4", "TIMEOUT");
    expect(calls.map((call) => call.at(-1))).toEqual(["a.mp4", "b.mp4", "a.mp4 — ASR_FAILED"]);
  });

  it("does nothing when disabled", async () => {
    const { calls, notify } = setup(false);
    await notify.ready("a.mp4");
    await notify.failed("a.mp4", "ASR_FAILED");
    expect(calls).toEqual([]);
  });

  it("records a diagnostic and never throws when osascript fails", async () => {
    const { calls, notify } = setup(true, true);
    await expect(notify.ready("a.mp4")).resolves.toBeUndefined();
    await expect(notify.failed("a.mp4", "ASR_FAILED")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(diagnostics.record.mock.calls).toEqual([["RECORDING_NOTIFY_FAILED"], ["RECORDING_NOTIFY_FAILED"]]);
  });

  it("notifies separately for same-named recordings in different day folders", async () => {
    media("2026/10/28/meeting.m4a");
    media("2026/10/29/meeting.m4a");
    await createRecordingWorker({ settings: settings({ notifications: true }), runtimeDataPath: runtime, diagnostics,
      runner: fake.runner, now: () => clock, legacy: { plist: legacyPlist(), lock: legacyLock() } }).pass();
    expect(fake.calls.filter((call) => basename(call.executable) === "osascript")).toHaveLength(2);
  });
});

describe("recording worker: resilience (review fixes)", () => {
  it("skips an unreadable day folder and keeps transcribing the others", async () => {
    media("2026/10/28/a.mp4");
    media("2026/10/29/b.mp4");
    const { chmodSync } = await import("node:fs");
    chmodSync(join(root, "2026/10/28"), 0o000);
    const instance = worker();
    try {
      await instance.start();
      await waitFor(() => existsSync(join(root, "2026/10/29/transcript_2026-10-29_b.txt")));
      expect(codes()).toContain("RECORDINGS_FOLDER_UNREADABLE");
    } finally {
      await instance.stop();
      chmodSync(join(root, "2026/10/28"), 0o755);
    }
  });
  it("files and queues a recording that finished while another one was transcribed, oldest first", async () => {
    media("2026/10/29/b.mp4");
    let calls = 0;
    fake.whisper = async () => {
      if (calls++ === 0) media("2026-10-28 08-00-00.mp4");
      return "текст\n";
    };
    await worker().pass();
    expect(existsSync(join(root, "2026/10/28/2026-10-28 08-00-00.mp4"))).toBe(true);
    expect(existsSync(join(root, "2026/10/28/transcript_2026-10-28_2026-10-28_08-00-00.txt"))).toBe(true);
    expect(calls).toBe(2);
  });
  it("reports a symlinked year folder as an unsafe target and never moves the recording out", async () => {
    mkdirSync(join(tmp, "outside"));
    symlinkSync(join(tmp, "outside"), join(root, "2026"));
    media(OBS);
    await worker().pass();
    expect(existsSync(join(root, OBS))).toBe(true);
    expect(readdirSync(join(tmp, "outside"))).toEqual([]);
    expect((await status()).conflicts).toContainEqual({ file: OBS, reason: "TARGET_UNSAFE" });
  });
  it("never removes a legacy lock that replaced its own", async () => {
    const release = (await acquireLegacyLock(legacyLock()))!;
    rmSync(legacyLock(), { recursive: true });
    mkdirSync(legacyLock());
    await release();
    expect(existsSync(legacyLock())).toBe(true);
  });
  it("keeps the status lists free of duplicates while the legacy lock is busy", async () => {
    writeFileSync(legacyPlist(), "<plist/>");
    mkdirSync(legacyLock());
    media("2026/10/29/a.mp4");
    media("2026/10/29/a.m4a", "data", new Date(OLD.getTime() + 1000));
    const instance = worker();
    await instance.pass();
    await instance.pass();
    expect((await status()).conflicts).toHaveLength(1);
  });
});
