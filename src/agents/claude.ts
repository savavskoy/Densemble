import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createSdkMcpServer, query, tool, USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition as SdkAgent, CanUseTool, HookCallback, McpServerConfig, Options, Query, SDKAssistantMessageError,
  SDKControlInitializeResponse, SDKMessage, SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { authorizedWorkspace, DEFAULT_WORKSPACE_ID, type AgentDefinition, type LoadedConfig } from "../config/index.js";
import type { ModelInfo, RequestAnswer, RequestPayload, RunIdentity, RuntimeCommand, RuntimeEvent, Scope, Session } from "../domain.js";
import { scopeKey } from "../domain.js";
import type { DiagnosticSink } from "../ports.js";
import { opaqueId, sanitizeParameters } from "../permissions/index.js";
import type { ControlledRuntime, ControlledSessionOptions, ProactivityRequest } from "./contracts.js";
import { bounded, RuntimeError } from "./contracts.js";
import {
  CLAUDE_CODE_VERSION, claudeEnvironment, claudeHistory, claudeHome, claudeTranscripts, pinnedClaudePath, pluginName, serviceSkills,
  workspaceInstructions, writeServicePlugin,
} from "./claude-env.js";
import type { ServiceSkill } from "./claude-env.js";
import { detachedAction, proactivityRequestSchema } from "./copilot.js";
import { ProcessSupervisor } from "./supervisor.js";
import type { ProcessFailure } from "./supervisor.js";
import { workspaceViolation } from "./workspace-guard.js";

// The Claude Code equivalents of the Copilot built-in tool set; nothing else is exposed.
const baseTools = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "WebFetch", "TodoWrite"];
const copilotToolNames: Record<string, string> = {
  bash: "Bash", read_bash: "Bash", stop_bash: "Bash", list_bash: "Bash", view: "Read", glob: "Glob", grep: "Grep", rg: "Grep",
  edit: "Edit", apply_patch: "Edit", create: "Write", skill: "Skill", task: "Agent", read_agent: "Agent", write_agent: "Agent",
  list_agents: "Agent", web_fetch: "WebFetch", report_intent: "TodoWrite",
};
// Copilot exclusions that have no Claude counterpart are simply never exposed.
const copilotExcluded = ["ask_user", "store_memory", "session_store", "session_store_sql", "session_history", "search_sessions"];
// Clarification is a normal completed turn, never a structured form; background/scheduling tools escape /stop.
const disallowedTools = ["AskUserQuestion", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Monitor",
  "EnterWorktree", "ExitWorktree", "PushNotification", "RemoteTrigger", "SendUserMessage", "SendUserFile"];
const exportTool = "mcp__densemble__densemble_export_file";
const proactivityTool = "mcp__densemble__densemble_manage_proactivity";
const permissionNames: Record<string, string> = {
  Bash: "Виконати команду", Read: "Прочитати файл", Edit: "Змінити файл", Write: "Змінити файл", NotebookEdit: "Змінити файл",
  WebFetch: "Відкрити мережевий ресурс", [exportTool]: "Викликати інструмент сервісу",
};
const errorCodes: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: "CLAUDE_LOGIN_REQUIRED", oauth_org_not_allowed: "CLAUDE_LOGIN_REQUIRED",
  verification_required: "CLAUDE_LOGIN_REQUIRED", account_on_hold: "CLAUDE_ACCOUNT_UNAVAILABLE",
  billing_error: "CLAUDE_USAGE_LIMIT", rate_limit: "CLAUDE_USAGE_LIMIT", overloaded: "CLAUDE_OVERLOADED",
  model_not_found: "MODEL_UNAVAILABLE", server_error: "CLAUDE_SERVICE_ERROR",
};

export interface ClaudeInit {
  version: string | undefined;
  models: { value: string; resolvedModel?: string | undefined; displayName: string }[];
  commands: string[];
  authenticated: boolean;
}
export interface ClaudeHandlers { message(message: SDKMessage): void; end(): void }
/** One supervised Claude Code process serving one streaming-input query. */
export interface ClaudeHost {
  start(handlers: ClaudeHandlers): Promise<ClaudeInit>;
  stop(): Promise<{ forced: boolean } | void>;
  onFailure(handler: (code: ProcessFailure) => void): () => void;
  send(message: SDKUserMessage): void;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
}
export type ClaudeHostFactory = (options: Options) => Promise<ClaudeHost>;
export interface ClaudeRuntimeOptions {
  config: LoadedConfig;
  diagnostics: DiagnosticSink;
  hostFactory?: ClaudeHostFactory;
  abortGraceMs?: number;
  requestTimeoutMs?: number;
  previewIntervalMs?: number;
  catalogTtlMs?: number;
}
type Waiting = { identity: RunIdentity; payload: RequestPayload; resolve: (answer: RequestAnswer | null) => void };
type Turn = {
  identity: RunIdentity; uuid: string; controller: AbortController; preview: string; lastPreview: number;
  terminal: boolean; cancelling: boolean; resulted: boolean; sent: boolean; errorCode?: string; stopping?: Promise<void>;
};
type Slot = {
  sessionId: string; scope: Scope; host?: ClaudeHost; stoppedHost?: ClaudeHost | undefined; init?: ClaudeInit; opening?: Promise<{ providerSessionId: string }>;
  options?: ControlledSessionOptions; turn?: Turn; requests: Map<string, Waiting>; exportGrants: Set<string>;
  closing: boolean; switching: boolean; closed?: Promise<void>; forcedClose: boolean; unsubscribe?: () => void;
};

