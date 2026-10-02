import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotClient } from "@github/copilot-sdk";
import type { ModelInfo as SdkModel, PermissionRequest, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { LoadedConfig } from "../../src/config/index.js";
import type { RuntimeEvent, RunIdentity, Session } from "../../src/domain.js";
import { createCopilotRuntime, detachedAction, questionFields, serviceClientOptions } from "../../src/agents/copilot.js";
import type { CopilotHost } from "../../src/agents/copilot.js";
import type { ProcessAccess, ProcessFailure, ProcessIdentity } from "../../src/agents/supervisor.js";
import { descendants, parseProcesses, ProcessSupervisor, recoverOwnedProcesses, sameProcess, terminateOwned } from "../../src/agents/supervisor.js";
import { deferred, scope, until } from "./session-runtime-fixtures.js";

const roots: string[] = [];
const runtimes: ReturnType<typeof createCopilotRuntime>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(options: { requestTimeoutMs?: number } = {}) {
  const root = resolve(".cache", `runtime-unit-${randomUUID()}`);
  roots.push(root); mkdirSync(root, { recursive: true });
  const canonical = join(root, "AGENT.md");
  writeFileSync(canonical, "Synthetic agent instructions.");
  const config: LoadedConfig = {
    config: {
      workspacePath: root, agentDefinitionsPath: root, agentLaunchersPath: root, secretsPath: join(root, "secrets.local.json"),
      runtimeDataPath: root, runtimeHomePath: join(root, "service-home"), skillDirectories: [root], ownerId: scope.ownerId,
      permissionMode: "manual",
      bots: [{ id: scope.botId, agentId: "synthetic-agent", tokenRef: "bot.token" }],
      bindings: [{ botId: scope.botId, chatId: scope.chatId, topicId: null, kind: "private" }], mcp: { mode: "none" },
    },
    agents: [
      { id: "synthetic-agent", defaultModel: "model-one", description: "Synthetic persona", userInvocable: true,
        canonicalPath: canonical, launcherPath: canonical },
      { id: "synthetic-worker", defaultModel: "model-two", description: "Synthetic worker", userInvocable: false,
        canonicalPath: canonical, launcherPath: canonical },
    ],
    resolveSecret: () => "known-secret", tokenForBot: () => "123456:synthetic",
  };
  const session: Session = {
    id: randomUUID(), conversationId: randomUUID(), scope, agentId: "synthetic-agent", workspace: root,
    providerSessionId: null, appliedModel: "model-one", pendingModel: null, generation: 1, createdAt: Date.now(), updatedAt: Date.now(),
  };
  let selected = session.appliedModel;
  let settings: SessionConfig | undefined;
  const native = {
    sessionId: `densemble-${session.id}`, send: vi.fn(async () => "send-1"),
    abort: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    setModel: vi.fn(async (model: string) => { selected = model; }),
    rpc: { model: { getCurrent: vi.fn(async () => ({ modelId: selected })) } },
  };
  const models: SdkModel[] = ["model-one", "model-two"].map((id) => ({
    id, name: id, capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 10000 } },
  }));
  const failures = new Set<(code: ProcessFailure) => void>();
  const host: CopilotHost = {
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    onFailure: (handler) => { failures.add(handler); return () => { failures.delete(handler); }; },
    client: {
      ping: vi.fn(async () => ({ message: "synthetic", timestamp: new Date().toISOString() })),
      listModels: vi.fn(async () => models),
      createSession: vi.fn(async (value) => { settings = value; return native; }),
      resumeSession: vi.fn(async (_id, value) => { settings = value; return native; }),
      deleteSession: vi.fn(async () => undefined),
    },
  };
  const events: RuntimeEvent[] = [];
  const runtime = createCopilotRuntime({ config, diagnostics: { record: vi.fn() },
    hostFactory: async () => host, abortGraceMs: 5, previewIntervalMs: 0, requestTimeoutMs: options.requestTimeoutMs ?? 50 });
  runtimes.push(runtime);
  const identity: RunIdentity = { scope, sessionId: session.id, runId: randomUUID(), generation: 1 };
  function emit<T extends SessionEvent["type"]>(type: T, data: Extract<SessionEvent, { type: T }>["data"], agentId?: string) {
    // Fixtures preserve the SDK discriminant/data relationship; metadata is synthetic.
    const event = { id: randomUUID(), type, data, timestamp: new Date().toISOString(), parentId: null, ...(agentId ? { agentId } : {}) } as SessionEvent;
    settings?.onEvent?.(event);
  }
  async function open() { return runtime.open({ session, onEvent: (event) => events.push(event) }); }
  async function send() { await runtime.execute({ kind: "send", identity, input: { text: "Synthetic", images: [], notices: [], attachmentIds: [] } }); }
  function loseHost() { for (const handler of failures) handler("RUNTIME_PROCESS_EXITED"); }
  return { root, config, session, native, host, events, runtime, identity, open, send, emit, loseHost, settings: () => settings! };
}

