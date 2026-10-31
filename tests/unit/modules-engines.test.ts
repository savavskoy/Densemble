import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolSet } from "@github/copilot-sdk";
import type { ModelInfo as SdkModel, SessionConfig, Tool } from "@github/copilot-sdk";
import type { HookCallback, McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedConfig } from "../../src/config/index.js";
import type { RunIdentity, RuntimeEvent, Session } from "../../src/domain.js";
import type { ControlledRuntime } from "../../src/agents/contracts.js";
import { createCopilotRuntime, type CopilotHost } from "../../src/agents/copilot.js";
import { createClaudeRuntime, type ClaudeHandlers, type ClaudeHost } from "../../src/agents/claude.js";
import { CLAUDE_CODE_VERSION } from "../../src/agents/claude-env.js";
import type { ModuleEntry } from "../../src/modules/contract.js";
import { createModuleHost, type ModuleHost } from "../../src/modules/host.js";
import { abilityModule, entry, fakeCore, fakeLoader } from "../fixtures/modules/index.js";
import { scope, until } from "./session-runtime-fixtures.js";

const roots: string[] = [];
const runtimes: ControlledRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function base(manual: boolean) {
  const root = resolve(".cache", `modules-engines-${randomUUID()}`);
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const canonical = join(root, "AGENT.md");
  writeFileSync(canonical, "Synthetic persona.");
  const config: LoadedConfig = {
    config: {
      workspacePath: workspace, agentDefinitionsPath: root, agentLaunchersPath: root, secretsPath: join(root, "secrets.local.json"),
      runtimeDataPath: root, runtimeHomePath: join(root, "home"), skillDirectories: [], ownerId: scope.ownerId,
      permissionMode: manual ? "manual" : "autopilot",
      claudeCode: { homePath: join(root, "claude-home"), defaultModel: "claude-sonnet-5-5" },
      bots: [{ id: scope.botId, agentId: "synthetic-agent", tokenRef: "bot.token" }],
      bindings: [{ botId: scope.botId, chatId: scope.chatId, topicId: null, kind: "private" }], mcp: { mode: "none" },
    },
    agents: [{ id: "synthetic-agent", defaultModel: "model-one", description: "Persona", userInvocable: true,
      canonicalPath: canonical, launcherPath: canonical }],
    resolveSecret: () => "known-secret", tokenForBot: () => "123456:synthetic",
  };
  return { root, workspace, config };
}

async function moduleHost(root: string, entries: ModuleEntry[]): Promise<{ host: ModuleHost; definition: ReturnType<typeof abilityModule> }> {
  const definition = abilityModule();
  const host = createModuleHost({ entries, loader: fakeLoader([definition]), core: fakeCore(), runtimeDataPath: root,
    diagnostics: { record: vi.fn() }, readInstructions: async () => "## fixture_status\nFixture ability reference." });
  await host.resolve();
  await host.start();
  return { host, definition };
}

