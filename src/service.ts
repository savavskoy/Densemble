import { join } from "node:path";
import type { LoadedConfig } from "./config/index.js";
import { defaultQuietHours, moduleEntries } from "./config/index.js";
import { createApplication, type Application } from "./application/index.js";
import { createClaudeRuntime, createCopilotRuntime, createEngineRouter, type ControlledRuntime } from "./agents/index.js";
import { bounded } from "./agents/contracts.js";
import { createMediaPipeline } from "./media/index.js";
import type { MediaPipeline } from "./media/index.js";
import { createTelegramAdapter, type TelegramAdapter } from "./telegram/index.js";
import type { StateStore } from "./ports.js";
import { createProactiveScheduler } from "./scheduling/scheduler.js";
import { openStore } from "./storage/index.js";
import { acquireProcessLock } from "./storage/process-lock.js";
import { createDiagnostics } from "./operations/diagnostics.js";
import { audioSettings } from "./operations/audio-settings.js";
import { SpeechGate } from "./media/speech-gate.js";
import { createModuleHost, type ModuleHost } from "./modules/host.js";
import { createCoreOffer } from "./modules/offer.js";
import { startModulesStateWriter } from "./modules/state.js";
import { startModuleNotices } from "./modules/notices.js";

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
  let scheduler: { start(): void; stop(): void } | undefined;
  let modules: ModuleHost | undefined;
  let moduleState: { stop(): Promise<void> } | undefined;
  let notices: { stop(): Promise<void> } | undefined;
  function stop(): Promise<void> {
    return closing ??= (async () => {
      scheduler?.stop();
      clearInterval(timer);
      const errors: unknown[] = [];
      // Observers first, so no notice is queued and no fresh snapshot is written while everything stops.
      try { await notices?.stop(); } catch (error) { errors.push(error); }
      try { await moduleState?.stop(); } catch (error) { errors.push(error); }
      // Modules stop first (reverse start order, each bounded); one that fails or times out counts as an error.
      try {
        const { incomplete } = await modules?.stop() ?? { incomplete: [] };
        errors.push(...incomplete.map(() => new Error("MODULE_STOP_INCOMPLETE")));
      } catch (error) { errors.push(error); }
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
    const speechGate = new SpeechGate();
    const entries = moduleEntries(config.config);
    for (const entry of entries) if (entry.movedSettings) diagnostics.record("MODULE_SETTING_MOVED", { module: entry.id });
    const host = createModuleHost({ entries, core: createCoreOffer(config, speechGate),
      runtimeDataPath: config.config.runtimeDataPath, diagnostics });
    modules = host;
    // Resolved before the engines so their tool sets can include the declared module abilities.
    await host.resolve();
    moduleState = startModulesStateWriter({ host, runtimeDataPath: config.config.runtimeDataPath, diagnostics });
    const copilot = createCopilotRuntime({ config, diagnostics, modules: host });
    runtime = createEngineRouter({
      engines: {
        copilot,
        ...(config.config.claudeCode ? { "claude-code": createClaudeRuntime({ config, diagnostics, modules: host }) } : {}),
      },
      sessionEngine: (scope, sessionId) => store?.sessions.get(scope, sessionId)?.engine,
      // Process journals are engine-neutral; the Copilot runtime recovers all of them once.
      recoverOwnedProcesses: () => copilot.recoverOwnedProcesses(),
    });
    await runtime.recoverOwnedProcesses();
    store = openStore({ path: join(config.config.runtimeDataPath, "state.sqlite") });
    let media: MediaPipeline;
    telegram = createTelegramAdapter({
      config, store, diagnostics,
      resolveAttachment: (scope, id) => media.resolveAttachment(scope, id),
    });
    media = createMediaPipeline({
      config, store, diagnostics, download: telegram.downloadFile, audio: audioSettings(config.config), speechGate,
    });
    const recovery = store.recover();
    await media.cleanup();
    await host.start();
    application = createApplication({ config, store, runtime, media, delivery: telegram.transport, diagnostics,
      modules: host });
    await application.start(recovery);
    const app = application;
    notices = startModuleNotices({
      host, runtimeDataPath: config.config.runtimeDataPath, diagnostics,
      quietHours: config.config.quietHours ?? defaultQuietHours,
      ...(config.config.coordinatorAgentId === undefined ? {} : { notify: (text: string, key: string) => app.notifyCoordinator(text, key) }),
    });
    scheduler = createProactiveScheduler({
      store,
      quietHours: config.config.quietHours ?? defaultQuietHours,
      onDue: (item) => application!.triggerProactive(item),
    });
    scheduler.start();
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