describe("pinned Copilot runtime adapter", () => {
  it("uses a persistent service home twice, registers workers and explicit skills/tools, and disables history discovery", async () => {
    const f = setup(); await f.open();
    const settings = f.settings();
    expect(settings.configDirectory).toBe(f.config.config.runtimeHomePath);
    expect(serviceClientOptions(f.config, "/synthetic/cli").baseDirectory).toBe(f.config.config.runtimeHomePath);
    expect(settings.enableConfigDiscovery).toBe(false);
    expect(settings.customAgents).toHaveLength(2);
    expect(settings.customAgents?.[1]).toMatchObject({ name: "synthetic-worker", model: "model-two" });
    expect(settings.customAgents?.[1]).not.toHaveProperty("infer");
    expect(settings.skillDirectories).toEqual(f.config.config.skillDirectories);
    expect(settings.enableSkills).toBe(true);
    expect(settings.enableSessionStore).toBe(false);
    expect(settings.excludedTools).toContain("session_store_sql");
    expect(settings.agent).toBe("synthetic-agent");
    expect(f.native.send).not.toHaveBeenCalled();
  });
  it("fails an unavailable worker model rather than silently substituting", async () => {
    const f = setup(); f.config.agents[1]!.defaultModel = "unavailable";
    await expect(f.open()).rejects.toThrow("MODEL_UNAVAILABLE");
    expect(f.host.client.createSession).not.toHaveBeenCalled();
    expect(f.host.stop).toHaveBeenCalled();
  });
  it("requires root send correlation and ignores delegated deltas/messages/idle", async () => {
    const f = setup(); await f.open(); await f.send();
    f.emit("assistant.message_delta", { messageId: "child", deltaContent: "SECRET_CHILD" }, "worker");
    f.emit("assistant.message", { messageId: "child", content: "SECRET_CHILD", originatingMessageId: "send-1" }, "worker");
    f.emit("session.idle", {}, "worker");
    f.emit("assistant.message", { messageId: "stale", content: "STALE", originatingMessageId: "old-send" });
    f.emit("assistant.message_delta", { messageId: "root", deltaContent: "Root" });
    f.emit("assistant.message", { messageId: "root", content: "Root", originatingMessageId: "send-1" });
    f.emit("session.idle", {});
    expect(f.events.filter((event) => event.kind === "completed")).toEqual([{ ...f.identity, kind: "completed", text: "Root" }]);
    expect(JSON.stringify(f.events)).not.toContain("SECRET_CHILD");
    expect(f.events.find((event) => event.kind === "delta")).toMatchObject({ text: "Root" });
  });
  it("handles terminal events that precede send acknowledgement without losing correlation", async () => {
    const f = setup(); await f.open();
    const send = deferred<string>(); f.native.send.mockReturnValueOnce(send.promise);
    const pending = f.send();
    f.emit("assistant.message", { messageId: "root", content: "Fast", originatingMessageId: "send-1" });
    f.emit("session.idle", {});
    expect(f.events.some((event) => event.kind === "completed")).toBe(false);
    send.resolve("send-1"); await pending;
    expect(f.events.find((event) => event.kind === "completed")).toMatchObject({ text: "Fast" });
  });
  it("keeps native permission promises pending until the exact service request is explicitly answered", async () => {
    const f = setup(); await f.open(); await f.send();
    const permission = f.settings().onPermissionRequest!({
      kind: "custom-tool", toolName: "synthetic_tool", toolDescription: "Synthetic", args: { token: "known-secret", value: "synthetic" },
    }, { sessionId: f.native.sessionId });
    const event = f.events.find((event) => event.kind === "request")!;
    expect(event.kind).toBe("request");
    if (event.kind !== "request") return;
    expect(JSON.stringify(event.payload)).not.toContain("known-secret");
    await f.runtime.execute({ kind: "answer", identity: { ...f.identity, generation: 2 }, requestId: event.requestId,
      answer: { kind: "permission", approved: true } });
    await f.runtime.execute({ kind: "answer", identity: f.identity, requestId: event.requestId,
      answer: { kind: "permission", approved: true } });
    await expect(permission).resolves.toEqual({ kind: "approve-once" });
  });
  it.each(["autopilot", undefined] as const)("routes quoted Trello URLs without a prompt with permissionMode=%s", async (mode) => {
    const f = setup();
    if (mode) f.config.config.permissionMode = mode;
    else delete f.config.config.permissionMode;
    await f.open(); await f.send();
    const command = 'KEY=synthetic && curl -s "https://api.trello.com/1/boards/synthetic/cards?key=$KEY&token=synthetic&fields=name"';
    const hook = f.settings().hooks!.onPreToolUse!;
    expect(await hook({ sessionId: f.native.sessionId, timestamp: new Date(), workingDirectory: f.root,
      toolName: "bash", toolArgs: { command } }, { sessionId: f.native.sessionId })).toEqual({ permissionDecision: "ask" });
    const permission: PermissionRequest = { kind: "shell", fullCommandText: command,
      canOfferSessionApproval: false, commands: [], hasWriteFileRedirection: false,
      intention: "Read synthetic board", possiblePaths: [], possibleUrls: [] };
    await expect(f.settings().onPermissionRequest!(permission, { sessionId: f.native.sessionId }))
      .resolves.toEqual({ kind: "approve-once" });
    expect(f.events.some((event) => event.kind === "request")).toBe(false);
    expect(f.native.rpc.model.getCurrent).toHaveBeenCalledTimes(2);
    expect(await f.settings().onPermissionRequest!({ ...permission, requestSandboxBypass: true },
      { sessionId: f.native.sessionId })).toEqual({ kind: "reject" });
    expect(await f.settings().onPermissionRequest!({ ...permission, fullCommandText: "node worker &" },
      { sessionId: f.native.sessionId })).toEqual({ kind: "reject" });
  });
  it("keeps autopilot scoped to a live session and rejects mandatory managed approval", async () => {
    const f = setup(); f.config.config.permissionMode = "autopilot"; await f.open();
    const permission: PermissionRequest = { kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {} };
    const decide = f.settings().onPermissionRequest!;
    expect(await decide(permission, { sessionId: f.native.sessionId })).toEqual({ kind: "reject" });
    await f.send();
    expect(await decide(permission, { sessionId: "other-session" })).toEqual({ kind: "reject" });
    expect(await decide({ ...permission, managedApprovalRequired: true }, { sessionId: f.native.sessionId }))
      .toEqual({ kind: "reject" });
    await f.runtime.execute({ kind: "stop", identity: f.identity });
    expect(await decide(permission, { sessionId: f.native.sessionId })).toEqual({ kind: "reject" });
    expect(f.events.some((event) => event.kind === "request")).toBe(false);
  });
  it.each(["stop", "disconnect"] as const)("revokes autopilot approval when %s races its connection check", async (race) => {
    const f = setup(); f.config.config.permissionMode = "autopilot";
    await f.open(); await f.send();
    const check = deferred<{ modelId: string }>();
    f.native.rpc.model.getCurrent.mockReturnValueOnce(check.promise);
    const permission = f.settings().onPermissionRequest!({
      kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {},
    }, { sessionId: f.native.sessionId });
    if (race === "stop") {
      const stop = f.runtime.execute({ kind: "stop", identity: f.identity });
      check.resolve({ modelId: "model-one" });
      await stop;
    } else check.reject(new Error("Synthetic disconnected transport"));
    await expect(permission).resolves.toEqual({ kind: "reject" });
    expect(f.events.some((event) => event.kind === "request")).toBe(false);
  });
  it("distinguishes a stale run from forbidden detached execution in hook errors", async () => {
    const f = setup(); await f.open();
    const hook = f.settings().hooks!.onPreToolUse!;
    const input = { sessionId: f.native.sessionId, timestamp: new Date(), workingDirectory: f.root,
      toolName: "bash", toolArgs: { command: "node worker &" } };
    expect(await hook(input, { sessionId: f.native.sessionId })).toMatchObject({
      permissionDecision: "deny", permissionDecisionReason: "Дія не належить живому керованому виконанню.",
    });
    await f.send();
    expect(await hook(input, { sessionId: f.native.sessionId })).toMatchObject({
      permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("відокремленого процесу"),
    });
  });
  it("default-denies waits on stop and only reports stopped after owned host termination", async () => {
    const f = setup(); await f.open(); await f.send();
    const permission = f.settings().onPermissionRequest!({ kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {} },
      { sessionId: f.native.sessionId });
    const closing = deferred<void>(); vi.mocked(f.host.stop).mockReturnValueOnce(closing.promise);
    const stop = f.runtime.execute({ kind: "stop", identity: f.identity });
    await expect(permission).resolves.toEqual({ kind: "reject" });
    await new Promise((done) => setTimeout(done, 15));
    expect(f.events.some((event) => event.kind === "stopped")).toBe(false);
    closing.resolve(); await stop;
    expect(f.events.find((event) => event.kind === "stopped")).toMatchObject({ forced: true, externalOutcomeUnknown: true });
  });
  it.each(["root-exit", "sdk-shutdown"])("revokes pending permissions and fails the exact run on %s before cleanup completes", async (kind) => {
    const f = setup(); await f.open(); await f.send();
    const permission = f.settings().onPermissionRequest!({
      kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {},
    }, { sessionId: f.native.sessionId });
    const requested = f.events.find((event) => event.kind === "request")!;
    if (requested.kind !== "request") throw new Error("REQUEST_EXPECTED");
    const closing = deferred<void>();
    vi.mocked(f.host.stop).mockReturnValueOnce(closing.promise);
    if (kind === "root-exit") f.loseHost();
    else f.emit("session.shutdown", { shutdownType: "error", sessionStartTime: Date.now(), totalApiDurationMs: 0,
      modelMetrics: {}, codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 } });
    await f.runtime.execute({ kind: "answer", identity: f.identity, requestId: requested.requestId,
      answer: { kind: "permission", approved: true } });
    await expect(permission).resolves.toEqual({ kind: "reject" });
    expect(f.events.filter((event) => event.kind === "failed")).toEqual([{
      ...f.identity, kind: "failed", code: kind === "root-exit" ? "RUNTIME_PROCESS_EXITED" : "RUNTIME_SESSION_SHUTDOWN",
    }]);
    expect(f.events.some((event) => event.kind === "stopped")).toBe(false);
    await expect(f.send()).rejects.toThrow("RUNTIME_SESSION_NOT_READY");
    const stopping = f.runtime.execute({ kind: "stop", identity: f.identity });
    closing.resolve(); await stopping;
    f.emit("assistant.message", { messageId: "late", content: "Must not escape", originatingMessageId: "send-1" });
    f.emit("session.idle", {});
    expect(f.events.some((event) => event.kind === "completed")).toBe(false);
    expect(f.native.send).toHaveBeenCalledOnce();
    expect(f.host.stop).toHaveBeenCalledOnce();
  });
  it("revalidates a claimed permission when runtime loss races its async continuation", async () => {
    const f = setup(); await f.open(); await f.send();
    const permission = f.settings().onPermissionRequest!({
      kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {},
    }, { sessionId: f.native.sessionId });
    const requested = f.events.find((event) => event.kind === "request")!;
    if (requested.kind !== "request") throw new Error("REQUEST_EXPECTED");
    const answering = f.runtime.execute({ kind: "answer", identity: f.identity, requestId: requested.requestId,
      answer: { kind: "permission", approved: true } });
    f.loseHost();
    await answering;
    await expect(permission).resolves.toEqual({ kind: "reject" });
  });
  it("never approves through a disconnected SDK transport even before the root-exit observer fires", async () => {
    const f = setup(); await f.open(); await f.send();
    const permission = f.settings().onPermissionRequest!({
      kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {},
    }, { sessionId: f.native.sessionId });
    const requested = f.events.find((event) => event.kind === "request")!;
    if (requested.kind !== "request") throw new Error("REQUEST_EXPECTED");
    f.native.rpc.model.getCurrent.mockRejectedValueOnce(new Error("Synthetic disconnected transport"));
    await f.runtime.execute({ kind: "answer", identity: f.identity, requestId: requested.requestId,
      answer: { kind: "permission", approved: true } });
    await expect(permission).resolves.toEqual({ kind: "reject" });
    expect(f.events.find((event) => event.kind === "failed")).toEqual({
      ...f.identity, kind: "failed", code: "RUNTIME_CONNECTION_LOST",
    });
    expect(f.host.stop).toHaveBeenCalledOnce();
  });
  it("independently revokes an unanswered permission when SDK transport closes while the owned root remains alive", async () => {
    const f = setup({ requestTimeoutMs: 5_000 });
    const closing = deferred<void>();
    vi.useFakeTimers();
    try {
      await f.open(); await f.send();
      const permission = f.settings().onPermissionRequest!({
        kind: "custom-tool", toolName: "synthetic", toolDescription: "Synthetic", args: {},
      }, { sessionId: f.native.sessionId });
      const disconnected = new CopilotClient(serviceClientOptions(f.config, "/synthetic/cli"));
      await disconnected.forceStop();
      vi.mocked(f.host.client.ping).mockImplementation(() => disconnected.ping());
      vi.mocked(f.host.stop).mockReturnValueOnce(closing.promise);
      await vi.advanceTimersByTimeAsync(500);
      await expect(permission).resolves.toEqual({ kind: "reject" });
      expect(f.events.find((event) => event.kind === "failed")).toEqual({
        ...f.identity, kind: "failed", code: "RUNTIME_CONNECTION_LOST",
      });
      expect(f.host.stop).toHaveBeenCalledOnce();
      expect(f.native.rpc.model.getCurrent).toHaveBeenCalledOnce();
      expect(f.events.some((event) => event.kind === "stopped")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      closing.resolve();
      await f.runtime.shutdown();
      vi.useRealTimers();
    }
  });
  it("fails an ordinary turn within a bounded health timeout without overlapping stalled probes", async () => {
    const f = setup();
    const ping = deferred<Awaited<ReturnType<CopilotHost["client"]["ping"]>>>();
    vi.mocked(f.host.client.ping).mockReturnValue(ping.promise);
    vi.useFakeTimers();
    try {
      await f.open(); await f.send();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.host.client.ping).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(f.events.some((event) => event.kind === "failed")).toBe(false);
      expect(f.host.client.ping).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.events.find((event) => event.kind === "failed")).toEqual({
        ...f.identity, kind: "failed", code: "RUNTIME_CONNECTION_LOST",
      });
      expect(f.host.stop).toHaveBeenCalledOnce();
      expect(f.native.rpc.model.getCurrent).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      ping.resolve({ message: "synthetic", timestamp: new Date().toISOString() });
      await f.runtime.shutdown();
      vi.useRealTimers();
    }
  });
  it("does not probe a starting SDK client and cancels the monitor on shutdown", async () => {
    const f = setup();
    const starting = deferred<void>();
    vi.mocked(f.host.start).mockReturnValueOnce(starting.promise);
    vi.useFakeTimers();
    const opening = f.open();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.host.client.ping).not.toHaveBeenCalled();
      expect(f.host.stop).not.toHaveBeenCalled();
      starting.resolve(); await opening;
      await vi.advanceTimersByTimeAsync(500);
      expect(f.host.client.ping).toHaveBeenCalledOnce();
      await f.runtime.shutdown();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.host.client.ping).toHaveBeenCalledOnce();
    } finally {
      starting.resolve();
      await opening.catch(() => undefined);
      await f.runtime.shutdown();
      vi.useRealTimers();
    }
  });
  it("cancels an in-flight health deadline and ignores its late failure after shutdown", async () => {
    const f = setup();
    const ping = deferred<Awaited<ReturnType<CopilotHost["client"]["ping"]>>>();
    vi.mocked(f.host.client.ping).mockReturnValue(ping.promise);
    vi.useFakeTimers();
    try {
      await f.open();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.host.client.ping).toHaveBeenCalledOnce();
      await f.runtime.shutdown();
      expect(vi.getTimerCount()).toBe(0);
      ping.reject(new Error("Synthetic late transport error"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.host.client.ping).toHaveBeenCalledOnce();
      expect(f.events).toEqual([]);
    } finally {
      await f.runtime.shutdown();
      vi.useRealTimers();
    }
  });
  it.each(["manual", "autopilot"] as const)("exports only the approved exact tool invocation once in %s mode", async (mode) => {
    const f = setup(); f.config.config.permissionMode = mode;
    const exportFile = vi.fn(async () => ({
      id: "artifact", scope, sessionId: f.session.id, runId: f.identity.runId, kind: "output" as const,
      relativePath: "output/synthetic.txt", fileName: "synthetic.txt", mimeType: "text/plain", sizeBytes: 1,
      createdAt: Date.now(), expiresAt: null,
    }));
    await f.runtime.open({ session: f.session, exportFile, onEvent: (event) => f.events.push(event) });
    await f.send();
    const handler = f.settings().tools!.find((tool) => tool.name === "densemble_export_file")!.handler!;
    const invocation = { sessionId: f.native.sessionId, toolCallId: "export-call", toolName: "densemble_export_file",
      arguments: { path: "synthetic.txt" } };
    await expect(handler({ path: "synthetic.txt" }, invocation)).rejects.toThrow("EXPORT_NOT_AUTHORIZED");
    const permission = f.settings().onPermissionRequest!({
      kind: "custom-tool", toolName: "densemble_export_file", toolDescription: "Export", toolCallId: invocation.toolCallId,
      args: { path: "synthetic.txt" },
    }, { sessionId: f.native.sessionId });
    if (mode === "manual") {
      const event = f.events.find((event) => event.kind === "request")!;
      if (event.kind !== "request") throw new Error("Expected permission");
      await f.runtime.execute({ kind: "answer", identity: f.identity, requestId: event.requestId,
        answer: { kind: "permission", approved: true } });
    } else expect(f.events.some((event) => event.kind === "request")).toBe(false);
    await expect(permission).resolves.toEqual({ kind: "approve-once" });
    await expect(handler({ path: "other.txt" }, invocation)).rejects.toThrow("EXPORT_NOT_AUTHORIZED");
    await handler({ path: "synthetic.txt" }, invocation);
    expect(exportFile).toHaveBeenCalledWith(f.identity, "synthetic.txt", expect.any(AbortSignal));
    await expect(handler({ path: "synthetic.txt" }, invocation)).rejects.toThrow("EXPORT_NOT_AUTHORIZED");
    expect(exportFile).toHaveBeenCalledTimes(1);
  });
  it("stops the owned host while SDK startup is still pending", async () => {
    const f = setup();
    const starting = deferred<void>();
    vi.mocked(f.host.start).mockReturnValueOnce(starting.promise);
    const controller = new AbortController();
    const opening = f.runtime.open({ session: f.session, signal: controller.signal, onEvent: (event) => f.events.push(event) });
    await vi.waitFor(() => expect(f.host.start).toHaveBeenCalled());
    controller.abort();
    await f.runtime.execute({ kind: "stop", identity: f.identity });
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    starting.resolve();
    await expect(opening).rejects.toThrow();
    expect(f.host.client.createSession).not.toHaveBeenCalled();
  });
  it("ignores stale stop/answer identities instead of affecting a newer run", async () => {
    const f = setup(); await f.open(); await f.send();
    await f.runtime.execute({ kind: "stop", identity: { ...f.identity, generation: 99 } });
    expect(f.native.abort).not.toHaveBeenCalled();
    expect(f.host.stop).not.toHaveBeenCalled();
  });
  it("cooperative abort needs root abort plus idle and still closes owned processes", async () => {
    const f = setup(); await f.open(); await f.send();
    f.native.abort.mockImplementation(async () => { f.emit("abort", { reason: "user_initiated" }); f.emit("session.idle", {}); });
    await f.runtime.execute({ kind: "stop", identity: f.identity });
    expect(f.events.find((event) => event.kind === "stopped")).toMatchObject({ forced: false });
    expect(f.host.stop).toHaveBeenCalledTimes(1);
  });
  it("resumes only service-owned IDs, re-registers hooks, and never continues pending work", async () => {
    const f = setup(); f.session.providerSessionId = f.native.sessionId;
    await f.open();
    expect(f.host.client.resumeSession).toHaveBeenCalledWith(f.native.sessionId, expect.objectContaining({
      continuePendingWork: false, onPermissionRequest: expect.any(Function), onUserInputRequest: expect.any(Function),
      tools: expect.any(Array),
    }));
    expect(f.native.send).not.toHaveBeenCalled();
    await expect(f.runtime.deleteSession(scope, f.session.id, "interactive-session")).rejects.toThrow("UNOWNED_PROVIDER_SESSION");
  });
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "passes the installed SDK resume flag through the actual production host boundary without starting native work",
    async () => {
      const f = setup();
      f.session.providerSessionId = f.native.sessionId;
      vi.spyOn(ProcessSupervisor.prototype, "start").mockResolvedValue();
      vi.spyOn(ProcessSupervisor.prototype, "stop").mockResolvedValue();
      vi.spyOn(ProcessSupervisor.prototype, "hasLiveDescendants").mockResolvedValue(false);
      const start = vi.spyOn(CopilotClient.prototype, "start");
      vi.spyOn(CopilotClient.prototype, "listModels").mockResolvedValue(await f.host.client.listModels());
      const resume = vi.spyOn(CopilotClient.prototype, "resumeSession")
        .mockRejectedValue(new Error("SYNTHETIC_SDK_BOUNDARY_REACHED"));
      const runtime = createCopilotRuntime({ config: f.config, diagnostics: { record: vi.fn() } });
      runtimes.push(runtime);
      await expect(runtime.open({ session: f.session, onEvent: () => undefined }))
        .rejects.toThrow("SYNTHETIC_SDK_BOUNDARY_REACHED");
      expect(start).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledOnce();
      const resumed = resume.mock.calls[0]![1];
      expect(resumed.continuePendingWork).toBe(false);
      expect(resumed).not.toHaveProperty("continuePendingMessages");
      expect(resumed.onPermissionRequest).toBeTypeOf("function");
      expect(resumed.onUserInputRequest).toBeTypeOf("function");
    },
  );
  it("recreates SDK-discarded empty sessions but never replaces a missing nonempty history", async () => {
    const empty = setup();
    empty.session.providerSessionId = empty.native.sessionId;
    empty.session.generation = 0;
    vi.mocked(empty.host.client.resumeSession).mockRejectedValueOnce(new Error("Session not found"));
    await empty.open();
    expect(empty.host.client.deleteSession).toHaveBeenCalledWith(empty.native.sessionId);
    expect(empty.host.client.createSession).toHaveBeenCalledTimes(1);
    const nonempty = setup();
    nonempty.session.providerSessionId = nonempty.native.sessionId;
    vi.mocked(nonempty.host.client.resumeSession).mockRejectedValueOnce(new Error("Session not found"));
    await expect(nonempty.open()).rejects.toThrow("Session not found");
    expect(nonempty.host.client.deleteSession).not.toHaveBeenCalled();
    expect(nonempty.host.client.createSession).not.toHaveBeenCalled();
  });
  it("never reports a mismatched actual model as switched", async () => {
    const f = setup(); await f.open(); await f.send();
    await expect(f.runtime.setModel(scope, f.session.id, "model-two")).rejects.toThrow("MODEL_BOUNDARY_REQUIRED");
    f.emit("assistant.message", { messageId: "root", content: "Done", originatingMessageId: "send-1" });
    f.emit("session.idle", {});
    f.native.setModel.mockImplementationOnce(async () => undefined);
    await expect(f.runtime.setModel(scope, f.session.id, "model-two")).rejects.toThrow("MODEL_CONFIRM_MISMATCH");
    expect(f.host.stop).toHaveBeenCalledOnce();
    await expect(f.send()).rejects.toThrow("RUNTIME_SESSION_NOT_OPEN");
  });
  it.each(["switch", "confirmation"])("quarantines an uncertain model after %s failure and restores the persisted model on resume", async (stage) => {
    const f = setup(); await f.open();
    f.session.providerSessionId = f.native.sessionId;
    if (stage === "switch") f.native.setModel.mockRejectedValueOnce(new Error("Synthetic switch failure"));
    else f.native.rpc.model.getCurrent.mockRejectedValueOnce(new Error("Synthetic confirmation failure"));
    const closing = deferred<void>();
    vi.mocked(f.host.stop).mockReturnValueOnce(closing.promise);
    const switching = f.runtime.setModel(scope, f.session.id, "model-two");
    await until(() => vi.mocked(f.host.stop).mock.calls.length > 0);
    await expect(f.send()).rejects.toThrow("RUNTIME_SESSION_NOT_READY");
    await expect(f.open()).rejects.toThrow("RUNTIME_SCOPE_BUSY");
    closing.resolve();
    await expect(switching).rejects.toThrow("MODEL_SWITCH_FAILED");
    await expect(f.send()).rejects.toThrow("RUNTIME_SESSION_NOT_OPEN");
    await f.open();
    expect(f.native.setModel).toHaveBeenLastCalledWith("model-one");
    expect(await f.native.rpc.model.getCurrent()).toEqual({ modelId: "model-one" });
    expect(f.session.appliedModel).toBe("model-one");
    await f.send();
    expect(f.native.send).toHaveBeenCalledOnce();
  });
  it("rejects late open results after cancellation and does not revive runtime", async () => {
    const f = setup();
    const native = deferred<Awaited<ReturnType<CopilotHost["client"]["createSession"]>>>();
    vi.mocked(f.host.client.createSession).mockImplementation(async (settings) => {
      expect(settings.model).toBe("model-one"); return native.promise;
    });
    const controller = new AbortController();
    const open = f.runtime.open({ session: f.session, signal: controller.signal, onEvent: (event) => f.events.push(event) });
    await vi.waitFor(() => expect(f.host.client.createSession).toHaveBeenCalled());
    controller.abort(); native.resolve(f.native);
    await expect(open).rejects.toThrow("SESSION_OPEN_CANCELLED");
    expect(f.native.send).not.toHaveBeenCalled();
    expect(f.host.stop).toHaveBeenCalledTimes(1);
  });
  it("normalizes multi-field elicitation and rejects detached native execution", () => {
    expect(questionFields({ type: "object", properties: {
      colors: { type: "array", items: { type: "string", enum: ["red", "blue"] } },
      note: { type: "string" }, confirmed: { type: "boolean" },
    } }, "Form")).toMatchObject({ kind: "question", fields: [
      { id: "field_0", multiple: true }, { id: "field_1", allowFreeform: true }, { id: "field_2", choices: ["Так", "Ні"] },
    ] });
    expect(detachedAction("bash", { command: "node worker &" })).toBe(true);
    expect(detachedAction("bash", { command: "nohup node worker" })).toBe(true);
    expect(detachedAction("bash", { command: "git status && git diff" })).toBe(false);
    expect(detachedAction("bash", { command: "node worker", detach: true })).toBe(true);
  });
  it.each([
    'curl "https://example.invalid/?key=synthetic&token=synthetic"',
    "curl 'https://example.invalid/?a=1&b=2'",
    "curl https://example.invalid/?a=1\\&b=2",
    'KEY=$(printf synthetic) && curl "https://example.invalid/?key=$KEY&fields=name"',
    "printf '%s' 'fish & chips' && printf done",
    "node worker 2>&1",
    "node worker &>output.txt",
    "node worker &>>output.txt",
    "node worker |& cat",
    "node worker # a comment &",
  ])("does not mistake literals or redirections for detached execution: %s", (command) => {
    expect(detachedAction("bash", { command })).toBe(false);
  });
  it.each([
    "node worker &", "node worker & wait", 'printf "%s" "$(node worker &)"',
    "printf '%s' \"`node worker &`\"", "result=$(node worker &) && printf done",
    'curl "https://example.invalid/?a=1&b=2" &', "node worker 2>&1 &",
    "node worker &>output.txt &", "node worker # literal &\nnode other &",
    "node worker &\nwait", "(node worker &) ", "bash -c 'nohup node worker'",
  ])("still rejects real background or detached execution: %s", (command) => {
    expect(detachedAction("bash", { command })).toBe(true);
  });
});

