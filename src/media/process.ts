import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { checkAbort, MediaError } from "./errors.js";

export interface ProcessControl { pause(): void; resume(): void; readonly paused: boolean; readonly pid: number | undefined }
export interface ProcessOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  cwd?: string;
  /** Streams stderr as lines instead of accumulating it; result.stderr is then empty and unbounded. */
  onStderrLine?: (line: string) => void;
  discardStdout?: boolean;
  onSpawn?: (control: ProcessControl) => void;
}
export interface ProcessResult { stdout: string; stderr: string }
export type ProcessRunner = (executable: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

const MAX_PARTIAL_LINE = 8192;

/** A private process group, never unref'ed, bounds the lifetime of owned descendants. */
export const runManagedProcess: ProcessRunner = async (executable, args, options) => {
  checkAbort(options.signal);
  return new Promise<ProcessResult>((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { shell: false, detached: grouped, stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}) });
    let failure: MediaError | undefined;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    let done = false;
    let paused = false;
    const send = (signal: NodeJS.Signals) => {
      if (!child.pid) return true;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!send(signal)) failure ??= new MediaError("MEDIA_AUDIO_FAILED");
      // A stopped group holds SIGTERM pending until it is continued.
      if (paused) send("SIGCONT");
    };
    const stop = (error: MediaError) => {
      failure ??= error;
      kill("SIGTERM");
      paused = false;
      killTimer ??= setTimeout(() => kill("SIGKILL"), 300);
    };
    const abort = () => stop(new MediaError("MEDIA_ABORTED"));
    let remainingMs = options.timeoutMs;
    let armedAt = 0;
    let timeout: NodeJS.Timeout | undefined;
    const arm = () => {
      armedAt = Date.now();
      timeout = setTimeout(() => stop(new MediaError("MEDIA_TIMEOUT")), Math.max(0, remainingMs));
    };
    arm();
    const control: ProcessControl = {
      pid: child.pid,
      pause() {
        if (done || failure || paused || !send("SIGSTOP")) return;
        paused = true;
        clearTimeout(timeout);
        remainingMs -= Date.now() - armedAt;
      },
      resume() {
        if (!paused) return;
        paused = false;
        send("SIGCONT");
        if (!done && !failure) arm();
      },
      get paused() { return paused; },
    };
    const decoder = new StringDecoder("utf8");
    let partial = "";
    const emit = (line: string) => {
      if (!line) return;
      try { options.onStderrLine?.(line); } catch { /* A progress observer never affects the process. */ }
    };
    const consumeLines = (text: string) => {
      const lines = (partial + text).split(/[\r\n]/);
      partial = lines.pop() ?? "";
      for (const line of lines) emit(line);
      while (partial.length > MAX_PARTIAL_LINE) { emit(partial.slice(0, MAX_PARTIAL_LINE)); partial = partial.slice(MAX_PARTIAL_LINE); }
    };
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      // Even a successful leader may have left descendants with closed stdio.
      kill("SIGKILL");
      paused = false;
      if (killTimer) clearTimeout(killTimer);
      if (options.onStderrLine) { emit(partial + decoder.end()); partial = ""; }
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaError("MEDIA_AUDIO_FAILED"));
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const consume = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 64_000)) stop(new MediaError("MEDIA_AUDIO_FAILED"));
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => { if (!options.discardStdout) consume(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => {
      if (options.onStderrLine) consumeLines(decoder.write(chunk));
      else consume(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = new MediaError(error.code === "ENOENT" || error.code === "EACCES" ?
        "MEDIA_AUDIO_TOOLS_MISSING" : "MEDIA_AUDIO_FAILED");
      finish(null);
    });
    child.once("exit", () => {
      // Promptly end descendants even if they inherited the pipes.
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 300);
    });
    child.once("close", finish);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    try { options.onSpawn?.(control); } catch { /* The caller's hook cannot leak the owned process. */ }
  });
};

export class SerialQueue {
  private running = false;
  private readonly waiters: Array<() => void> = [];

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    checkAbort(signal);
    await new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal.removeEventListener("abort", abort);
        this.running = true;
        resolve();
      };
      const abort = () => {
        const index = this.waiters.indexOf(enter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new MediaError("MEDIA_ABORTED"));
      };
      if (!this.running) enter();
      else {
        this.waiters.push(enter);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
    });
    try { checkAbort(signal); return await operation(); }
    finally {
      this.running = false;
      this.waiters.shift()?.();
    }
  }
}
