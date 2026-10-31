import type { ProcessRunner, DiagnosticSink } from "../core-api.js";

export interface RecordingNotifier {
  /** `id` (default: the file name) identifies the recording for once-per-outcome deduplication; `note` is appended. */
  ready(file: string, id?: string, note?: string): Promise<void>;
  failed(file: string, reason: string, id?: string): Promise<void>;
}

/** macOS notifications via osascript argv (no script interpolation); once per outcome per file per run. */
export function createNotifier(options: {
  runner: ProcessRunner; enabled: boolean; diagnostics: DiagnosticSink; signal: AbortSignal; osascriptPath?: string;
}): RecordingNotifier {
  const sent = new Set<string>();
  const notify = async (outcome: string, title: string, body: string, id: string) => {
    const key = `${outcome}\0${id}`;
    if (!options.enabled || sent.has(key)) return;
    sent.add(key);
    try {
      await options.runner(options.osascriptPath ?? "/usr/bin/osascript", ["-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body],
      { signal: options.signal, timeoutMs: 10_000, maxOutputBytes: 4_000 });
    } catch {
      options.diagnostics.record("RECORDING_NOTIFY_FAILED");
    }
  };
  return {
    ready: (file, id = file, note) => notify("ready", "Transcription ready", note ? `${file} — ${note}` : file, id),
    failed: (file, reason, id = file) => notify("failed", "Transcription failed", `${file} — ${reason}`, id),
  };
}