describe("PID/start ownership and restart recovery", () => {
  const root: ProcessIdentity = { pid: 321, parent: 1, started: "Wed Sep 30 10:00:00 2026", command: "/synthetic/copilot" };
  const child: ProcessIdentity = { pid: 322, parent: 321, started: root.started, command: "/synthetic/tool" };
  it("parses snapshots without arguments, drops zombies, and rejects ambiguous output", () => {
    expect(parseProcesses("321 1 Wed Sep 30 10:00:00 2026 S /synthetic/copilot\n323 1 Wed Sep 30 10:00:00 2026 Z /dead"))
      .toEqual([{ ...root, state: "S" }]);
    expect(() => parseProcesses("unexpected")).toThrow("PROCESS_LIST_INVALID");
    expect(descendants(root, [root, child, { ...child, pid: 400, parent: 999 }])).toEqual([child]);
    expect(sameProcess(root, { ...root, started: "new-start" })).toBe(false);
  });
  it("signals only exact owned identities, including reparented children, and observes exit", async () => {
    const reused = { ...root, started: "new-start" };
    let snapshot = [reused, { ...child, parent: 1 }, { ...child, pid: 900, parent: 999 }];
    const signals: [number, NodeJS.Signals][] = [];
    const access: ProcessAccess = {
      snapshot: async () => snapshot,
      signal(pid, signal) {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") snapshot = snapshot.filter((entry) => entry.pid !== pid);
      },
    };
    await terminateOwned([child, root], access, 20);
    expect(signals).toEqual([[child.pid, "SIGSTOP"], [child.pid, "SIGKILL"]]);
    expect(snapshot.map((entry) => entry.pid)).toEqual([root.pid, 900]);
  });
  it("fails instead of claiming stopped when the owned process survives", async () => {
    await expect(terminateOwned([root], { snapshot: async () => [root], signal: () => undefined }, 5))
      .rejects.toThrow("OWNED_PROCESS_STILL_ALIVE");
  });
  it("freezes roots first, adopts a replacement child between kills, and never signals a neighboring process", async () => {
    const replacement = { ...child, pid: 323, state: "S" };
    let snapshot = [{ ...root, state: "S" }, { ...child, state: "S" }, { ...root, pid: 999, state: "S" }];
    const signals: [number, NodeJS.Signals][] = [];
    const persisted: ProcessIdentity[][] = [];
    await terminateOwned([child, root], {
      snapshot: async () => snapshot,
      signal(pid, signal) {
        signals.push([pid, signal]);
        if (signal === "SIGSTOP") snapshot = snapshot.map((entry) => entry.pid === pid ? { ...entry, state: "T" } : entry);
        if (signal === "SIGKILL") {
          if (pid === root.pid) expect(persisted.some((entries) => entries.some((entry) => entry.pid === replacement.pid))).toBe(true);
          snapshot = snapshot.filter((entry) => entry.pid !== pid);
          if (pid === child.pid) snapshot.push(replacement);
        }
      },
    }, 100, async (entries) => { persisted.push(entries); });
    expect(signals[0]).toEqual([root.pid, "SIGSTOP"]);
    expect(signals).toContainEqual([replacement.pid, "SIGSTOP"]);
    expect(signals).toContainEqual([replacement.pid, "SIGKILL"]);
    expect(signals.at(-1)).toEqual([root.pid, "SIGKILL"]);
    expect(snapshot.map((entry) => entry.pid)).toEqual([999]);
  });
  it("retains newly discovered children in the recovery journal when termination cannot finish", async () => {
    const directory = resolve(".cache", `runtime-recovery-${randomUUID()}`); roots.push(directory);
    mkdirSync(join(directory, "processes"), { recursive: true });
    const path = join(directory, "processes", `${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ version: 1, root, children: [child] }));
    const replacement = { ...child, pid: 323, state: "S" };
    let snapshot = [{ ...root, state: "S" }, { ...child, state: "S" }];
    await expect(recoverOwnedProcesses(directory, {
      snapshot: async () => snapshot,
      signal(pid, signal) {
        if (pid === replacement.pid) throw new Error("SYNTHETIC_SIGNAL_FAILED");
        if (signal === "SIGSTOP") snapshot = snapshot.map((entry) => entry.pid === pid ? { ...entry, state: "T" } : entry);
        if (signal === "SIGKILL") {
          snapshot = snapshot.filter((entry) => entry.pid !== pid);
          if (pid === child.pid) snapshot.push(replacement);
        }
      },
    })).rejects.toThrow("SYNTHETIC_SIGNAL_FAILED");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      children: expect.arrayContaining([expect.objectContaining({ pid: replacement.pid })]),
    });
  });
  it("reports an unexpected root exit once and cleans tracked reparented descendants", async () => {
    const f = setup();
    const ownedRoot = { ...root, parent: process.pid, state: "S" };
    let snapshot: ProcessIdentity[] = [];
    const failures: ProcessFailure[] = [];
    const supervisor = new ProcessSupervisor(f.root, root.command, { record: () => undefined }, {
      snapshot: async () => snapshot,
      signal(pid, signal) {
        if (signal === "SIGSTOP") snapshot = snapshot.map((entry) => entry.pid === pid ? { ...entry, state: "T" } : entry);
        if (signal === "SIGKILL") snapshot = snapshot.filter((entry) => entry.pid !== pid);
      },
    });
    supervisor.onFailure((code) => failures.push(code));
    try {
      await supervisor.start(async () => { snapshot = [ownedRoot, { ...child, state: "S" }]; });
      snapshot = [{ ...child, parent: 1, state: "S" }];
      await until(() => failures.length > 0);
      expect(failures).toEqual(["RUNTIME_PROCESS_EXITED"]);
      await supervisor.stop(async () => undefined);
      expect(snapshot).toEqual([]);
      expect(failures).toHaveLength(1);
    } finally { await supervisor.stop(async () => undefined); }
  });
  it("still closes the SDK-owned handle when initial process observation fails", async () => {
    const f = setup();
    let snapshots = 0;
    const close = vi.fn(async () => undefined);
    const supervisor = new ProcessSupervisor(f.root, root.command, { record: () => undefined }, {
      async snapshot() {
        snapshots++;
        if (snapshots === 1) return [];
        if (snapshots === 2) return [{ ...root, parent: process.pid }];
        throw new Error("SYNTHETIC_PROCESS_OBSERVATION_FAILED");
      },
      signal: () => undefined,
    });
    await expect(supervisor.start(async () => undefined)).rejects.toThrow("SYNTHETIC_PROCESS_OBSERVATION_FAILED");
    await expect(supervisor.stop(close)).rejects.toThrow("SYNTHETIC_PROCESS_OBSERVATION_FAILED");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("kills only service-journal ownership before queued recovery, preserving unrelated processes", async () => {
    const directory = resolve(".cache", `runtime-recovery-${randomUUID()}`); roots.push(directory);
    mkdirSync(join(directory, "processes"), { recursive: true });
    writeFileSync(join(directory, "processes", `${randomUUID()}.json`), JSON.stringify({ version: 1, root, children: [child] }));
    let snapshot = [root, child, { ...root, pid: 999 }];
    const signals: number[] = [];
    await recoverOwnedProcesses(directory, {
      snapshot: async () => snapshot,
      signal(pid) { signals.push(pid); snapshot = snapshot.filter((entry) => entry.pid !== pid); },
    });
    expect(new Set(signals)).toEqual(new Set([child.pid, root.pid]));
    expect(snapshot.map((entry) => entry.pid)).toEqual([999]);
  });
});
