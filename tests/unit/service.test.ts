import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";

const harness = vi.hoisted(() => {
  const calls: string[] = [];
  const record = (name: string) => () => { calls.push(name); };
  return {
    calls, record, telegramFails: false, shutdownFails: false, drainHangs: false,
    runtime: { shutdown: vi.fn(async () => { calls.push("runtime.stop"); }),
      recoverOwnedProcesses: vi.fn(async () => { calls.push("runtime.recover"); }) },
    store: { recover: vi.fn(() => { calls.push("store.recover"); return { queuedInputs: [] }; }),
      close: vi.fn(record("store.close")) },
    lock: { release: vi.fn(record("lock.release")) },
    application: { start: vi.fn(async () => { calls.push("app.start"); }),
      shutdown: vi.fn(async () => {
        calls.push("app.stop");
        if (harness.shutdownFails) throw new Error("APP_SHUTDOWN_TIMEOUT");
      }),
      drain: vi.fn(async () => {
        calls.push("app.drain");
        if (harness.drainHangs) await new Promise<void>(() => {});
      }) },
    media: { cleanup: vi.fn(async () => { calls.push("media.cleanup"); }),
      resolveAttachment: vi.fn() },
  };
});
vi.mock("../../src/storage/process-lock.js", () => ({
  acquireProcessLock: () => { harness.calls.push("lock.acquire"); return harness.lock; },
}));
vi.mock("../../src/storage/index.js", () => ({
  openStore: () => { harness.calls.push("store.open"); return harness.store; },
}));
vi.mock("../../src/agents/index.js", async () => ({
  createCopilotRuntime: () => harness.runtime,
  createClaudeRuntime: () => { throw new Error("UNEXPECTED_CLAUDE_RUNTIME"); },
  createEngineRouter: (await vi.importActual<typeof import("../../src/agents/router.js")>("../../src/agents/router.js")).createEngineRouter,
}));
vi.mock("../../src/media/index.js", () => ({ createMediaPipeline: () => harness.media }));
vi.mock("../../src/recordings/index.js", () => ({
  startRecordingTranscription: async (options: { settings?: unknown }) => {
    harness.calls.push(options.settings ? "recordings.start" : "recordings.off");
    return options.settings ? { stop: async () => { harness.calls.push("recordings.stop"); } } : undefined;
  },
}));
vi.mock("../../src/application/index.js", () => ({ createApplication: () => harness.application }));
vi.mock("../../src/telegram/index.js", () => ({
  createTelegramAdapter: () => ({
    transport: {}, downloadFile: vi.fn(),
    start: async () => {
      harness.calls.push("telegram.start");
      if (harness.telegramFails) throw new Error("SYNTHETIC_START_FAILED");
    },
    stop: async () => { harness.calls.push("telegram.stop"); },
  }),
}));
vi.mock("../../src/operations/diagnostics.js", () => ({ createDiagnostics: () => ({ record: vi.fn() }) }));
const { startService } = await import("../../src/service.js");

const config: LoadedConfig = {
  config: { workspacePath: "/synthetic/workspace", agentDefinitionsPath: "/synthetic/workspace/agents",
    agentLaunchersPath: "/synthetic/workspace/launchers", secretsPath: "/synthetic/workspace/secrets.local.json",
    runtimeDataPath: "/synthetic/data", runtimeHomePath: "/synthetic/copilot", skillDirectories: [],
    ownerId: 1, bots: [], bindings: [], mcp: { mode: "none" } },
  agents: [], tokenForBot: () => { throw new Error("NO_TOKEN_EXPECTED"); },
  resolveSecret: () => { throw new Error("NO_SECRET_EXPECTED"); },
};
beforeEach(() => {
  harness.calls.length = 0;
  harness.telegramFails = false;
  harness.shutdownFails = false;
  harness.drainHangs = false;
});

describe("service composition lifecycle", () => {
  it("recovers owned processes before database work and accepts input only after media recovery", async () => {
    const service = await startService(config);
    expect(harness.calls).toEqual(["lock.acquire", "runtime.recover", "store.open",
      "store.recover", "media.cleanup", "recordings.off", "app.start", "telegram.start"]);
    await service.stop();
    await service.stop();
    expect(harness.calls.slice(8)).toEqual(["telegram.stop", "app.stop", "runtime.stop", "app.drain", "store.close", "lock.release"]);
  });
  it("starts the recordings worker after media recovery and stops it before the store closes", async () => {
    const service = await startService({ ...config, config: { ...config.config, recordings: {
      path: "/synthetic/workspace/raw/recordings", modelPath: "/m.bin", vadModelPath: "/v.bin" } } });
    expect(harness.calls.indexOf("recordings.start")).toBe(harness.calls.indexOf("media.cleanup") + 1);
    await service.stop();
    expect(harness.calls.indexOf("recordings.stop")).toBeLessThan(harness.calls.indexOf("store.close"));
    expect(harness.calls.indexOf("recordings.stop")).toBeLessThan(harness.calls.indexOf("telegram.stop"));
  });
  it("unwinds partial startup while still closing runtime before releasing the process lock", async () => {
    harness.telegramFails = true;
    await expect(startService(config)).rejects.toThrow("SYNTHETIC_START_FAILED");
    expect(harness.calls.slice(-6)).toEqual(["telegram.stop", "app.stop", "runtime.stop", "app.drain", "store.close", "lock.release"]);
  });
  it("retains SQLite and the service lock when timed-out work is still unconfirmed", async () => {
    const service = await startService(config, { shutdownTimeoutMs: 10 });
    harness.shutdownFails = true;
    harness.drainHangs = true;
    await expect(service.stop()).rejects.toThrow("SERVICE_SHUTDOWN_INCOMPLETE");
    expect(harness.calls).not.toContain("store.close");
    expect(harness.calls).not.toContain("lock.release");
    expect(harness.calls).toContain("runtime.stop");
  });
  it("checks drainage after an application shutdown error before releasing ownership", async () => {
    const service = await startService(config);
    harness.shutdownFails = true;
    await expect(service.stop()).rejects.toThrow("SERVICE_SHUTDOWN_INCOMPLETE");
    expect(harness.calls.slice(-4)).toEqual(["runtime.stop", "app.drain", "store.close", "lock.release"]);
  });
});
