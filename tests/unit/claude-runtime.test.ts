import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedConfig } from "../../src/config/index.js";
import type { RunIdentity, RuntimeEvent, Session } from "../../src/domain.js";
import { claudeDetached, claudeModels, claudeTools, createClaudeRuntime } from "../../src/agents/claude.js";
import type { ClaudeHandlers, ClaudeHost, ClaudeInit } from "../../src/agents/claude.js";
import { CLAUDE_CODE_VERSION } from "../../src/agents/claude-env.js";
import { createEngineRouter } from "../../src/agents/router.js";
import { DeletionJournal } from "../../src/application/deletion.js";
import type { ControlledRuntime } from "../../src/agents/contracts.js";
import { scope, until } from "./session-runtime-fixtures.js";

const roots: string[] = [];
const runtimes: ControlledRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Fake = ClaudeHost & { options?: Options; handlers?: ClaudeHandlers; sent: SDKUserMessage[] };
function setup(overrides: { init?: Partial<ClaudeInit>; manual?: boolean; skill?: boolean } = {}) {
  const root = resolve(".cache", `claude-unit-${randomUUID()}`);
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "claude-home");
  for (const path of [workspace, home, join(workspace, "skills")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(workspace, "AGENT.md"), "Synthetic persona instructions.");
  writeFileSync(join(workspace, "WORKER.md"), "Synthetic worker instructions.");
  writeFileSync(join(workspace, "AGENTS.md"), "Synthetic workspace rules.");
  if (overrides.skill) {
    mkdirSync(join(workspace, "skills", "demo"));
    writeFileSync(join(workspace, "skills", "demo", "SKILL.md"), "---\nname: demo-skill\ndescription: Demo\n---\nBody");
  }
  const config: LoadedConfig = {
    config: {
      workspacePath: workspace, agentDefinitionsPath: workspace, agentLaunchersPath: workspace,
      secretsPath: join(root, "secrets.local.json"), runtimeDataPath: root, runtimeHomePath: join(root, "copilot"),
      skillDirectories: [join(workspace, "skills")], ownerId: scope.ownerId, permissionMode: overrides.manual ? "manual" : "autopilot",
      claudeCode: { homePath: home, defaultModel: "claude-sonnet-5-5" },
      bots: [{ id: scope.botId, agentId: "synthetic-agent", tokenRef: "bot.token", engine: "claude-code" }],
      bindings: [{ botId: scope.botId, chatId: scope.chatId, topicId: null, kind: "private" }], mcp: { mode: "none" },
    },
    agents: [
      { id: "synthetic-agent", defaultModel: "copilot-model", description: "Persona", userInvocable: true,
        canonicalPath: join(workspace, "AGENT.md"), launcherPath: join(workspace, "AGENT.md") },
      { id: "synthetic-worker", defaultModel: "copilot-model", description: "Worker", userInvocable: false,
        canonicalPath: join(workspace, "WORKER.md"), launcherPath: join(workspace, "WORKER.md") },
    ],
    resolveSecret: () => "known-secret", tokenForBot: () => "123456:synthetic",
  };
  const session: Session = {
    id: randomUUID(), conversationId: randomUUID(), scope, agentId: "synthetic-agent", engine: "claude-code", workspace,
    providerSessionId: null, appliedModel: "claude-sonnet-5-5", pendingModel: null, generation: 1, createdAt: 0, updatedAt: 0,
  };
  const hosts: Fake[] = [];
  const init: ClaudeInit = {
    version: CLAUDE_CODE_VERSION, authenticated: true, commands: overrides.skill ? ["densemble:demo-skill"] : [],
    models: [{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" }],
    ...overrides.init,
  };
  const factory = vi.fn(async (options: Options) => {
    const host: Fake = {
      options, sent: [],
      start: vi.fn(async (handlers: ClaudeHandlers) => { host.handlers = handlers; return init; }),
      stop: vi.fn(async () => ({ forced: false })),
      onFailure: () => () => undefined,
      send: vi.fn((message: SDKUserMessage) => { host.sent.push(message); }),
      interrupt: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
    };
    hosts.push(host);
    return host;
  });
  const events: RuntimeEvent[] = [];
  const diagnostics = { record: vi.fn() };
  const runtime = createClaudeRuntime({ config, diagnostics, hostFactory: factory, abortGraceMs: 20, previewIntervalMs: 0, requestTimeoutMs: 200 });
  runtimes.push(runtime);
  const identity: RunIdentity = { scope, sessionId: session.id, runId: randomUUID(), generation: 1 };
  const open = (value: Partial<Session> = {}) => runtime.open({ session: { ...session, ...value }, onEvent: (event) => events.push(event),
    emptyHistory: true, proactivity: async () => ({ ok: true, action: "list", items: [], paused: false, message: "ok" }) });
  const send = () => runtime.execute({ kind: "send", identity, input: { text: "Hello", images: [], attachmentIds: [], notices: [] } });
  const message = (value: unknown) => hosts.at(-1)!.handlers!.message(value as SDKMessage);
  const hook = async (tool_name: string, tool_input: unknown) => {
    const callback = hosts.at(-1)!.options!.hooks!.PreToolUse![0]!.hooks[0]! as HookCallback;
    const output = await callback({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: session.id,
      transcript_path: "", cwd: workspace }, "t1", { signal: new AbortController().signal });
    return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  };
  return { root, workspace, home, config, session, hosts, factory, events, diagnostics, runtime, identity, open, send, message, hook };
}

describe("Claude Code runtime", () => {
  it("opens an isolated session with persona, workspace rules and only service tools", async () => {
    const { hosts, open, session, home, workspace } = setup({ skill: true });
    await expect(open()).resolves.toEqual({ providerSessionId: session.id });
    const options = hosts[0]!.options!;
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.cwd).toBe(workspace);
    expect(options.sessionId).toBe(session.id);
    expect(options.resume).toBeUndefined();
    expect(options.permissionMode).toBe("default");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(home);
    // The Keychain login is keyed by account name.
    expect(options.env?.USER).toBeTruthy();
    expect(Object.keys(options.env ?? {}).some((key) => /ANTHROPIC|TOKEN/.test(key))).toBe(false);
    expect(options.tools).not.toContain("AskUserQuestion");
    expect(options.disallowedTools).toContain("AskUserQuestion");
    expect(options.tools).toContain("Agent");
    expect(Object.keys(options.agents ?? {})).toEqual(["synthetic-worker"]);
    expect(options.skills).toEqual(["densemble:demo-skill"]);
    expect(existsSync(join(home, "densemble-plugin", "skills", "demo-skill", "SKILL.md"))).toBe(true);
    const prompt = options.systemPrompt as { append: string };
    expect(prompt.append).toContain("Synthetic persona instructions.");
    expect(prompt.append).toContain("Synthetic workspace rules.");
    expect(prompt.append).toContain("ask in plain text");
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["densemble"]);
  });
  it("never opens a Copilot session", async () => {
    const { open, factory } = setup();
    await expect(open({ engine: "copilot" })).rejects.toThrow("SESSION_ENGINE_MISMATCH");
    expect(factory).not.toHaveBeenCalled();
  });
  it("fails explicitly when logged out, the model is unavailable, the version differs or skills did not load", async () => {
    const cases: [Partial<ClaudeInit>, string][] = [[{ authenticated: false }, "CLAUDE_LOGIN_REQUIRED"], [{ version: "0.0.1" }, "RUNTIME_VERSION_MISMATCH"],
      [{ models: [{ value: "haiku", displayName: "Haiku" }] }, "MODEL_UNAVAILABLE"]];
    for (const [init, code] of cases) {
      const { open, hosts } = setup({ init });
      await expect(open()).rejects.toThrow(code);
      expect(hosts[0]!.stop).toHaveBeenCalled();
    }
    const { open } = setup({ skill: true, init: { commands: [] } });
    await expect(open()).rejects.toThrow("CLAUDE_SKILLS_UNAVAILABLE");
  });
  it("resumes existing history and refuses a non-empty session whose history is missing", async () => {
    const first = setup();
    mkdirSync(join(first.home, "projects", "p"), { recursive: true });
    writeFileSync(join(first.home, "projects", "p", `${first.session.id}.jsonl`), "{}");
    await first.open({ providerSessionId: first.session.id });
    expect(first.hosts[0]!.options!.resume).toBe(first.session.id);
    const second = setup();
    await expect(second.runtime.open({ session: { ...second.session, providerSessionId: second.session.id }, onEvent: () => undefined,
      emptyHistory: false })).rejects.toThrow("SESSION_HISTORY_MISSING");
  });
  it("streams root text into the preview and completes on the matching result", async () => {
    const { open, send, message, hosts, events } = setup();
    await open();
    await send();
    const uuid = hosts[0]!.sent[0]!.uuid;
    message({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
    message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } });
    message({ type: "stream_event", parent_tool_use_id: "sub", event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUB" } } });
    message({ type: "result", subtype: "success", is_error: false, result: "Hi there", user_message_uuid: uuid });
    expect(events.map((event) => event.kind)).toEqual(["delta", "completed"]);
    expect(events[0]).toMatchObject({ text: "Hi" });
    expect(events[1]).toMatchObject({ text: "Hi there" });
  });
  it("maps usage limits and login loss to fixed failure codes", async () => {
    const { open, send, message, events } = setup();
    await open();
    await send();
    message({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { content: [] } });
    message({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit" });
    expect(events.at(-1)).toMatchObject({ kind: "failed", code: "CLAUDE_USAGE_LIMIT" });
  });
  it("does not support steering, so new input stays queued", async () => {
    const { open, send, runtime, identity, session } = setup();
    await open();
    await send();
    expect(runtime.supportsSteering?.(session)).toBe(false);
    await expect(runtime.execute({ kind: "steer", identity, input: { text: "x", images: [], attachmentIds: [], notices: [] } }))
      .rejects.toThrow("STEERING_UNSUPPORTED");
  });
  it("denies detached, escalating, excluded and foreign-agent actions before permission", async () => {
    const { open, send, hook } = setup();
    await open();
    await send();
    expect(await hook("Bash", { command: "sleep 100 &" })).toBe("deny");
    expect(await hook("Bash", { command: "nohup sleep 100" })).toBe("deny");
    expect(await hook("Bash", { command: "ls", run_in_background: true })).toBe("deny");
    expect(await hook("Bash", { command: "ls", dangerouslyDisableSandbox: true })).toBe("deny");
    expect(await hook("AskUserQuestion", {})).toBe("deny");
    expect(await hook("CronCreate", {})).toBe("deny");
    expect(await hook("Agent", { subagent_type: "general-purpose", prompt: "x" })).toBe("deny");
    expect(await hook("Agent", { subagent_type: "synthetic-worker", prompt: "x" })).toBe("ask");
    expect(await hook("mcp__other__tool", {})).toBe("deny");
    expect(await hook("mcp__densemble__densemble_manage_proactivity", { action: "list" })).toBe("allow");
    expect(await hook("Bash", { command: "curl 'https://x/?a=1&b=2'" })).toBe("ask");
    // Even calls Claude Code would self-approve go to the service permission policy.
    expect(await hook("Read", { file_path: "notes.md" })).toBe("ask");
  });
  it("rejects tool calls that do not belong to a live turn", async () => {
    const { open, hook } = setup();
    await open();
    expect(await hook("Bash", { command: "ls" })).toBe("deny");
  });
  it("approves in autopilot and asks approve-once/reject in manual mode", async () => {
    const auto = setup();
    await auto.open();
    await auto.send();
    const allow = await auto.hosts[0]!.options!.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    expect(allow).toMatchObject({ behavior: "allow" });
    const manual = setup({ manual: true });
    await manual.open();
    await manual.send();
    const pending = manual.hosts[0]!.options!.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    await until(() => manual.events.some((event) => event.kind === "request"));
    const request = manual.events.find((event) => event.kind === "request")!;
    if (request.kind !== "request") throw new Error("unreachable");
    expect(request.payload).toMatchObject({ kind: "permission", action: "Виконати команду" });
    await manual.runtime.execute({ kind: "answer", identity: manual.identity, requestId: request.requestId, answer: { kind: "permission", approved: false } });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });
  it("stops by interrupting and then terminating the owned process tree", async () => {
    const { open, send, message, hosts, runtime, identity, events } = setup();
    await open();
    await send();
    const host = hosts[0]!;
    host.interrupt = vi.fn(async () => { message({ type: "result", subtype: "error_during_execution", is_error: true, user_message_uuid: host.sent[0]!.uuid }); });
    await runtime.execute({ kind: "stop", identity });
    expect(host.interrupt).toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ kind: "stopped", forced: false });
  });
  it("stops a turn whose message is still being prepared without ever sending it", async () => {
    const { open, runtime, identity, hosts, events, workspace } = setup();
    await open();
    writeFileSync(join(workspace, "photo.png"), "png");
    const sending = runtime.execute({ kind: "send", identity,
      input: { text: "x", images: [{ path: join(workspace, "photo.png"), mimeType: "image/png", displayName: "p" }], attachmentIds: [], notices: [] } });
    await runtime.execute({ kind: "stop", identity });
    await sending;
    expect(hosts[0]!.sent).toEqual([]);
    expect(hosts[0]!.interrupt).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ kind: "stopped", forced: false });
  });
  it("stops a host that finished starting after a concurrent close", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const original = f.factory.getMockImplementation()!;
    f.factory.mockImplementationOnce(async (options) => { await gate; return original(options); });
    const opening = f.open();
    await until(() => f.factory.mock.calls.length === 1);
    await f.runtime.disconnect(scope, f.session.id);
    release();
    await expect(opening).rejects.toThrow();
    expect(f.hosts[0]!.stop).toHaveBeenCalled();
  });
  it("reports a forced stop when the turn does not end cooperatively", async () => {
    const { open, send, hosts, runtime, identity, events } = setup();
    await open();
    await send();
    await runtime.execute({ kind: "stop", identity });
    expect(hosts[0]!.stop).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ kind: "stopped", forced: true });
  });
  it("fails the turn when the engine process disappears", async () => {
    const { open, send, hosts, events } = setup();
    await open();
    await send();
    hosts[0]!.handlers!.end();
    await until(() => events.some((event) => event.kind === "failed"));
    expect(events.at(-1)).toMatchObject({ kind: "failed", code: "RUNTIME_CONNECTION_LOST" });
  });
  it("lists deduplicated models and switches only at a turn boundary", async () => {
    const { open, runtime, session, hosts, send } = setup();
    await open();
    expect(await runtime.models(scope, session.id)).toEqual([
      { id: "claude-opus-5-5", name: "Default", supportsImages: true }, { id: "claude-sonnet-5-5", name: "Sonnet", supportsImages: true }]);
    await runtime.setModel(scope, session.id, "claude-opus-5-5");
    expect(hosts[0]!.setModel).toHaveBeenCalledWith("claude-opus-5-5");
    await send();
    await expect(runtime.setModel(scope, session.id, "claude-sonnet-5-5")).rejects.toThrow("MODEL_BOUNDARY_REQUIRED");
  });
  it("deletes only the session's own transcript", async () => {
    const { home, runtime, session } = setup();
    const project = join(home, "projects", "p");
    mkdirSync(join(project, session.id), { recursive: true });
    writeFileSync(join(project, `${session.id}.jsonl`), "{}");
    const other = randomUUID();
    writeFileSync(join(project, `${other}.jsonl`), "{}");
    for (const path of ["file-history", "session-env", "debug", "todos"]) mkdirSync(join(home, path), { recursive: true });
    mkdirSync(join(home, "file-history", session.id));
    writeFileSync(join(home, "debug", `${session.id}.txt`), "x");
    writeFileSync(join(home, "todos", `${session.id}-agent-${session.id}.json`), "[]");
    writeFileSync(join(home, "todos", `${other}-agent-${other}.json`), "[]");
    await runtime.deleteSession(scope, session.id, session.id);
    expect(existsSync(join(project, `${session.id}.jsonl`))).toBe(false);
    expect(existsSync(join(project, session.id))).toBe(false);
    expect(existsSync(join(project, `${other}.jsonl`))).toBe(true);
    expect(existsSync(join(home, "file-history", session.id))).toBe(false);
    expect(existsSync(join(home, "debug", `${session.id}.txt`))).toBe(false);
    expect(existsSync(join(home, "todos", `${session.id}-agent-${session.id}.json`))).toBe(false);
    expect(existsSync(join(home, "todos", `${other}-agent-${other}.json`))).toBe(true);
    await expect(runtime.deleteSession(scope, session.id, `densemble-${session.id}`)).rejects.toThrow("UNOWNED_PROVIDER_SESSION");
  });
});

