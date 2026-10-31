import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MediaError, runManagedProcess, SpeechGate, type ProcessControl, type ProcessRunner, type DiagnosticSink } from "../core-api.js";
import { classify, dayFolder, isMediaName, parseDayFolder, parseReviewLog, PARTIAL_PATTERN, rootTargetDate,
  transcriptKey, type DayMedia } from "./contract.js";
import { fileRecording, isFinished, repairInterruptedFiling, type FinishedCheckOptions } from "./filing.js";
import { acquireLegacyLock, legacyJobInstalled } from "./legacy.js";
import { createNotifier, type RecordingNotifier } from "./notify.js";
import type { RecordingSettings } from "./settings.js";
import { describeSilences, type SilenceSpan } from "./silence.js";
import { estimateSeconds, RECENT_LIMIT, writeStatus, type RecordingStatus } from "./status.js";
import { RecordingError, transcribeRecording, type RecordingFailure } from "./transcribe.js";

export interface RecordingWorkerOptions {
  settings: RecordingSettings;
  /** Private data directory (`runtimeDataPath/modules/recordings`): status, work files, the active process. */
  dataPath: string;
  diagnostics: DiagnosticSink;
  gate?: SpeechGate;
  runner?: ProcessRunner;
  now?: () => number;
  notifier?: RecordingNotifier;
  legacy?: { plist?: string; lock?: string };
  /** Module health: a pass that cannot read the watched folder fails it; the next good pass recovers it. */
  health?: { fail(code: string): void; recovered(): void };
}
export interface RecordingWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One scan-and-transcribe pass; exposed for tests and one-shot runs. */
  pass(): Promise<void>;
  /** The current status snapshot (what `status.json` holds). */
  snapshot(): RecordingStatus;
}

interface Job { path: string; dayRel: string; file: string; mtimeMs: number; mode: "first" | "retry" }

const DAY_PART = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

