import { Worker } from "node:worker_threads";
import type { IncomingAttachment } from "../domain.js";
import { checkAbort, MediaError, type MediaErrorCode, mediaMessages } from "./errors.js";
import { MEDIA_LIMITS } from "./limits.js";

export interface Extraction {
  kind: "text" | "image" | "audio";
  mimeType: string;
  text?: string;
}
export interface ExtractionOptions {
  timeoutMs?: number;
  maxCharacters?: number;
}

export async function extractFile(path: string, attachment: IncomingAttachment, signal: AbortSignal,
  options: ExtractionOptions = {}): Promise<Extraction> {
  checkAbort(signal);
  const execArgv = process.execArgv.filter((arg, index, args) =>
    !arg.startsWith("--input-type=") && arg !== "--input-type" && args[index - 1] !== "--input-type");
  const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./extract-worker.ts" : "./extract-worker.js", import.meta.url), {
    execArgv,
    workerData: { path, attachment, limits: { ...MEDIA_LIMITS,
      textCharacters: Math.min(options.maxCharacters ?? MEDIA_LIMITS.textCharacters, MEDIA_LIMITS.textCharacters) } },
    resourceLimits: { maxOldGenerationSizeMb: MEDIA_LIMITS.workerMemoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise<Extraction>((resolve, reject) => {
    let done = false;
    const finish = (error?: MediaError, result?: Extraction) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate().then(() => error ? reject(error) : resolve(result!));
    };
    const abort = () => finish(new MediaError("MEDIA_ABORTED"));
    const timer = setTimeout(() => finish(new MediaError("MEDIA_TIMEOUT")),
      Math.min(options.timeoutMs ?? MEDIA_LIMITS.extractionTimeoutMs, MEDIA_LIMITS.extractionTimeoutMs));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("error", () => finish(new MediaError("MEDIA_CORRUPT")));
    worker.once("exit", () => { if (!done) finish(new MediaError("MEDIA_CORRUPT")); });
    worker.once("message", (message: { result?: Extraction; error?: string }) => {
      if (message.error) finish(new MediaError(Object.hasOwn(mediaMessages, message.error) ?
        message.error as MediaErrorCode : "MEDIA_CORRUPT"));
      else if (message.result) finish(undefined, message.result);
      else finish(new MediaError("MEDIA_CORRUPT"));
    });
    if (signal.aborted) abort();
  });
}