describe("Claude Code non-owner boundary", () => {
  it("omits skills and MCP, and refuses out-of-workspace or foreign-path actions", async () => {
    const f = setup({ skill: true });
    const guest = { ...scope, ownerId: 202, chatId: 202 };
    // Validated configs keep workspaces disjoint from runtime data, so the shared workspace is a sibling.
    const shared = resolve(".cache", `claude-shared-${randomUUID()}`);
    roots.push(shared);
    mkdirSync(shared, { recursive: true });
    f.config.config.users = [{ telegramUserId: 202, displayName: "Guest", allowedBotIds: [scope.botId] }];
    f.config.config.workspaces = [{ id: "shared", name: "Shared", access: "shared", ownerUserId: scope.ownerId,
      memberUserIds: [202], path: shared, agentIds: ["synthetic-agent"] }];
    const identity = { ...f.identity, scope: guest };
    await f.runtime.open({ session: { ...f.session, scope: guest, workspace: shared }, onEvent: () => undefined, emptyHistory: true });
    const options = f.hosts[0]!.options!;
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect((options.systemPrompt as { append: string }).append).toContain("Work only inside the current workspace directory");
    await f.runtime.execute({ kind: "send", identity, input: { text: "x", images: [], attachmentIds: [], notices: [] } });
    const ask = (input: Record<string, unknown>, blockedPath?: string) => options.canUseTool!("Read", input,
      { signal: new AbortController().signal, toolUseID: "t", requestId: "r", ...(blockedPath ? { blockedPath } : {}) });
    await expect(ask({ file_path: join(shared, "a.md") })).resolves.toMatchObject({ behavior: "allow" });
    await expect(ask({ file_path: "/etc/hosts" }, "/etc/hosts")).resolves.toMatchObject({ behavior: "deny" });
    await expect(ask({ file_path: join(f.workspace, "AGENTS.md") })).resolves.toMatchObject({ behavior: "deny" });
    await expect(ask({ file_path: "../secret" })).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("Claude Code helpers", () => {
  it("maps launcher tools and fails on unknown capabilities", () => {
    expect(claudeTools(["bash", "view", "edit", "ask_user", "task"], new Map())).toEqual(["Bash", "Read", "Edit", "Agent"]);
    expect(() => claudeTools(["teleport"], new Map())).toThrow("AGENT_TOOL_UNSUPPORTED");
    expect(claudeTools(["srv-run"], new Map([["srv-run", "mcp__srv__run"]]))).toEqual(["mcp__srv__run"]);
  });
  it("treats background and sandbox-escaping calls as detached", () => {
    expect(claudeDetached("Agent", { run_in_background: true })).toBe(true);
    expect(claudeDetached("Bash", { command: "echo a && echo b" })).toBe(false);
    expect(claudeModels({ models: [{ value: "x", displayName: "X" }] })).toEqual([{ id: "x", name: "X", supportsImages: true }]);
  });
});

describe("engine router", () => {
  function fakeRuntime(name: string, calls: string[]): ControlledRuntime {
    return {
      recoverOwnedProcesses: async () => undefined,
      open: async ({ session }) => { calls.push(`${name}:open`); return { providerSessionId: session.id }; },
      execute: async (command) => { calls.push(`${name}:${command.kind}`); },
      setModel: async () => { calls.push(`${name}:setModel`); },
      models: async () => { calls.push(`${name}:models`); return []; },
      disconnect: async () => { calls.push(`${name}:disconnect`); },
      deleteSession: async () => { calls.push(`${name}:delete`); },
      shutdown: async () => { calls.push(`${name}:shutdown`); },
    };
  }
  it("routes every call by the session's recorded engine", async () => {
    const calls: string[] = [];
    const engines = new Map<string, "copilot" | "claude-code">();
    const router = createEngineRouter({
      engines: { copilot: fakeRuntime("copilot", calls), "claude-code": fakeRuntime("claude", calls) },
      sessionEngine: (_scope, id) => engines.get(id), recoverOwnedProcesses: async () => undefined,
    });
    const base = setup().session;
    engines.set(base.id, "claude-code");
    await router.open({ session: base, onEvent: () => undefined });
    await router.models(scope, base.id);
    await router.deleteSession(scope, base.id, base.id, "claude-code");
    await router.deleteSession(scope, base.id, `densemble-${base.id}`);
    await router.execute({ kind: "stop", identity: { scope, sessionId: "unknown", runId: "r", generation: 1 } });
    expect(calls).toEqual(["claude:open", "claude:models", "claude:delete", "copilot:delete", "copilot:stop", "claude:stop"]);
  });
  it("fails explicitly for an engine that is not configured, without falling back", async () => {
    const calls: string[] = [];
    const router = createEngineRouter({ engines: { copilot: fakeRuntime("copilot", calls) },
      sessionEngine: () => undefined, recoverOwnedProcesses: async () => undefined });
    await expect(router.open({ session: setup().session, onEvent: () => undefined })).rejects.toThrow("CLAUDE_CODE_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });
});

describe("deletion journal engines", () => {
  it("keeps the engine of a pending deletion and validates its provider ownership", async () => {
    const { root, session } = setup();
    const journal = new DeletionJournal(root);
    const intent = { scope, sessionId: session.id, providerSessionId: session.id, artifacts: [], engine: "claude-code" as const };
    await journal.save(intent);
    expect(await journal.pending()).toEqual([intent]);
    await journal.remove(intent);
    await expect(journal.save({ ...intent, providerSessionId: `densemble-${session.id}` })).rejects.toThrow("DELETION_JOURNAL_INVALID");
    await expect(journal.save({ ...intent, engine: undefined, providerSessionId: session.id })).rejects.toThrow("DELETION_JOURNAL_INVALID");
  });
});
