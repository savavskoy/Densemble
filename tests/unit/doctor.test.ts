import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";

const state = vi.hoisted(() => ({
  authenticated: true, failStart: false, stopped: 0, forced: 0, modelCalls: 0,
  botMethods: [] as string[],
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    async start() { if (state.failStart) throw new Error("synthetic-secret upstream"); }
    async getStatus() { return { version: "1.0.91" }; }
    async getAuthStatus() { return { isAuthenticated: state.authenticated }; }
    async listModels() { state.modelCalls++; return [{ id: "example" }]; }
    async stop() { state.stopped++; return []; }
    async forceStop() { state.forced++; }
  },
}));
vi.mock("../../src/agents/copilot.js", () => ({
  pinnedRuntimePath: async () => "/synthetic/cli",
  serviceClientOptions: () => ({}),
}));
vi.mock("../../src/media/index.js", () => ({
  checkAudioReadiness: async () => ({ ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" }),
}));
vi.mock("grammy", () => ({
  Api: class {
    async getMe() { state.botMethods.push("getMe"); return { id: 42 }; }
    async getWebhookInfo() { state.botMethods.push("getWebhookInfo"); return { url: "" }; }
  },
}));
const { doctor } = await import("../../src/operations/doctor.js");
const { recordingChecks } = await import("../../src/modules/recordings/doctor.js");
const { recordingSettings } = await import("../../src/modules/recordings/settings.js");
const { module: recordings } = await import("../../src/modules/recordings/index.js");
const config: LoadedConfig = {
  config: { workspacePath: "/synthetic/workspace", agentDefinitionsPath: "/synthetic/workspace/agents",
    agentLaunchersPath: "/synthetic/workspace/launchers", secretsPath: "/synthetic/workspace/secrets.local.json",
    runtimeDataPath: "/synthetic/data", runtimeHomePath: "/synthetic/copilot", skillDirectories: [],
    ownerId: 1, bots: [{ id: "helper", agentId: "helper", tokenRef: "telegram.helper" }], bindings: [], mcp: { mode: "none" } },
  agents: [], tokenForBot: () => "42:synthetic-secret-token", resolveSecret: () => "never log",
};
beforeEach(() => {
  Object.assign(state, { authenticated: true, failStart: false, stopped: 0, forced: 0, modelCalls: 0 });
  state.botMethods.length = 0;
});
describe("bounded read-only doctor", () => {
  it("reports missing audio distinctly and only requests bot identity/webhook metadata", async () => {
    const report = await doctor(config);
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({ component: "audio", ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" });
    expect(state.botMethods.sort()).toEqual(["getMe", "getWebhookInfo"]);
    expect(state.stopped).toBe(1);
    expect(state.forced).toBe(1);
    expect(JSON.stringify(report)).not.toContain("synthetic-secret");
  });
  it("does not infer authentication from stored configuration or call models when logged out", async () => {
    state.authenticated = false;
    const report = await doctor(config);
    expect(report.checks).toContainEqual({ component: "authentication", ready: false, code: "SERVICE_LOGIN_REQUIRED" });
    expect(state.modelCalls).toBe(0);
  });
  it("cleans failed startup and reports fixed errors rather than upstream contents", async () => {
    state.failStart = true;
    const report = await doctor(config);
    expect(report.checks).toContainEqual({ component: "runtime", ready: false, code: "RUNTIME_DIAGNOSTIC_FAILED" });
    expect(state.forced).toBe(1);
    expect(JSON.stringify(report)).not.toContain("synthetic-secret");
  });
});
describe("engine diagnostics", () => {
  const claudeConfig: LoadedConfig = { ...config, config: { ...config.config,
    claudeCode: { homePath: "/synthetic/claude", defaultModel: "claude-sonnet-5-5" },
    runtimeDataPath: `${process.cwd()}/.cache/doctor-claude`,
    bots: [...config.config.bots, { id: "claude-helper", agentId: "helper", tokenRef: "telegram.helper", engine: "claude-code" }] } };
  const host = (init: Partial<import("../../src/agents/claude.js").ClaudeInit>) => async () => ({
    start: async () => ({ version: "2.1.305", authenticated: true, commands: [],
      models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" }], ...init }),
    stop: async () => ({ forced: false }), onFailure: () => () => undefined, send: () => undefined,
    interrupt: async () => undefined, setModel: async () => undefined,
  });
  it("lists each bot's engine and skips Claude checks when no bot uses it", async () => {
    const report = await doctor(config);
    expect(report.checks).toContainEqual({ component: "bot-engine:helper", ready: true, code: "ENGINE_COPILOT" });
    expect(report.checks.some((check) => check.component.startsWith("claude-"))).toBe(false);
  });
  it("reports Claude Code version, login and models without inference", async () => {
    const report = await doctor(claudeConfig, { claudeHost: host({}) });
    expect(report.checks).toContainEqual({ component: "bot-engine:claude-helper", ready: true, code: "ENGINE_CLAUDE_CODE" });
    expect(report.checks).toContainEqual({ component: "claude-runtime", ready: true, code: "RUNTIME_READY" });
    expect(report.checks).toContainEqual({ component: "claude-authentication", ready: true, code: "AUTHENTICATED" });
    expect(report.checks).toContainEqual({ component: "claude-models", ready: true, code: "MODELS_READY", count: 1 });
  });
  it("reports a missing service login", async () => {
    const report = await doctor(claudeConfig, { claudeHost: host({ authenticated: false }) });
    expect(report.checks).toContainEqual({ component: "claude-authentication", ready: false, code: "CLAUDE_LOGIN_REQUIRED" });
    expect(report.checks.some((check) => check.component === "claude-models")).toBe(false);
  });
});
describe("recording transcription diagnostics", () => {
  const root = `${process.cwd()}/.cache/doctor-recordings-${process.pid}`;
  const header = (vocab: number) => {
    const bytes = Buffer.alloc(48);
    [0x67676d6c, vocab, 1500, 1280, 20, 32, 448, 1280, 20, 4, 128, 1].forEach((value, index) => bytes.writeInt32LE(value, index * 4));
    return bytes;
  };
  const audio = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", whisperPath: "whisper-cli", vocabulary: [] };
  const withRecordings = (modelPath: string, retryModel?: string) => recordingSettings({ path: `${root}/folder`, modelPath,
    vadModelPath: `${root}/vad.bin`, ...(retryModel ? { retry: { modelPath: retryModel } } : {}) }, audio);
  beforeEach(async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(`${root}/folder`, { recursive: true });
    writeFileSync(`${root}/turbo.bin`, header(51866));
    writeFileSync(`${root}/english.bin`, header(51864));
    writeFileSync(`${root}/vad.bin`, Buffer.from([0x6c, 0x6d, 0x67, 0x67, 0]));
  });
  it("reports nothing about recordings when the module is not configured", async () => {
    const report = await doctor(config);
    expect(report.checks.some((check) => check.component.includes("recordings"))).toBe(false);
    expect(report.checks).toContainEqual({ component: "coordinator", ready: true, code: "MODULE_COORDINATOR_NOT_CONFIGURED" });
  });
  it("reports folder, model, VAD and the legacy job with names only in details", async () => {
    const ready = await recordingChecks(withRecordings(`${root}/turbo.bin`), `${root}/missing.plist`);
    expect(ready.checks).toEqual([
      { component: "recordings", ready: true, code: "RECORDINGS_ENABLED" },
      { component: "recordings-folder", ready: true, code: "RECORDINGS_FOLDER_READY" },
      { component: "recordings-model", ready: true, code: "MEDIA_AUDIO_READY" },
      { component: "recordings-retry-model", ready: true, code: "MEDIA_AUDIO_READY" },
      { component: "recordings-vad", ready: true, code: "MEDIA_AUDIO_READY" },
      { component: "recordings-legacy-job", ready: true, code: "RECORDINGS_LEGACY_JOB_ABSENT" },
    ]);
    expect(ready.details).toEqual({ recordingsFolder: `${root}/folder`, recordingsModel: "turbo.bin",
      recordingsRetryModel: "turbo.bin", recordingsVadModel: "vad.bin" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${root}/legacy.plist`, "<plist/>");
    const warned = await recordingChecks(withRecordings(`${root}/english.bin`), `${root}/legacy.plist`);
    expect(warned.checks).toContainEqual({ component: "recordings-model", ready: false, code: "MEDIA_AUDIO_MODEL_ENGLISH_ONLY" });
    expect(warned.checks).toContainEqual({ component: "recordings-legacy-job", ready: false, code: "RECORDINGS_LEGACY_JOB_INSTALLED" });
    const missing = await recordingChecks(withRecordings(`${root}/absent.bin`), `${root}/missing.plist`);
    expect(missing.checks).toContainEqual({ component: "recordings-model", ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" });
  });
  it("checks a separately configured retry model on its own", async () => {
    const withRetry = (retryModel: string) => withRecordings(`${root}/turbo.bin`, retryModel);
    const missing = await recordingChecks(withRetry(`${root}/large.bin`), `${root}/missing.plist`);
    expect(missing.checks).toContainEqual({ component: "recordings-model", ready: true, code: "MEDIA_AUDIO_READY" });
    expect(missing.checks).toContainEqual({ component: "recordings-retry-model", ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" });
    expect(missing.details.recordingsRetryModel).toBe("large.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${root}/large.bin`, header(51866));
    const ready = await recordingChecks(withRetry(`${root}/large.bin`), `${root}/missing.plist`);
    expect(ready.checks).toContainEqual({ component: "recordings-retry-model", ready: true, code: "MEDIA_AUDIO_READY" });
  });
});
describe("module diagnostics", () => {
  const root = `${process.cwd()}/.cache/doctor-modules-${process.pid}`;
  const withModules = (extra: Partial<LoadedConfig["config"]>): LoadedConfig => ({ ...config,
    config: { ...config.config, workspacePath: root, ...extra } });
  const settings = { path: `${root}/folder`, modelPath: `${root}/absent.bin`, vadModelPath: `${root}/absent-vad.bin` };
  const components = (report: { checks: { component: string }[] }) => report.checks.map((check) => check.component);
  beforeEach(async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(`${root}/folder`, { recursive: true });
  });
  it("adds only MODULE_DISABLED for a disabled module, even with a missing model (SC-002)", async () => {
    const report = await doctor(withModules({ modules: { recordings: { enabled: false, settings } } }));
    expect(report.checks).toContainEqual({ component: "module:recordings", ready: true, code: "MODULE_DISABLED" });
    expect(components(report).filter((name) => name.includes("recordings"))).toEqual(["module:recordings"]);
  });
  it("runs the module's own checks when it is enabled and resolves, and names a moved setting", async () => {
    const report = await doctor(withModules({ recordings: settings, coordinatorAgentId: "helper" }));
    expect(report.checks).toContainEqual({ component: "config-migration", ready: true, code: "MODULE_SETTING_MOVED" });
    expect(report.checks).toContainEqual({ component: "coordinator", ready: true, code: "MODULE_COORDINATOR_CONFIGURED" });
    expect(report.checks).toContainEqual({ component: "module:recordings", ready: true, code: "MODULE_ENABLED" });
    expect(report.checks).toContainEqual({ component: "recordings-model", ready: false, code: "MEDIA_AUDIO_MODEL_MISSING" });
    expect(report.checks).toContainEqual({ component: "recordings-folder", ready: true, code: "RECORDINGS_FOLDER_READY" });
    expect(report.details).toMatchObject({ "recordings-folder": `${root}/folder`, "recordings-model": "absent.bin" });
    expect(report.ready).toBe(false);
  });
  it("reports unknown modules and invalid settings without running module checks", async () => {
    const report = await doctor(withModules({ modules: { recordings: { settings: { ...settings, pollIntervalMs: 1 } }, ghost: {} } }));
    expect(report.checks).toContainEqual({ component: "module:recordings", ready: false, code: "MODULE_SETTINGS_INVALID" });
    expect(report.checks).toContainEqual({ component: "module:ghost", ready: false, code: "MODULE_UNKNOWN" });
    expect(components(report).some((name) => name.startsWith("recordings"))).toBe(false);
    const outside = await doctor(withModules({ modules: { recordings: { settings: { ...settings, path: `${process.cwd()}/tests` } } } }));
    expect(outside.checks).toContainEqual({ component: "module:recordings", ready: false, code: "RECORDINGS_PATH_OUTSIDE_WORKSPACE" });
  });
  it("calls a module doctor only through the host", async () => {
    let called = 0;
    const loader = async (id: string) => id === "recordings" ? { ...recordings,
      doctor: async () => { called++; return [{ component: "recordings-probe", ready: true, code: "PROBE_READY", detail: "x" }]; } } : undefined;
    const report = await doctor(withModules({ modules: { recordings: { settings } } }), { moduleLoader: loader });
    expect(called).toBe(1);
    expect(report.checks).toContainEqual({ component: "recordings-probe", ready: true, code: "PROBE_READY" });
    await doctor(withModules({ modules: { recordings: { enabled: false, settings } } }), { moduleLoader: loader });
    expect(called).toBe(1);
  });
});
