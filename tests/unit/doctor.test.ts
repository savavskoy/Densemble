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