/** Watches one folder: files finished root recordings into YYYY/MM/DD and transcribes them one at a time, oldest first. */
export function createRecordingWorker(options: RecordingWorkerOptions): RecordingWorker {
  const { settings, diagnostics } = options;
  const root = settings.path;
  const runner = options.runner ?? runManagedProcess;
  const now = options.now ?? Date.now;
  const gate = options.gate ?? new SpeechGate();
  const controller = new AbortController();
  const signal = controller.signal;
  const notifier = options.notifier ?? createNotifier({ runner, enabled: settings.notifications, diagnostics, signal });
  const base = options.dataPath;
  const workRoot = join(base, "work");
  const statusPath = join(base, "status.json");
  // The running FFmpeg/whisper group, so a restart after a crash can end an orphan instead of running twice.
  const activePath = join(base, "active-process.json");
  // Remembered until restart so a broken file is not retried in a loop (keyed by path, size and mtime).
  const failures = new Map<string, { file: string; code: RecordingFailure; at: string }>();
  const status: RecordingStatus = { version: 1, updatedAt: new Date(now()).toISOString(), enabled: true,
    pollIntervalMs: settings.pollIntervalMs, current: null, queue: [], waiting: [], conflicts: [], failed: [], recent: [] };
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let legacyWarned = false;
  let writing = Promise.resolve();
  const check: FinishedCheckOptions = { runner, ffprobePath: settings.ffprobePath, quietMs: settings.quietMinutes * 60_000, now, signal };
  const rel = (path: string) => path.slice(root.length + 1);

  const snapshot = (): RecordingStatus => {
    status.failed = [...failures.values()];
    return structuredClone(status);
  };
  const publishStatus = () => {
    status.updatedAt = new Date(now()).toISOString();
    const current = snapshot();
    writing = writing.then(() => writeStatus(statusPath, current)).catch(() => { diagnostics.record("RECORDINGS_STATUS_FAILED"); });
    return writing;
  };

  async function cleanup(): Promise<void> {
    await mkdir(base, { recursive: true, mode: 0o700 });
    await endOrphan();
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(workRoot, { mode: 0o700 });
    for (const day of await dayFolders()) {
      for (const entry of await readdir(join(root, day)).catch(() => [] as string[])) {
        if (PARTIAL_PATTERN.test(entry)) await unlink(join(root, day, entry)).catch(() => undefined);
      }
    }
  }

  /** Ends a recording process group left by a crashed run, only if its leader is still one of our tools. */
  async function endOrphan(): Promise<void> {
    let pid: number;
    try { pid = Number((JSON.parse(await readFile(activePath, "utf8")) as { pid?: unknown }).pid); }
    catch { return; }
    await unlink(activePath).catch(() => undefined);
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    try {
      const { stdout } = await runner("/bin/ps", ["-o", "pgid=,comm=", "-p", String(pid)], { signal, timeoutMs: 5_000, maxOutputBytes: 4_000 });
      const [group, command] = stdout.trim().split(/\s+/, 2);
      const tools = [settings.whisperPath, settings.ffmpegPath].map((tool) => tool.split("/").at(-1));
      if (Number(group) !== pid || !tools.includes(command?.split("/").at(-1))) return;
      process.kill(-pid, "SIGCONT");
      process.kill(-pid, "SIGKILL");
      diagnostics.record("RECORDING_ORPHAN_ENDED");
    } catch { /* Gone already. */ }
  }

  /** The watched folder itself; failing to read it is a module health failure, not a per-file one. */
  async function readRoot() {
    try { return await readdir(root, { withFileTypes: true }); }
    catch (error) {
      options.health?.fail("RECORDINGS_FOLDER_UNREADABLE");
      throw error;
    }
  }

  /** Day folders that can be read; an unreadable one is skipped, never fatal for the others. */
  async function dayFolders(): Promise<string[]> {
    let levels = [""];
    for (const pattern of DAY_PART) {
      const next: string[] = [];
      for (const level of levels) {
        let entries;
        try { entries = level ? await readdir(join(root, level), { withFileTypes: true }) : await readRoot(); }
        catch (error) {
          if (!level) throw error;
          diagnostics.record("RECORDINGS_FOLDER_UNREADABLE");
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && pattern.test(entry.name)) next.push(level ? `${level}/${entry.name}` : entry.name);
        }
      }
      levels = next;
    }
    return levels.filter((day) => parseDayFolder(day) !== undefined).sort();
  }

  /** A day path must not leave the folder through a symlinked or non-directory YYYY/MM/DD component. */
  async function safeDayPath(dayRel: string): Promise<boolean> {
    let cursor = root;
    for (const part of dayRel.split("/")) {
      cursor = join(cursor, part);
      try { if (!(await lstat(cursor)).isDirectory()) return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }
    return true;
  }

  /** While the legacy job is installed, filing and each transcription hold its lock so the two never overlap. */
  async function withLegacyLock(action: () => Promise<void>): Promise<void> {
    if (!await legacyJobInstalled(options.legacy?.plist)) return action();
    const release = await acquireLegacyLock(options.legacy?.lock);
    if (!release) {
      diagnostics.record("RECORDINGS_LEGACY_LOCK_BUSY");
      return;
    }
    try { await action(); } finally { await release(); }
  }

  async function fileRoot(): Promise<void> {
    const waiting = status.waiting;
    const conflicts = status.conflicts;
    for (const entry of await readRoot()) {
      if (!entry.isFile() || !isMediaName(entry.name)) continue;
      const source = join(root, entry.name);
      let stats;
      try { stats = await lstat(source); } catch { continue; }
      const dayRel = dayFolder(rootTargetDate(entry.name, stats.mtimeMs));
      const day = join(root, dayRel);
      if (!await safeDayPath(dayRel)) {
        conflicts.push({ file: entry.name, reason: "TARGET_UNSAFE" });
        diagnostics.record("RECORDING_CONFLICT", { reason: "TARGET_UNSAFE" });
        continue;
      }
      if (await repairInterruptedFiling(source, join(day, entry.name))) continue;
      if (!(await isFinished(source, check)).finished) {
        waiting.push(entry.name);
        continue;
      }
      let result;
      try { result = await fileRecording(source, day); }
      catch (error) {
        // Moved or removed by someone else between the checks and the link.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (result === "conflict") {
        conflicts.push({ file: entry.name, reason: "TARGET_EXISTS" });
        diagnostics.record("RECORDING_CONFLICT", { reason: "TARGET_EXISTS" });
      } else {
        diagnostics.record("RECORDING_FILED");
      }
    }
    if (waiting.length) diagnostics.record("RECORDING_WAITING", { count: waiting.length });
  }

  async function findJobs(): Promise<{ jobs: Job[]; conflicts: RecordingStatus["conflicts"] }> {
    let log = parseReviewLog("");
    try { log = parseReviewLog(await readFile(join(root, "review-log.tsv"), "utf8")); } catch { /* No review yet. */ }
    const jobs: Job[] = [];
    const conflicts: RecordingStatus["conflicts"] = [];
    for (const dayRel of await dayFolders()) {
      const directory = join(root, dayRel);
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { diagnostics.record("RECORDINGS_FOLDER_UNREADABLE"); continue; }
      const media: DayMedia[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !isMediaName(entry.name)) continue;
        try { media.push({ name: entry.name, mtimeMs: (await lstat(join(directory, entry.name))).mtimeMs }); } catch { /* Gone. */ }
      }
      for (const item of media) {
        const result = classify({ dayRel, file: item.name, media, entries: entries.map((entry) => entry.name), log });
        if (result.kind === "conflict") conflicts.push({ file: `${dayRel}/${item.name}`, reason: result.reason });
        else if (result.kind !== "done") {
          jobs.push({ path: join(directory, item.name), dayRel, file: item.name, mtimeMs: item.mtimeMs, mode: result.kind === "retry" ? "retry" : "first" });
        }
      }
    }
    jobs.sort((a, b) => a.dayRel.localeCompare(b.dayRel) || a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
    return { jobs, conflicts };
  }

  /** Re-checks the job just before starting: review may have run since the scan. */
  async function stillPending(job: Job): Promise<boolean> {
    const [pending] = (await findJobs()).jobs.filter((candidate) => candidate.path === job.path);
    if (pending) job.mode = pending.mode;
    return pending !== undefined;
  }

  async function transcribe(job: Job): Promise<void> {
    const stats = await lstat(job.path).catch(() => undefined);
    if (!stats) return;
    const failureKey = `${job.path}\0${stats.size}\0${stats.mtimeMs}`;
    if (failures.has(failureKey)) return;
    const finished = await isFinished(job.path, check);
    if (!finished.finished) {
      status.waiting.push(`${job.dayRel}/${job.file}`);
      return;
    }
    await gate.waitUntilIdle(signal);
    await withLegacyLock(async () => {
      if (await stillPending(job)) await run(job, failureKey, finished.durationSeconds!);
    });
  }

  async function run(job: Job, failureKey: string, durationSeconds: number): Promise<void> {
    const file = `${job.dayRel}/${job.file}`;
    status.queue = status.queue.filter((item) => item !== file);
    let runningSince = now();
    let runningMs = 0;
    for (const [key, failure] of failures) if (failure.file === file) failures.delete(key);
    // Voice may have started after waitUntilIdle(); the gate then pauses the process as soon as it registers.
    const current: NonNullable<RecordingStatus["current"]> = { file, mode: job.mode, startedAt: new Date(runningSince).toISOString(),
      percent: 0, etaSeconds: null, paused: gate.voiceActive };
    status.current = current;
    const unsubscribe = gate.subscribe((voice) => {
      if (voice && !current.paused) {
        runningMs += now() - runningSince;
        current.paused = true;
        diagnostics.record("RECORDING_PAUSED");
      } else if (!voice && current.paused) {
        runningSince = now();
        current.paused = false;
        diagnostics.record("RECORDING_RESUMED");
      }
      void publishStatus();
    });
    let unregister: (() => void) | undefined;
    diagnostics.record("RECORDING_STARTED", { attempt: job.mode === "retry" ? 2 : 1 });
    await publishStatus();
    try {
      const date = parseDayFolder(job.dayRel)!;
      const { transcript, silences } = await transcribeRecording({
        recording: job.path, dayDirectory: join(root, job.dayRel), key: transcriptKey(date, job.file), durationSeconds, mode: job.mode,
      }, {
        settings, runner, workRoot, signal,
        onSpawn: (control: ProcessControl) => {
          unregister?.();
          unregister = gate.registerBackground(control);
          void writeFile(activePath, JSON.stringify({ pid: control.pid }), { mode: 0o600 }).catch(() => undefined);
        },
        onSilences: (spans: SilenceSpan[]) => {
          if (!spans.length) return;
          current.silences = spans;
          diagnostics.record("RECORDING_SILENCE_FOUND", { count: spans.length,
            seconds: spans.reduce((sum, span) => sum + span.durationSeconds, 0) });
          void publishStatus();
        },
        onProgress: (percent) => {
          if (percent === current.percent) return;
          current.percent = percent;
          current.etaSeconds = estimateSeconds(runningMs + (current.paused ? 0 : now() - runningSince), percent);
          void publishStatus();
        },
      });
      if (!silences) diagnostics.record("RECORDING_SILENCE_CHECK_FAILED");
      diagnostics.record("RECORDING_DONE");
      status.recent = [{ file, transcript: rel(transcript), at: new Date(now()).toISOString(),
        ...(silences?.length ? { silences } : {}) }, ...status.recent].slice(0, RECENT_LIMIT);
      await notifier.ready(job.file, file, describeSilences(silences ?? []));
    } catch (error) {
      if (error instanceof MediaError && error.code === "MEDIA_ABORTED") {
        diagnostics.record("RECORDING_INTERRUPTED");
        throw error;
      }
      const reason: RecordingFailure = error instanceof RecordingError ? error.reason : "ASR_FAILED";
      failures.set(failureKey, { file, code: reason, at: new Date(now()).toISOString() });
      diagnostics.record("RECORDING_FAILED", { reason });
      await notifier.failed(job.file, reason, file);
    } finally {
      unregister?.();
      unsubscribe();
      await unlink(activePath).catch(() => undefined);
      status.current = null;
      await publishStatus();
    }
  }

  /** A completed pass read the folder, so a folder failure is over. */
  async function pass(): Promise<void> {
    await scan();
    options.health?.recovered();
  }

  /** Rescans after every job, so recordings finished meanwhile are filed and queued in oldest-first order. */
  async function scan(): Promise<void> {
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const attempted = new Set<string>();
    for (let first = true; !signal.aborted; first = false) {
      status.waiting = [];
      status.conflicts = [];
      await withLegacyLock(fileRoot);
      const { jobs, conflicts } = await findJobs();
      if (first) for (const conflict of conflicts) diagnostics.record("RECORDING_CONFLICT", { reason: conflict.reason });
      status.conflicts.push(...conflicts);
      const pending = jobs.filter((job) => !attempted.has(job.path));
      status.queue = pending.map((job) => `${job.dayRel}/${job.file}`);
      await publishStatus();
      const job = pending[0];
      if (!job) return;
      attempted.add(job.path);
      await transcribe(job);
    }
  }

  const loop = () => {
    if (stopped) return;
    running = pass().catch((error: unknown) => {
      if (!(error instanceof MediaError && error.code === "MEDIA_ABORTED")) diagnostics.record("RECORDINGS_PASS_FAILED");
    }).finally(() => {
      running = undefined;
      if (!stopped) {
        timer = setTimeout(loop, settings.pollIntervalMs);
        timer.unref();
      }
    });
  };

  return {
    async start() {
      // An unreadable folder is reported and retried every poll; it never stops the service.
      try { await cleanup(); }
      catch { diagnostics.record("RECORDINGS_FOLDER_UNREADABLE"); }
      if (await legacyJobInstalled(options.legacy?.plist) && !legacyWarned) {
        legacyWarned = true;
        diagnostics.record("RECORDINGS_LEGACY_JOB_INSTALLED");
      }
      heartbeat = setInterval(() => { void publishStatus(); }, settings.pollIntervalMs);
      heartbeat.unref();
      diagnostics.record("RECORDINGS_STARTED");
      loop();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      controller.abort();
      await running;
      await writing;
    },
    pass,
    snapshot,
  };
}