async function copilot(options: { manual?: boolean; agents?: string[]; enabled?: boolean; tools?: string[] } = {}) {
  const { root, workspace, config } = base(options.manual ?? false);
  if (options.tools) config.agents[0]!.tools = options.tools;
  const { host: modules, definition } = await moduleHost(root,
    [entry("fixture", { agents: options.agents ?? ["synthetic-agent"], enabled: options.enabled ?? true })]);
  const session: Session = {
    id: randomUUID(), conversationId: randomUUID(), scope, agentId: "synthetic-agent", engine: "copilot", workspace,
    providerSessionId: null, appliedModel: "model-one", pendingModel: null, generation: 1, createdAt: Date.now(), updatedAt: Date.now(),
  };
  let settings: SessionConfig | undefined;
  const native = {
    sessionId: `densemble-${session.id}`, send: vi.fn(async () => "send-1"), abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined),
    rpc: { model: { getCurrent: vi.fn(async () => ({ modelId: "model-one" })) } },
  };
  const models: SdkModel[] = [{ id: "model-one", name: "model-one",
    capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 10000 } } }];
  const host: CopilotHost = {
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), onFailure: () => () => undefined,
    client: {
      ping: vi.fn(async () => ({ message: "ok", timestamp: new Date().toISOString() })), listModels: vi.fn(async () => models),
      createSession: vi.fn(async (value) => { settings = value; return native; }),
      resumeSession: vi.fn(async (_id, value) => { settings = value; return native; }), deleteSession: vi.fn(async () => undefined),
    },
  };
  const events: RuntimeEvent[] = [];
  const runtime = createCopilotRuntime({ config, diagnostics: { record: vi.fn() }, hostFactory: async () => host,
    abortGraceMs: 5, previewIntervalMs: 0, requestTimeoutMs: 200, modules });
  runtimes.push(runtime);
  const identity: RunIdentity = { scope, sessionId: session.id, runId: randomUUID(), generation: 1 };
  await runtime.open({ session, onEvent: (event) => events.push(event) });
  await runtime.execute({ kind: "send", identity, input: { text: "Synthetic", images: [], notices: [], attachmentIds: [] } });
  const config_ = settings!;
  const tool = (name: string) => config_.tools?.find((candidate) => candidate.name === name) as Tool | undefined;
  const pre = (toolName: string, toolArgs: unknown = {}) => config_.hooks!.onPreToolUse!({ sessionId: native.sessionId,
    timestamp: new Date(), workingDirectory: workspace, toolName, toolArgs }, { sessionId: native.sessionId });
  const invoke = (name: string, args: unknown) => tool(name)!.handler!(args,
    { sessionId: native.sessionId, toolCallId: "call-1", toolName: name, arguments: args });
  return { workspace, settings: config_, runtime, identity, events, tool, pre, invoke, definition, modules };
}

describe("module abilities in the Copilot engine", () => {
  it("gives an allowed agent the tools, the fixed tool-set names and the instructions", async () => {
    const f = await copilot();
    expect(f.settings.tools?.map((tool) => tool.name)).toEqual(
      ["densemble_export_file", "densemble_manage_proactivity", "densemble_state", "fixture_status", "fixture_publish"]);
    expect((f.settings.availableTools as ToolSet).toArray()).toEqual(expect.arrayContaining(
      ["custom:densemble_state", "custom:fixture_status", "custom:fixture_publish"]));
    const content = (f.settings.systemMessage as { content: string }).content;
    expect(content).toContain("You are chatting with Oleh in Telegram.");
    expect(content).toContain("# Densemble core\n");
    expect(content).toContain("# Module fixture v1.0.0\n## fixture_status\nFixture ability reference.");
    expect(f.tool("fixture_status")?.skipPermission).toBe(true);
    expect(f.tool("densemble_state")?.skipPermission).toBe(true);
    expect(f.tool("fixture_publish")?.skipPermission).toBeUndefined();
    expect(f.tool("fixture_publish")?.parameters).toMatchObject({ type: "object", required: ["target"] });
    expect(await f.invoke("fixture_status", {})).toEqual({ ok: true, status: "idle" });
    expect(readdirSync(f.workspace)).toEqual([]);
  });

  it.each([
    ["a disallowed agent", { agents: ["other-agent"] }],
    ["a disabled module", { enabled: false }],
  ])("gives %s only densemble_state and the core instructions", async (_label, options) => {
    const f = await copilot(options);
    expect(f.settings.tools?.map((tool) => tool.name)).toEqual(["densemble_export_file", "densemble_manage_proactivity", "densemble_state"]);
    const content = (f.settings.systemMessage as { content: string }).content;
    expect(content).toContain("# Densemble core\n");
    expect(content).not.toContain("# Module fixture");
  });

  it("adds allowed module tools to a launcher allowlist, which restricts built-in tools only", async () => {
    const f = await copilot({ tools: ["view"] });
    expect(f.settings.customAgents?.[0]?.tools).toEqual(["view", "densemble_state", "fixture_status", "fixture_publish"]);
  });

  it("asks in manual mode for a mutating module tool but not for a read-only one", async () => {
    const f = await copilot({ manual: true });
    expect(await f.pre("fixture_status")).toMatchObject({ permissionDecision: "allow" });
    expect(await f.pre("densemble_state")).toMatchObject({ permissionDecision: "allow" });
    expect(await f.pre("fixture_publish", { target: "draft" })).toEqual({ permissionDecision: "ask" });
    const permission = f.settings.onPermissionRequest!({ kind: "custom-tool", toolName: "fixture_publish", toolDescription: "Fixture publish.",
      toolCallId: "call-1", args: { target: "draft" } }, { sessionId: `densemble-${f.identity.sessionId}` });
    await until(() => f.events.some((event) => event.kind === "request"));
    const request = f.events.find((event) => event.kind === "request")!;
    if (request.kind !== "request") throw new Error("unreachable");
    await f.runtime.execute({ kind: "answer", identity: f.identity, requestId: request.requestId, answer: { kind: "permission", approved: true } });
    await expect(permission).resolves.toEqual({ kind: "approve-once" });
    expect(await f.invoke("fixture_publish", { target: "draft" })).toEqual({ ok: true, message: "Published to draft." });
  });

  it("returns the module's refusal for a forbidden request a skill asks for (SC-008)", async () => {
    const f = await copilot();
    expect(await f.invoke("fixture_publish", { target: "public" })).toEqual({ ok: false, code: "FIXTURE_NOT_ALLOWED",
      message: "Publishing publicly is not allowed." });
  });

  it("refuses a module tool once the turn is no longer live", async () => {
    const f = await copilot();
    await f.runtime.execute({ kind: "stop", identity: f.identity });
    expect(await f.invoke("fixture_status", {})).toMatchObject({ ok: false, code: "MODULE_NOT_PERMITTED" });
    expect(f.definition.calls).toEqual([]);
  });
});

