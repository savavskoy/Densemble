import { spawn } from "node:child_process";
import { checkAbort, MediaError } from "./errors.js";

export interface ProcessOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  cwd?: string;
}
export interface ProcessResult { stdout: string; stderr: string }
export type ProcessRunner = (executable: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

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
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new MediaError("MEDIA_AUDIO_FAILED");
      }
    };
    const stop = (error: MediaError) => {
      failure ??= error;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 300);
    };
    const abort = () => stop(new MediaError("MEDIA_ABORTED"));
    const timeout = setTimeout(() => stop(new MediaError("MEDIA_TIMEOUT")), options.timeoutMs);
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      // Even a successful leader may have left descendants with closed stdio.
      kill("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaError("MEDIA_AUDIO_FAILED"));
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const consume = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 64_000)) stop(new MediaError("MEDIA_AUDIO_FAILED"));
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
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