export function authenticated(account: SDKControlInitializeResponse["account"] | undefined): boolean {
  return Boolean(account && ((account.tokenSource && account.tokenSource !== "none") || account.subscriptionType || account.email));
}
function toInit(response: SDKControlInitializeResponse): ClaudeInit {
  return {
    version: response.claude_code_version, commands: response.commands.map((command) => command.name),
    models: response.models.map((model) => ({ value: model.value, resolvedModel: model.resolvedModel, displayName: model.displayName })),
    authenticated: authenticated(response.account),
  };
}
export function claudeModels(init: Pick<ClaudeInit, "models">): ModelInfo[] {
  const result: ModelInfo[] = [];
  for (const model of init.models) {
    const id = model.resolvedModel ?? model.value;
    if (!result.some((entry) => entry.id === id)) result.push({ id, name: model.displayName, supportsImages: true });
  }
  return result;
}
function modelAvailable(init: Pick<ClaudeInit, "models">, model: string): boolean {
  return init.models.some((entry) => entry.value === model || entry.resolvedModel === model);
}

/** Map launcher tool names (Copilot vocabulary) to Claude Code; an unknown capability fails explicitly. */
export function claudeTools(tools: string[], mcpTools: Map<string, string>): string[] {
  const result = new Set<string>();
  for (const name of tools) {
    if (copilotExcluded.includes(name)) continue;
    const mapped = copilotToolNames[name] ?? mcpTools.get(name) ??
      (name === "densemble_export_file" ? exportTool : name === "densemble_manage_proactivity" ? proactivityTool : undefined);
    if (!mapped) throw new RuntimeError("AGENT_TOOL_UNSUPPORTED");
    result.add(mapped);
  }
  return [...result];
}

/** A detached or sandbox-escalating action could outlive /stop or the guard; it is never admitted. */
export function claudeDetached(tool: string, input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const values = input as Record<string, unknown>;
  if (values.run_in_background === true || values.dangerouslyDisableSandbox === true) return true;
  return tool === "Bash" && detachedAction("bash", { command: values.command });
}

function inputQueue(): { iterable: AsyncIterable<SDKUserMessage>; push(message: SDKUserMessage): void; end(): void } {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* iterate(): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      while (items.length) yield items.shift()!;
      if (ended) return;
      await new Promise<void>((done) => { wake = done; });
      wake = undefined;
    }
  }
  return { iterable: iterate(), push(message) { items.push(message); wake?.(); }, end() { ended = true; wake?.(); } };
}

/** The production host: the pinned native binary under the same process-tree supervisor as Copilot. */
export function supervisedClaudeHost(config: LoadedConfig, diagnostics: DiagnosticSink): ClaudeHostFactory {
  return async (options) => {
    const cli = await pinnedClaudePath();
    const scratch = join(config.config.runtimeDataPath, "scratch");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    if (await realpath(scratch) !== scratch) throw new RuntimeError("RUNTIME_SCRATCH_UNSAFE");
    const supervisor = new ProcessSupervisor(config.config.runtimeDataPath, cli, diagnostics);
    const input = inputQueue();
    let running: Query | undefined;
    let stopping = false;
    return {
      async start(handlers) {
        let init: SDKControlInitializeResponse | undefined;
        await supervisor.start(async () => {
          const active = query({ prompt: input.iterable, options: { ...options, pathToClaudeCodeExecutable: cli } });
          running = active;
          void (async () => {
            try { for await (const message of active) handlers.message(message); }
            catch { if (!stopping) diagnostics.record("CLAUDE_STREAM_FAILED"); }
            finally { handlers.end(); }
          })();
          init = await active.initializationResult();
        });
        return toInit(init!);
      },
      onFailure: (handler) => supervisor.onFailure(handler),
      send: (message) => input.push(message),
      async interrupt() { await running?.interrupt(); },
      async setModel(model) {
        if (!running) throw new RuntimeError("RUNTIME_SESSION_NOT_READY");
        await running.setModel(model);
      },
      async stop() {
        let forced = true;
        try { forced = await supervisor.hasLiveDescendants(); }
        catch { diagnostics.record("PROCESS_OBSERVATION_FAILED"); }
        stopping = true;
        await supervisor.stop(async () => { input.end(); running?.close(); });
        return { forced };
      },
    };
  };
}

