import { join } from "node:path";
import type { LoadedConfig } from "./config/index.js";
import { createApplication, type Application } from "./application/index.js";
import { createCopilotRuntime, type ControlledRuntime } from "./agents/index.js";
import { bounded } from "./agents/contracts.js";
import { createMediaPipeline } from "./media/index.js";
import type { MediaPipeline } from "./media/index.js";
import { createTelegramAdapter, type TelegramAdapter } from "./telegram/index.js";
import type { StateStore } from "./ports.js";
import { openStore } from "./storage/index.js";
import { acquireProcessLock } from "./storage/process-lock.js";
import { createDiagnostics } from "./operations/diagnostics.js";
import { audioSettings } from "./operations/audio-settings.js";

export async function startService(config: LoadedConfig, options: { shutdownTimeoutMs?: number } = {}): Promise<{ stop(): Promise<void> }> {
  const diagnostics = createDiagnostics({ botIds: config.config.bots.map((bot) => bot.id) });
  const lock = acquireProcessLock(config.config.runtimeDataPath);
  let closing: Promise<void> | undefined;
  let runtime: ControlledRuntime | undefined;
  let store: StateStore | undefined;
  let application: Application | undefined;
  let telegram: TelegramAdapter | undefined;
  let maintenance: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  function stop(): Promise<void> {
    return closing ??= (async () => {
      clearInterval(timer);
      const errors: unknown[] = [];
      let confirmed = true;
      try { await maintenance; } catch (error) { errors.push(error); confirmed = false; }
      try { await telegram?.stop(); } catch (error) { errors.push(error); confirmed = false; }
      try { await application?.shutdown(); } catch (error) { errors.push(error); }
      try { await runtime?.shutdown(); } catch (error) { errors.push(error); confirmed = false; }
      if (application) {
        try {
          await bounded(application.drain(), options.shutdownTimeoutMs ?? 35_000, "SERVICE_DRAIN_TIMEOUT");
        } catch (error) { errors.push(error); confirmed = false; }
      }
      if (confirmed) {
        try { store?.close(); } finally { lock.release(); }
      } else {
        diagnostics.record("SERVICE_OWNERSHIP_RETAINED");
      }
      if (errors.length) {
        diagnostics.record("SERVICE_SHUTDOWN_INCOMPLETE", { count: errors.length });
        throw new Error("SERVICE_SHUTDOWN_INCOMPLETE");
      }
      diagnostics.record("SERVICE_STOPPED");
    })();
  }
  try {
    runtime = createCopilotRuntime({ config, diagnostics });
    await runtime.recoverOwnedProcesses();
    store = openStore({ path: join(config.config.runtimeDataPath, "state.sqlite") });
    let media: MediaPipeline;
    telegram = createTelegramAdapter({
      config, store, diagnostics,
      resolveAttachment: (scope, id) => media.resolveAttachment(scope, id),
    });
    media = createMediaPipeline({
      config, store, diagnostics, download: telegram.downloadFile, audio: audioSettings(config.config),
    });
    const recovery = store.recover();
    await media.cleanup();
    application = createApplication({ config, store, runtime, media, delivery: telegram.transport, diagnostics });
    await application.start(recovery);
    await telegram.start(application);
    timer = setInterval(() => {
      if (closing || maintenance) return;
      maintenance = media.cleanup().catch(() => { diagnostics.record("MEDIA_RETENTION_FAILED"); })
        .finally(() => { maintenance = undefined; });
    }, 60_000);
    timer.unref();
    diagnostics.record("SERVICE_STARTED", { count: config.config.bots.length });
    return { stop };
  } catch (error) {
    try { await stop(); } catch { throw new Error("SERVICE_START_AND_CLEANUP_FAILED"); }
    throw error;
  }
}