type Fake = ClaudeHost & { options?: Options; handlers?: ClaudeHandlers };
async function claude(options: { manual?: boolean; agents?: string[]; owner?: boolean } = {}) {
  const { root, workspace, config } = base(options.manual ?? false);
  const { host: modules, definition } = await moduleHost(root, [entry("fixture", { agents: options.agents ?? ["synthetic-agent"] })]);
  const owner = options.owner ?? true;
  const userScope = owner ? scope : { ...scope, ownerId: 777, chatId: 777 };
  const sessionWorkspace = owner ? workspace : join(root, "guest");
  if (!owner) {
    mkdirSync(sessionWorkspace, { recursive: true });
    config.config.users = [{ telegramUserId: 777, displayName: "Guest", allowedBotIds: [scope.botId] }];
    config.config.workspaces = [{ id: "guest", name: "Guest", access: "private", ownerUserId: 777, path: sessionWorkspace,
      agentIds: ["synthetic-agent"] }];
  }
  const session: Session = {
    id: randomUUID(), conversationId: randomUUID(), scope: userScope, agentId: "synthetic-agent", engine: "claude-code", workspace: sessionWorkspace,
    providerSessionId: null, appliedModel: "claude-sonnet-5-5", pendingModel: null, generation: 1, createdAt: 0, updatedAt: 0,
  };
  const hosts: Fake[] = [];
  const factory = vi.fn(async (value: Options) => {
    const host: Fake = {
      options: value,
      start: vi.fn(async (handlers: ClaudeHandlers) => { host.handlers = handlers; return { version: CLAUDE_CODE_VERSION, authenticated: true,
        commands: [], models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" }] }; }),
      stop: vi.fn(async () => ({ forced: false })), onFailure: () => () => undefined, send: vi.fn(),
      interrupt: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined),
    };
    hosts.push(host);
    return host;
  });
  const events: RuntimeEvent[] = [];
  const runtime = createClaudeRuntime({ config, diagnostics: { record: vi.fn() }, hostFactory: factory, abortGraceMs: 20,
    previewIntervalMs: 0, requestTimeoutMs: 200, modules });
  runtimes.push(runtime);
  const identity: RunIdentity = { scope: userScope, sessionId: session.id, runId: randomUUID(), generation: 1 };
  await runtime.open({ session, onEvent: (event) => events.push(event), emptyHistory: true });
  await runtime.execute({ kind: "send", identity, input: { text: "Hello", images: [], attachmentIds: [], notices: [] } });
  const settings = hosts.at(-1)!.options!;
  const hook = async (tool_name: string, tool_input: unknown = {}) => {
    const callback = settings.hooks!.PreToolUse![0]!.hooks[0]! as HookCallback;
    const output = await callback({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: session.id,
      transcript_path: "", cwd: sessionWorkspace }, "t1", { signal: new AbortController().signal });
    return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  };
  // The SDK keeps registered tools on the in-process MCP server instance.
  const registered = () => (settings.mcpServers!.densemble as McpSdkServerConfigWithInstance).instance as unknown as
    { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }> };
  const invoke = async (name: string, args: unknown) =>
    JSON.parse((await registered()._registeredTools[name]!.handler(args, {})).content[0]!.text) as unknown;
  const names = () => Object.keys(registered()._registeredTools);
  return { settings, runtime, identity, events, hook, invoke, names, definition };
}

describe("module abilities in the Claude engine", () => {
  it("serves allowed module tools from the densemble MCP server with the instructions appended", async () => {
    const f = await claude();
    expect(f.names()).toEqual(["densemble_export_file", "densemble_manage_proactivity", "densemble_state", "fixture_status", "fixture_publish"]);
    const append = (f.settings.systemPrompt as { append: string }).append;
    expect(append).toContain("# Densemble core\n");
    expect(append).toContain("# Module fixture v1.0.0\n## fixture_status\nFixture ability reference.");
    expect(append).toContain("mcp__densemble__fixture_publish");
    expect(f.settings.tools).not.toContain("mcp__densemble__fixture_status");
    expect(await f.invoke("fixture_status", {})).toEqual({ ok: true, status: "idle" });
    expect(await f.invoke("fixture_publish", { target: "public" })).toEqual({ ok: false, code: "FIXTURE_NOT_ALLOWED",
      message: "Publishing publicly is not allowed." });
  });

  it("gives a disallowed agent neither the module tools nor the instructions", async () => {
    const f = await claude({ agents: ["other-agent"] });
    expect(f.names()).toEqual(["densemble_export_file", "densemble_manage_proactivity", "densemble_state"]);
    expect((f.settings.systemPrompt as { append: string }).append).not.toContain("# Module fixture");
    expect(await f.hook("mcp__densemble__fixture_status")).toBe("deny");
    expect(await f.hook("mcp__densemble__densemble_state")).toBe("allow");
  });

  it("shows a non-owner an empty module state and no module tools", async () => {
    const f = await claude({ owner: false });
    expect(f.names()).toEqual(["densemble_export_file", "densemble_manage_proactivity", "densemble_state"]);
    expect(await f.invoke("densemble_state", {})).toEqual({ ok: true, modules: [], note: "Module state is visible to the owner only." });
  });

  it("asks in manual mode for a mutating module tool but not for a read-only one", async () => {
    const f = await claude({ manual: true });
    expect(await f.hook("mcp__densemble__fixture_status")).toBe("allow");
    expect(await f.hook("mcp__densemble__densemble_state")).toBe("allow");
    expect(await f.hook("mcp__densemble__fixture_publish", { target: "draft" })).toBe("ask");
    const pending = f.settings.canUseTool!("mcp__densemble__fixture_publish", { target: "draft" },
      { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    await until(() => f.events.some((event) => event.kind === "request"));
    const request = f.events.find((event) => event.kind === "request")!;
    if (request.kind !== "request") throw new Error("unreachable");
    expect(request.payload).toMatchObject({ kind: "permission", action: "Викликати інструмент модуля" });
    await f.runtime.execute({ kind: "answer", identity: f.identity, requestId: request.requestId, answer: { kind: "permission", approved: false } });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    expect(f.definition.calls).toEqual([]);
  });
});