function userLabel(displayName: string | undefined): string {
  const name = displayName?.replace(/\s+/g, " ").trim();
  return name ? `${name} (a configured user)` : "a user";
}
/** Options for a model/readiness catalog process: no workspace, tools, history or MCP. */
export function catalogOptions(config: LoadedConfig): Options {
  return {
    cwd: join(config.config.runtimeDataPath, "scratch"), settingSources: [], strictMcpConfig: true, plugins: [], skills: [],
    tools: [], persistSession: false, permissionMode: "default", env: claudeEnvironment(config), stderr: () => undefined,
    canUseTool: async () => ({ behavior: "deny", message: "Каталог моделей не виконує дій." }),
  };
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions): ControlledRuntime {
  const { config, diagnostics } = options;
  const hostFactory = options.hostFactory ?? supervisedClaudeHost(config, diagnostics);
  const slots = new Map<string, Slot>();
  const probes = new Set<ClaudeHost>();
  let shuttingDown = false;
  let catalog: { at: number; models: ModelInfo[] } | undefined;
  let skills: Promise<{ plugin: string | null; skills: ServiceSkill[] }> | undefined;
  const secrets: string[] = [];
  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpTools = new Map<string, string>();
  if (config.config.mcp.mode === "allowlist") {
    for (const declaration of config.config.mcp.servers) {
      const secret = (reference: string): string => {
        const value = config.resolveSecret(reference); secrets.push(value); return value;
      };
      for (const name of declaration.tools) {
        if (name === "*" || copilotExcluded.includes(name)) throw new RuntimeError("MCP_TOOL_ALLOWLIST_REQUIRED");
        mcpTools.set(`${declaration.name}-${name}`, `mcp__${declaration.name}__${name}`);
      }
      if (declaration.type === "stdio") {
        // Claude Code starts stdio servers in the session directory; a different cwd cannot be honoured.
        if (declaration.cwd && declaration.cwd !== config.config.workspacePath) throw new RuntimeError("MCP_CWD_UNSUPPORTED");
        mcpServers[declaration.name] = { type: "stdio", command: declaration.command,
          args: declaration.args.map((arg) => typeof arg === "string" ? arg : secret(arg.secretRef)),
          env: Object.fromEntries(Object.entries(declaration.env).map(([key, value]) => [key, secret(value.secretRef)])) };
      } else {
        mcpServers[declaration.name] = { type: "http", url: declaration.url,
          headers: Object.fromEntries(Object.entries(declaration.headers).map(([key, value]) => [key, secret(value.secretRef)])) };
      }
    }
  }
  const allowedMcp = new Set(mcpTools.values());

  function preparedSkills(): Promise<{ plugin: string | null; skills: ServiceSkill[] }> {
    // Regenerated once per service start; skill content itself is read live through the symlinks.
    skills ??= (async () => {
      const found = await serviceSkills(config);
      return { plugin: found.length ? await writeServicePlugin(config, found) : null, skills: found };
    })();
    void skills.catch(() => { skills = undefined; });
    return skills;
  }
  function slotFor(scope: Scope, sessionId: string): Slot {
    if (shuttingDown) throw new RuntimeError("RUNTIME_SHUTTING_DOWN");
    const key = scopeKey(scope);
    const existing = slots.get(key);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.closing) throw new RuntimeError("RUNTIME_SCOPE_BUSY");
      return existing;
    }
    const slot: Slot = { scope, sessionId, requests: new Map(), exportGrants: new Set(), closing: false, switching: false, forcedClose: false };
    slots.set(key, slot);
    return slot;
  }
  function live(slot: Slot, turn: Turn): boolean {
    return !shuttingDown && !slot.closing && slot.turn === turn && !turn.terminal && !turn.cancelling &&
      !turn.controller.signal.aborted && !slot.options?.signal?.aborted;
  }
  function emit(slot: Slot, event: RuntimeEvent): void {
    try { slot.options?.onEvent(event); } catch { diagnostics.record("RUNTIME_EVENT_HANDLER_FAILED"); }
  }
  function revoke(slot: Slot): void {
    for (const wait of slot.requests.values()) wait.resolve(null);
    slot.requests.clear();
    slot.exportGrants.clear();
  }
  function loseRuntime(slot: Slot, code: ProcessFailure | "RUNTIME_CONNECTION_LOST" | "RUNTIME_VERSION_MISMATCH"): void {
    if (slot.closing || shuttingDown) return;
    slot.closing = true;
    revoke(slot);
    const turn = slot.turn;
    turn?.controller.abort();
    const closing = close(slot);
    if (turn && !turn.terminal) {
      turn.terminal = true;
      emit(slot, { ...turn.identity, kind: "failed", code: turn.errorCode ?? code });
    }
    diagnostics.record(code);
    void closing.catch(() => diagnostics.record("RUNTIME_LOSS_CLEANUP_FAILED"));
  }
  function onMessage(slot: Slot, message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") {
      if (message.claude_code_version !== CLAUDE_CODE_VERSION) loseRuntime(slot, "RUNTIME_VERSION_MISMATCH");
      return;
    }
    const turn = slot.turn;
    if (!turn || turn.terminal) return;
    switch (message.type) {
      case "stream_event": {
        if (message.parent_tool_use_id || !live(slot, turn)) return;
        const event = message.event;
        if (event.type === "message_start") { turn.preview = ""; turn.lastPreview = 0; }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          turn.preview += event.delta.text;
          if (Date.now() - turn.lastPreview >= (options.previewIntervalMs ?? 750)) {
            turn.lastPreview = Date.now();
            emit(slot, { ...turn.identity, kind: "delta", text: turn.preview });
          }
        }
        return;
      }
      case "assistant":
        if (!message.parent_tool_use_id && message.error) turn.errorCode ??= errorCodes[message.error] ?? "CLAUDE_SERVICE_ERROR";
        return;
      case "rate_limit_event":
        if (message.rate_limit_info.status === "rejected") turn.errorCode ??= "CLAUDE_USAGE_LIMIT";
        return;
      case "auth_status":
        if (message.error) turn.errorCode ??= "CLAUDE_LOGIN_REQUIRED";
        return;
      case "result": {
        if (message.user_message_uuid && message.user_message_uuid !== turn.uuid &&
            !message.user_message_uuids?.includes(turn.uuid)) return;
        turn.resulted = true;
        if (!live(slot, turn)) return;
        turn.terminal = true;
        revoke(slot);
        const text = message.subtype === "success" ? message.result : "";
        if (USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix))) turn.errorCode ??= "CLAUDE_USAGE_LIMIT";
        if (message.subtype !== "success" || message.is_error || turn.errorCode || !text.trim()) {
          emit(slot, { ...turn.identity, kind: "failed", code: turn.errorCode ?? "RUNTIME_TURN_FAILED" });
        } else emit(slot, { ...turn.identity, kind: "completed", text });
        return;
      }
      default: return;
    }
  }
  async function request(slot: Slot, payload: RequestPayload): Promise<RequestAnswer | null> {
    const turn = slot.turn;
    if (!turn || !live(slot, turn)) return null;
    const id = opaqueId();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<RequestAnswer | null>((resolveAnswer) => {
        const resolve = (answer: RequestAnswer | null) => { clearTimeout(timer); slot.requests.delete(id); resolveAnswer(answer); };
        slot.requests.set(id, { identity: turn.identity, payload, resolve });
        timer = setTimeout(() => resolve(null), options.requestTimeoutMs ?? 10 * 60_000);
        emit(slot, { ...turn.identity, kind: "request", requestId: id, payload });
      });
    } finally { clearTimeout(timer); }
  }
  async function sessionOptions(slot: Slot, supplied: ControlledSessionOptions, resume: boolean): Promise<{ settings: Options; expected: string[] }> {
    const session = supplied.session;
    const user = session.scope.ownerId;
    const owner = user === config.config.ownerId;
    const match = authorizedWorkspace(config.config, user, session.scope.botId, session.workspace);
    if (!match) throw new RuntimeError("WORKSPACE_ACCESS_DENIED");
    const agents = match === DEFAULT_WORKSPACE_ID ? config.agents : config.agents.filter((agent) => match.agentIds.includes(agent.id));
    const main = agents.find((agent) => agent.id === session.agentId);
    if (!main) throw new RuntimeError("RUNTIME_AGENT_MISSING");
    const forbiddenRoots = owner ? [] : [
      config.config.workspacePath, config.config.runtimeDataPath, config.config.runtimeHomePath, config.config.secretsPath,
      config.config.interactiveHomePath ?? "", claudeHome(config), resolve(homedir(), ".claude"),
      ...(config.config.workspaces ?? []).map((entry) => entry.path),
    ].filter((path) => Boolean(path) && path !== session.workspace);
    const prompt = async (agent: AgentDefinition) =>
      `Source: ${relative(session.workspace, agent.canonicalPath)}\n${await readFile(agent.canonicalPath, "utf8")}`;
    const subagents: Record<string, SdkAgent> = {};
    for (const agent of agents.filter((entry) => entry.id !== session.agentId)) {
      subagents[agent.id] = { description: agent.description, prompt: await prompt(agent), model: "inherit",
        ...(agent.tools ? { tools: claudeTools(agent.tools, mcpTools) } : {}) };
    }
    const available = [...baseTools, ...(Object.keys(subagents).length ? ["Agent"] : [])];
    const tools = main.tools ? claudeTools(main.tools, mcpTools).filter((name) => available.includes(name)) : available;
    const service = owner ? await preparedSkills() : { plugin: null, skills: [] };
    const expected = service.skills.map((skill) => `${pluginName}:${skill.name}`);
    const instructions = await workspaceInstructions(session.workspace);
    const telegram = owner
      ? "You are chatting with Oleh in Telegram. Do not use structured question forms. " +
        "If you need clarification, ask in plain text, one question at a time, then end your turn and wait for his reply."
      : `You are chatting with ${userLabel(config.config.users?.find((entry) => entry.telegramUserId === user)?.displayName)} in Telegram. ` +
        "Do not use structured question forms. " +
        "If you need clarification, ask in plain text, one question at a time, then end your turn and wait for their reply. " +
        "Work only inside the current workspace directory; never read, list or modify anything outside it, including repository metadata.";
    const append = [
      `# Persona: ${main.id}\nYou are this agent for the whole conversation.\n${await prompt(main)}`,
      ...instructions.map((entry) => `# Workspace instructions\nSource: ${entry.source}\n${entry.text}`),
      `# Densemble service\n${telegram}\n` +
        "Densemble tools are provided by the `densemble` MCP server: `densemble_manage_proactivity` " +
        `(${proactivityTool}) manages your own reminders and check-ins; \`densemble_export_file\` (${exportTool}) ` +
        "returns a generated workspace file to this chat. A path mentioned in text is not an export.",
    ].join("\n\n");
    const deny = (code: string, reason: string) => {
      diagnostics.record(code);
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
    };
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const turn = slot.turn;
      if (!turn || !live(slot, turn) || input.session_id !== session.id) {
        return deny("TOOL_STALE_RUN_REJECTED", "Дія не належить живому керованому виконанню.");
      }
      if (!owner && workspaceViolation(input.tool_input, forbiddenRoots)) {
        return deny("TOOL_WORKSPACE_BOUNDARY_REJECTED", "Дія виходить за межі поточного workspace.");
      }
      if (claudeDetached(input.tool_name, input.tool_input)) {
        return deny("TOOL_DETACHED_ACTION_REJECTED", "Запуск відокремленого процесу заборонено: /stop має зупиняти всю роботу.");
      }
      const name = input.tool_name === "Task" ? "Agent" : input.tool_name;
      const known = tools.includes(name) || name === exportTool || name === proactivityTool || (owner && allowedMcp.has(name));
      if (!known) return deny("TOOL_EXCLUDED_REJECTED", "Цей інструмент вимкнений у керованому сервісі.");
      if (name === "Agent") {
        const type = (input.tool_input as { subagent_type?: unknown } | null)?.subagent_type;
        if (typeof type !== "string" || !Object.hasOwn(subagents, type)) {
          return deny("TOOL_EXCLUDED_REJECTED", "Доступні лише агенти команди Densemble.");
        }
      }
      if (name === proactivityTool) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
          permissionDecisionReason: "Дозволений інструмент управління нагадуваннями Densemble." } };
      }
      // Never let Claude Code self-approve (e.g. reads or read-only shell): the service policy decides every call.
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
    };
    const canUseTool: CanUseTool = async (name, input, context) => {
      const refuse = { behavior: "deny" as const, message: "Дію відхилено керованим сервісом." };
      const turn = slot.turn;
      // Claude Code reports a path outside the working directory as `blockedPath`; non-owners never get it approved.
      if (!turn || !live(slot, turn) || JSON.stringify(input).length > 12_000 || claudeDetached(name, input) ||
          (!owner && (context.blockedPath !== undefined || workspaceViolation(input, forbiddenRoots)))) return refuse;
      if (config.config.permissionMode === "manual") {
        const answer = await request(slot, { kind: "permission", action: permissionNames[name] ?? "Зовнішня дія",
          parameters: sanitizeParameters({ tool: name, ...input }, secrets) });
        if (answer?.kind !== "permission" || !answer.approved) return refuse;
      }
      if (!live(slot, turn)) return refuse;
      if (name === exportTool) {
        if (typeof input.path !== "string") return refuse;
        slot.exportGrants.add(input.path);
      }
      return { behavior: "allow", updatedInput: input };
    };
    const scheduleShape = z.union([
      z.object({ type: z.literal("once"), at: z.number().int().nonnegative() }).strict(),
      z.object({ type: z.literal("interval"), everyMs: z.number().int().positive() }).strict(),
      z.object({ type: z.literal("weekly"), daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
        hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
      z.object({ type: z.literal("monthly"), daysOfMonth: z.array(z.number().int().min(1).max(31)).min(1),
        hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
    ]);
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    const densemble = createSdkMcpServer({ name: "densemble", version: "1.0.0", alwaysLoad: true, tools: [
      tool("densemble_export_file",
        "Return a generated workspace file to this conversation under the configured permission policy. A path mentioned in text is not an export.",
        { path: z.string().min(1).describe("Absolute path or a path relative to the configured workspace.") },
        async (args) => {
          const turn = slot.turn;
          const exportFile = slot.options?.exportFile;
          if (!turn || !live(slot, turn) || !exportFile || !slot.exportGrants.delete(args.path)) throw new RuntimeError("EXPORT_NOT_AUTHORIZED");
          const attachment = await exportFile(turn.identity, args.path, turn.controller.signal);
          if (!live(slot, turn)) throw new RuntimeError("EXPORT_CANCELLED");
          return result({ status: "prepared_for_delivery", fileName: attachment.fileName });
        }),
      tool("densemble_manage_proactivity",
        "Manage this agent's own proactive reminders and check-ins for the current chat scope. Returns a result object with `ok`, `code`, and `message`; if `ok` is false, relay the `message` to Oleh.",
        { action: z.enum(["schedule", "list", "cancel", "pause", "resume"]), kind: z.enum(["oneoff", "recurring", "silent"]).optional(),
          schedule: scheduleShape.optional(), purpose: z.string().min(1).optional(), id: z.string().min(1).optional() },
        async (args) => {
          const turn = slot.turn;
          const parsed = proactivityRequestSchema.safeParse(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)));
          const action = parsed.success ? parsed.data.action : args.action;
          if (!turn || !live(slot, turn)) {
            diagnostics.record("PROACTIVITY_TOOL_REJECTED", { reason: "stale_or_not_live" });
            return result({ ok: false, action, code: "RUNTIME_NOT_LIVE", message: "Кероване виконання неактивне або запит не належить поточній сесії." });
          }
          const proactivity = slot.options?.proactivity;
          if (!proactivity) {
            diagnostics.record("PROACTIVITY_TOOL_REJECTED", { reason: "not_configured" });
            return result({ ok: false, action, code: "NOT_CONFIGURED", message: "Проактивність не підключена до цього агента." });
          }
          if (!parsed.success) {
            diagnostics.record("PROACTIVITY_TOOL_INVALID_REQUEST");
            return result({ ok: false, action, code: "INVALID_REQUEST", message: `Невірний запит до proactivity: ${parsed.error.message}` });
          }
          const response = await proactivity(slot.scope, session.agentId, parsed.data as ProactivityRequest);
          if (!live(slot, turn)) {
            diagnostics.record("PROACTIVITY_TOOL_CANCELLED");
            return result({ ok: false, action, code: "CANCELLED", message: "Виконання було зупинено до завершення запиту." });
          }
          return result(response);
        }),
    ] });
    return {
      expected,
      settings: {
        cwd: session.workspace, additionalDirectories: [], settingSources: [], strictMcpConfig: true,
        plugins: service.plugin ? [{ type: "local", path: service.plugin, skipMcpDiscovery: true }] : [], skills: expected,
        tools, disallowedTools, agents: subagents, model: session.appliedModel,
        systemPrompt: { type: "preset", preset: "claude_code", append },
        mcpServers: { densemble, ...(owner ? mcpServers : {}) },
        permissionMode: "default", permissionPrompts: "host", canUseTool, hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
        includePartialMessages: true, persistSession: true, env: claudeEnvironment(config), stderr: () => undefined,
        ...(resume ? { resume: session.id } : { sessionId: session.id }),
      },
    };
  }
  function close(slot: Slot): Promise<void> {
    slot.closed ??= closeOwned(slot);
    return slot.closed;
  }
  async function closeOwned(slot: Slot): Promise<void> {
    slot.closing = true;
    slot.unsubscribe?.();
    delete slot.unsubscribe;
    revoke(slot);
    slot.turn?.controller.abort();
    try {
      slot.stoppedHost = slot.host;
      const outcome = await slot.host?.stop();
      slot.forcedClose = outcome?.forced ?? false;
    } finally {
      if (slots.get(scopeKey(slot.scope)) === slot) slots.delete(scopeKey(slot.scope));
    }
  }
  function stop(slot: Slot, turn: Turn): Promise<void> {
    turn.stopping ??= stopOwned(slot, turn);
    return turn.stopping;
  }
  async function stopOwned(slot: Slot, turn: Turn): Promise<void> {
    if (turn.terminal) { await close(slot); return; }
    turn.cancelling = true; turn.controller.abort(); revoke(slot);
    // A turn stopped before its message was sent never reached the engine: nothing to interrupt.
    let forced = turn.sent;
    try {
      if (slot.host && turn.sent) {
        await bounded(slot.host.interrupt(), options.abortGraceMs ?? 2_000, "ABORT_ACK_TIMEOUT");
        const deadline = Date.now() + (options.abortGraceMs ?? 2_000);
        while (!turn.resulted && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
        forced = !turn.resulted;
      }
    } catch { diagnostics.record("RUNTIME_ABORT_FORCED"); }
    // A cooperative interrupt does not prove that started commands exited; closing kills the owned tree.
    await close(slot);
    turn.terminal = true;
    emit(slot, { ...turn.identity, kind: "stopped", forced: forced || slot.forcedClose, externalOutcomeUnknown: true });
  }
  async function probe(): Promise<ModelInfo[]> {
    if (catalog && Date.now() - catalog.at < (options.catalogTtlMs ?? 5 * 60_000)) return catalog.models;
    const host = await hostFactory(catalogOptions(config));
    probes.add(host);
    try {
      const init = await bounded(host.start({ message: () => undefined, end: () => undefined }), 30_000, "MODEL_LIST_TIMEOUT");
      if (init.version !== CLAUDE_CODE_VERSION) throw new RuntimeError("RUNTIME_VERSION_MISMATCH");
      if (!init.authenticated) throw new RuntimeError("CLAUDE_LOGIN_REQUIRED");
      catalog = { at: Date.now(), models: claudeModels(init) };
      return catalog.models;
    } finally {
      probes.delete(host);
      await host.stop();
    }
  }
  return {
    // Process journals are engine-neutral; the router recovers them once for every engine.
    recoverOwnedProcesses: async () => undefined,
    supportsSteering: () => false,
    async open(supplied) {
      supplied.signal?.throwIfAborted();
      const session: Session = supplied.session;
      if (session.engine !== "claude-code") throw new RuntimeError("SESSION_ENGINE_MISMATCH");
      const slot = slotFor(session.scope, session.id);
      slot.options = supplied;
      if (slot.init) return { providerSessionId: session.id };
      slot.opening ??= (async () => {
        try {
          const provider = session.providerSessionId;
          if (provider && provider !== session.id) throw new RuntimeError("UNOWNED_PROVIDER_SESSION");
          const history = (await claudeTranscripts(claudeHome(config), session.id)).length > 0;
          // A session that never completed a turn has no transcript to lose; recreate it under the same ID.
          const empty = supplied.emptyHistory ?? session.generation === 0;
          if (provider && !history && !empty) throw new RuntimeError("SESSION_HISTORY_MISSING");
          const { settings, expected } = await sessionOptions(slot, supplied, history);
          supplied.signal?.throwIfAborted();
          if (slot.closing) throw new RuntimeError("SESSION_OPEN_CANCELLED");
          let host: ClaudeHost;
          try { host = await hostFactory(settings); }
          catch (error) { throw error instanceof RuntimeError ? error : new RuntimeError("CLAUDE_ENGINE_UNAVAILABLE"); }
          slot.host = host;
          if (slot.closing) throw new RuntimeError("SESSION_OPEN_CANCELLED");
          slot.unsubscribe = host.onFailure((code) => loseRuntime(slot, code));
          let init: ClaudeInit;
          try {
            init = await bounded(host.start({
              message: (message) => onMessage(slot, message),
              end: () => loseRuntime(slot, "RUNTIME_CONNECTION_LOST"),
            }), 30_000, "SESSION_OPEN_TIMEOUT");
          } catch (error) { throw error instanceof RuntimeError ? error : new RuntimeError("CLAUDE_ENGINE_UNAVAILABLE"); }
          if (init.version !== CLAUDE_CODE_VERSION) throw new RuntimeError("RUNTIME_VERSION_MISMATCH");
          if (!init.authenticated) throw new RuntimeError("CLAUDE_LOGIN_REQUIRED");
          if (!modelAvailable(init, session.appliedModel)) throw new RuntimeError("MODEL_UNAVAILABLE");
          if (expected.some((name) => !init.commands.includes(name))) throw new RuntimeError("CLAUDE_SKILLS_UNAVAILABLE");
          if (slot.closing || supplied.signal?.aborted) throw new RuntimeError("SESSION_OPEN_CANCELLED");
          slot.init = init;
          return { providerSessionId: session.id };
        } catch (error) {
          await close(slot);
          // A close that raced ahead of host creation found no host; stop the late one here.
          if (slot.host && slot.stoppedHost !== slot.host) {
            slot.stoppedHost = slot.host;
            try { await slot.host.stop(); } catch { diagnostics.record("RUNTIME_LOSS_CLEANUP_FAILED"); }
          }
          throw error;
        }
      })();
      return slot.opening;
    },
    async execute(command: RuntimeCommand) {
      const slot = slots.get(scopeKey(command.identity.scope));
      if (!slot || slot.sessionId !== command.identity.sessionId) {
        if (command.kind === "stop") return;
        throw new RuntimeError("RUNTIME_SESSION_NOT_OPEN");
      }
      if (command.kind === "stop") {
        if (slot.turn && (slot.turn.identity.runId !== command.identity.runId ||
            slot.turn.identity.generation !== command.identity.generation)) return;
        if (slot.turn) await stop(slot, slot.turn);
        else if (!slot.options || slot.options.session.generation === command.identity.generation) await close(slot);
        return;
      }
      if (command.kind === "answer") {
        const waiting = slot.requests.get(command.requestId);
        if (waiting?.identity.runId !== command.identity.runId ||
            waiting.identity.generation !== command.identity.generation || !slot.turn || !live(slot, slot.turn)) return;
        if (waiting.payload.kind !== command.answer.kind) return;
        waiting.resolve(command.answer);
        return;
      }
      if (command.kind === "steer") throw new RuntimeError("STEERING_UNSUPPORTED");
      if (!slot.host || !slot.init || slot.switching || slot.closing) throw new RuntimeError("RUNTIME_SESSION_NOT_READY");
      if (slot.turn && !slot.turn.terminal) throw new RuntimeError("RUNTIME_TURN_ACTIVE");
      // The turn exists before any await, so a /stop for this run always finds it.
      const uuid = randomUUID();
      const turn: Turn = { identity: command.identity, uuid, controller: new AbortController(), preview: "", lastPreview: 0,
        terminal: false, cancelling: false, resulted: false, sent: false };
      slot.turn = turn;
      const images = await Promise.all(command.input.images.map(async (image) => {
        if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)) throw new RuntimeError("MODEL_IMAGES_UNSUPPORTED");
        return { type: "image" as const, source: { type: "base64" as const,
          media_type: image.mimeType as "image/png" | "image/jpeg" | "image/webp", data: (await readFile(image.path)).toString("base64") } };
      }));
      if (!live(slot, turn)) return;
      if (!slot.host || !slot.init || slot.switching) throw new RuntimeError("RUNTIME_SESSION_NOT_READY");
      turn.sent = true;
      slot.host.send({ type: "user", parent_tool_use_id: null, uuid: uuid as SDKUserMessage["uuid"] & string,
        message: { role: "user", content: [{ type: "text", text: command.input.text }, ...images] } });
    },
    async models(scope, sessionId) {
      const slot = slots.get(scopeKey(scope));
      if (slot?.sessionId === sessionId && slot.init && !slot.closing) return claudeModels(slot.init);
      return probe();
    },
    async setModel(scope, sessionId, model) {
      const slot = slots.get(scopeKey(scope));
      if (!slot?.host || !slot.init || slot.sessionId !== sessionId || (slot.turn && !slot.turn.terminal) || slot.switching || slot.closing) {
        throw new RuntimeError("MODEL_BOUNDARY_REQUIRED");
      }
      slot.switching = true;
      try {
        if (!modelAvailable(slot.init, model)) throw new RuntimeError("MODEL_UNAVAILABLE");
        await bounded(slot.host.setModel(model), 10_000, "MODEL_SWITCH_TIMEOUT");
        if (slot.closing) throw new RuntimeError("MODEL_SWITCH_CANCELLED");
      } catch (error) {
        await close(slot);
        throw error instanceof RuntimeError ? error : new RuntimeError("MODEL_SWITCH_FAILED");
      } finally { slot.switching = false; }
    },
    async disconnect(scope, sessionId) {
      const slot = slots.get(scopeKey(scope));
      if (slot?.sessionId !== sessionId) return;
      if (slot.turn && !slot.turn.terminal) throw new RuntimeError("RUNTIME_TURN_ACTIVE");
      await close(slot);
    },
    async deleteSession(scope, sessionId, providerSessionId) {
      if (providerSessionId !== sessionId) throw new RuntimeError("UNOWNED_PROVIDER_SESSION");
      const slot = slots.get(scopeKey(scope));
      if (slot?.sessionId === sessionId) {
        if (slot.turn && !slot.turn.terminal) throw new RuntimeError("RUNTIME_TURN_ACTIVE");
        await close(slot);
      }
      const home = claudeHome(config);
      // Only this session's own transcript and subagent directory; never other sessions or workspace files.
      for (const path of await claudeHistory(home, providerSessionId)) await rm(path, { recursive: true });
      if ((await claudeHistory(home, providerSessionId)).length) throw new RuntimeError("SESSION_DELETE_INCOMPLETE");
    },
    async shutdown() {
      shuttingDown = true;
      const results = await Promise.allSettled([...[...slots.values()].map((slot) => close(slot)), ...[...probes].map((host) => host.stop())]);
      if (results.some((entry) => entry.status === "rejected")) throw new RuntimeError("RUNTIME_SHUTDOWN_UNCONFIRMED");
    },
  };
}
