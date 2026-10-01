import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient, defineTool, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import type {
  CopilotClientOptions, CopilotSession, ElicitationFieldValue, ElicitationSchema, MCPServerConfig,
  ModelInfo as SdkModel, PermissionRequest, ResumeSessionConfig, SessionConfig, SessionEvent,
} from "@github/copilot-sdk";
import type { LoadedConfig } from "../config/index.js";
import type { ModelInfo, RequestAnswer, RequestPayload, RunIdentity, RuntimeCommand, Scope } from "../domain.js";
import { scopeKey } from "../domain.js";
import type { DiagnosticSink } from "../ports.js";
import { opaqueId, sanitizeParameters } from "../permissions/index.js";
import type { ControlledRuntime, ControlledSessionOptions } from "./contracts.js";
import { bounded, RuntimeError } from "./contracts.js";
import { ProcessSupervisor, recoverOwnedProcesses } from "./supervisor.js";
import type { ProcessFailure } from "./supervisor.js";

const builtinTools = [
  "bash", "read_bash", "stop_bash", "list_bash", "view", "glob", "grep", "rg", "edit", "create",
  "apply_patch", "skill", "task", "read_agent", "write_agent", "list_agents", "ask_user", "report_intent", "web_fetch",
];
const excludedTools = ["store_memory", "session_store", "session_store_sql", "session_history", "search_sessions"];
const ownedSessionPattern = /^densemble-[a-f0-9-]{36}$/;
const permissionNames: Partial<Record<PermissionRequest["kind"], string>> = {
  shell: "Виконати команду", read: "Прочитати файл", write: "Змінити файл", mcp: "Викликати MCP-інструмент",
  url: "Відкрити мережевий ресурс", "custom-tool": "Викликати інструмент сервісу", hook: "Виконати обробник",
};
type NativeSession = Pick<CopilotSession, "sessionId" | "send" | "abort" | "disconnect" | "setModel"> & {
  rpc: { model: Pick<CopilotSession["rpc"]["model"], "getCurrent"> };
};
export interface CopilotHost {
  start(): Promise<void>;
  stop(): Promise<{ forced: boolean } | void>;
  onFailure(handler: (code: ProcessFailure) => void): () => void;
  client: {
    ping: CopilotClient["ping"];
    listModels(): Promise<SdkModel[]>;
    createSession(config: SessionConfig): Promise<NativeSession>;
    resumeSession(id: string, config: ResumeSessionConfig): Promise<NativeSession>;
    deleteSession(id: string): Promise<void>;
  };
}
export interface CopilotRuntimeOptions {
  config: LoadedConfig;
  diagnostics: DiagnosticSink;
  hostFactory?: () => Promise<CopilotHost>;
  abortGraceMs?: number;
  requestTimeoutMs?: number;
  previewIntervalMs?: number;
}
type Waiting = { identity: RunIdentity; payload: RequestPayload; resolve: (answer: RequestAnswer | null) => void };
type Turn = {
  identity: RunIdentity; controller: AbortController; sendIds: Set<string>; sending: number;
  messages: Map<string, { text: string; origin?: string }>; preview: string; lastPreview: number;
  terminal: boolean; cancelling: boolean; aborted: boolean; idle: boolean; errored: boolean;
  stopping?: Promise<void>; startedAt: number;
};
type Slot = {
  sessionId: string; scope: Scope; host: Promise<CopilotHost>; ready: Promise<void>; native?: NativeSession;
  opening?: Promise<{ providerSessionId: string }>; options?: ControlledSessionOptions;
  turn?: Turn; requests: Map<string, Waiting>; closing: boolean; switching: boolean; closed?: Promise<void>;
  exportGrants: Map<string, string>;
  forcedClose: boolean;
  unsubscribeHost?: () => void;
  stopHealth?: () => void;
};

export async function pinnedRuntimePath(): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new RuntimeError("RUNTIME_REQUIRES_MACOS_ARM64");
  const path = fileURLToPath(import.meta.resolve("@github/copilot-darwin-arm64"));
  const cli = JSON.parse(await readFile(join(dirname(path), "package.json"), "utf8")) as { version: string };
  const sdkPath = fileURLToPath(import.meta.resolve("@github/copilot-sdk"));
  const sdk = JSON.parse(await readFile(resolve(dirname(sdkPath), "../package.json"), "utf8")) as { version: string };
  if (cli.version !== "1.0.91" || sdk.version !== "1.0.16") throw new RuntimeError("RUNTIME_VERSION_MISMATCH");
  return path;
}

export function serviceClientOptions(config: LoadedConfig, cli: string): CopilotClientOptions {
  const home = process.env.HOME;
  if (!home) throw new RuntimeError("AUTH_HOME_REQUIRED");
  return {
    connection: RuntimeConnection.forStdio({ path: cli,
      args: ["--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--no-remote-export", "--no-bash-env"] }),
    mode: "copilot-cli", baseDirectory: config.config.runtimeHomePath,
    workingDirectory: config.config.workspacePath,
    env: {
      HOME: home, COPILOT_HOME: config.config.runtimeHomePath,
      XDG_CONFIG_HOME: join(config.config.runtimeHomePath, "xdg"),
      XDG_CACHE_HOME: join(config.config.runtimeHomePath, "cache"),
      TMPDIR: join(config.config.runtimeDataPath, "scratch"),
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      LANG: "en_US.UTF-8", GH_PROMPT_DISABLED: "1",
    },
    useLoggedInUser: true, enableRemoteSessions: false, logLevel: "none",
  };
}

export function detachedAction(tool: string, args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const values = args as Record<string, unknown>;
  if (values.detach === true) return true;
  if (tool !== "bash") return false;
  const command = typeof values.command === "string" ? values.command : "";
  return /\b(nohup|disown|setsid)\b|(?<!&)&(?!&)/.test(command);
}

async function sessionHistoryExists(home: string, sessionId: string): Promise<boolean> {
  const parent = join(home, "session-state");
  const path = join(home, "session-state", sessionId);
  try {
    const container = await lstat(parent);
    if (!container.isDirectory() || container.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new RuntimeError("SESSION_HISTORY_UNSAFE");
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
      throw new RuntimeError("SESSION_HISTORY_UNSAFE");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function questionFields(schema: ElicitationSchema, message: string): RequestPayload {
  const fields = Object.entries(schema.properties).map(([sourceId, field], index) => {
    const id = `field_${index}`;
    if (field.type === "array") {
      const choices = "enum" in field.items ? field.items.enum : field.items.anyOf.map((entry) => entry.const);
      return { id, prompt: field.title ?? field.description ?? sourceId, choices, multiple: true, allowFreeform: false };
    }
    const choices = field.type === "boolean" ? ["Так", "Ні"] :
      "enum" in field ? field.enum : "oneOf" in field ? field.oneOf.map((entry) => entry.const) : [];
    return { id, prompt: field.title ?? field.description ?? sourceId, choices, multiple: false, allowFreeform: choices.length === 0 };
  });
  if (!fields.length || fields.length > 20) throw new RuntimeError("QUESTION_SCHEMA_UNSUPPORTED");
  fields[0]!.prompt = `${message}\n${fields[0]!.prompt}`;
  return { kind: "question", fields };
}
function elicitationContent(schema: ElicitationSchema, answer: RequestAnswer | null): Record<string, ElicitationFieldValue> | null {
  if (answer?.kind !== "question") return null;
  const content: Record<string, ElicitationFieldValue> = Object.create(null) as Record<string, ElicitationFieldValue>;
  for (const [index, [key, field]] of Object.entries(schema.properties).entries()) {
    const values = answer.answers[`field_${index}`];
    if (!values?.length) return null;
    const value = values[0]!;
    if (field.type === "number" || field.type === "integer") {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)) ||
          (field.minimum !== undefined && number < field.minimum) || (field.maximum !== undefined && number > field.maximum)) return null;
      content[key] = number;
    } else if (field.type === "boolean") {
      if (!["Так", "Ні"].includes(value)) return null;
      content[key] = value === "Так";
    } else if (field.type === "array") {
      if ((field.minItems !== undefined && values.length < field.minItems) ||
          (field.maxItems !== undefined && values.length > field.maxItems)) return null;
      content[key] = values;
    } else {
      if (("minLength" in field && field.minLength !== undefined && value.length < field.minLength) ||
          ("maxLength" in field && field.maxLength !== undefined && value.length > field.maxLength)) return null;
      content[key] = value;
    }
  }
  return content;
}

export function createCopilotRuntime(options: CopilotRuntimeOptions): ControlledRuntime {
  const { config, diagnostics } = options;
  const slots = new Map<string, Slot>();
  let shuttingDown = false;
  const secrets: string[] = [];
  const mcpServers: Record<string, MCPServerConfig> = {};
  const tools = new ToolSet().addBuiltIn(builtinTools).addCustom("densemble_export_file");
  if (config.config.mcp.mode === "allowlist") {
    for (const declaration of config.config.mcp.servers) {
      const secret = (reference: string): string => {
        const value = config.resolveSecret(reference); secrets.push(value); return value;
      };
      for (const tool of declaration.tools) {
        if (tool === "*" || excludedTools.includes(tool)) throw new RuntimeError("MCP_TOOL_ALLOWLIST_REQUIRED");
        tools.addMcp(`${declaration.name}-${tool}`);
      }
      mcpServers[declaration.name] = declaration.type === "stdio" ? {
        type: "local", command: declaration.command,
        args: declaration.args.map((arg) => typeof arg === "string" ? arg : secret(arg.secretRef)),
        env: Object.fromEntries(Object.entries(declaration.env).map(([key, value]) => [key, secret(value.secretRef)])),
        workingDirectory: declaration.cwd ?? config.config.workspacePath, tools: declaration.tools,
      } : {
        type: "http", url: declaration.url,
        headers: Object.fromEntries(Object.entries(declaration.headers).map(([key, value]) => [key, secret(value.secretRef)])),
        tools: declaration.tools,
      };
    }
  }
  const hostFactory = options.hostFactory ?? (async (): Promise<CopilotHost> => {
    const cli = await pinnedRuntimePath();
    const scratch = join(config.config.runtimeDataPath, "scratch");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    if (await realpath(scratch) !== scratch) throw new RuntimeError("RUNTIME_SCRATCH_UNSAFE");
    const client = new CopilotClient(serviceClientOptions(config, cli));
    const supervisor = new ProcessSupervisor(config.config.runtimeDataPath, cli, diagnostics);
    return {
      client, start: () => supervisor.start(() => client.start()),
      onFailure: (handler) => supervisor.onFailure(handler),
      async stop() {
        let forced = true;
        try { forced = await supervisor.hasLiveDescendants(); }
        catch { diagnostics.record("PROCESS_OBSERVATION_FAILED"); }
        await supervisor.stop(() => client.forceStop());
        return { forced };
      },
    };
  });

  function slotFor(scope: Scope, sessionId: string): Slot {
    if (shuttingDown) throw new RuntimeError("RUNTIME_SHUTTING_DOWN");
    const key = scopeKey(scope);
    const existing = slots.get(key);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.closing) throw new RuntimeError("RUNTIME_SCOPE_BUSY");
      return existing;
    }
    const host = hostFactory();
    const slot: Slot = { scope, sessionId, host, ready: Promise.resolve(), requests: new Map(), exportGrants: new Map(),
      closing: false, switching: false, forcedClose: false };
    slots.set(key, slot);
    slot.ready = host.then(async (owner) => {
      slot.unsubscribeHost = owner.onFailure((code) => loseRuntime(slot, code));
      try {
        if (slot.closing) throw new RuntimeError("RUNTIME_START_CANCELLED");
        await owner.start();
        if (slot.closing) throw new RuntimeError("RUNTIME_START_CANCELLED");
        slot.stopHealth = monitorHealth(slot, owner);
      } catch (error) { await close(slot); throw error; }
    });
    void slot.ready.catch(() => diagnostics.record("RUNTIME_START_FAILED"));
    return slot;
  }
  // SDK transport loss clears session handlers even when the owned process survives.
  function monitorHealth(slot: Slot, owner: CopilotHost): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let cancel: (() => void) | undefined;
    function schedule(): void {
      if (stopped || slot.closing || shuttingDown) return;
      timer = setTimeout(() => { timer = undefined; void probe(); }, 500);
      timer.unref();
    }
    async function probe(): Promise<void> {
      if (stopped || slot.closing || shuttingDown) return;
      const cancelled = new Promise<boolean>((resolve) => { cancel = () => resolve(false); });
      const expired = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1_500);
        timeout.unref();
      });
      try {
        const healthy = await Promise.race([owner.client.ping().then(() => true), expired, cancelled]);
        if (!healthy && !stopped) loseRuntime(slot, "RUNTIME_CONNECTION_LOST");
      } catch {
        if (!stopped) loseRuntime(slot, "RUNTIME_CONNECTION_LOST");
      } finally {
        clearTimeout(timeout);
        timeout = undefined;
        cancel = undefined;
        schedule();
      }
    }
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(timeout);
      cancel?.();
    };
  }
  function live(slot: Slot, turn: Turn): boolean {
    return !shuttingDown && !slot.closing && slot.turn === turn && !turn.terminal && !turn.cancelling &&
      !turn.controller.signal.aborted && !slot.options?.signal?.aborted;
  }
  function emit(slot: Slot, event: Parameters<NonNullable<Slot["options"]>["onEvent"]>[0]): void {
    try { slot.options?.onEvent(event); } catch { diagnostics.record("RUNTIME_EVENT_HANDLER_FAILED"); }
  }
  function revoke(slot: Slot): void {
    for (const wait of slot.requests.values()) wait.resolve(null);
    slot.requests.clear();
    slot.exportGrants.clear();
  }
  function loseRuntime(slot: Slot, code: ProcessFailure | "RUNTIME_SESSION_SHUTDOWN" | "RUNTIME_CONNECTION_LOST"): void {
    if (slot.closing || shuttingDown) return;
    slot.closing = true;
    revoke(slot);
    const turn = slot.turn;
    turn?.controller.abort();
    const closing = close(slot);
    if (turn && !turn.terminal) {
      turn.terminal = true;
      emit(slot, { ...turn.identity, kind: "failed", code });
    }
    diagnostics.record(code);
    void closing.catch(() => diagnostics.record("RUNTIME_LOSS_CLEANUP_FAILED"));
  }
  function finish(slot: Slot, turn: Turn): void {
    if (!live(slot, turn) || !turn.idle || turn.sending > 0) return;
    turn.terminal = true;
    revoke(slot);
    const text = [...turn.messages.values()].filter((message) => message.origin && turn.sendIds.has(message.origin))
      .map((message) => message.text).join("\n\n");
    if (turn.errored || turn.aborted || !text) emit(slot, { ...turn.identity, kind: "failed", code: "RUNTIME_TURN_FAILED" });
    else emit(slot, { ...turn.identity, kind: "completed", text });
  }
  function eventFor(slot: Slot, event: SessionEvent): void {
    const turn = slot.turn;
    if (event.agentId || ("parentToolCallId" in event.data && event.data.parentToolCallId)) return;
    if (turn && Date.parse(event.timestamp) < turn.startedAt) return;
    if (event.type === "session.shutdown") { loseRuntime(slot, "RUNTIME_SESSION_SHUTDOWN"); return; }
    if (!turn) return;
    if (event.type === "abort") turn.aborted = true;
    if (event.type === "session.idle") turn.idle = true;
    if (!live(slot, turn)) return;
    switch (event.type) {
      case "assistant.message_delta":
        turn.preview += event.data.deltaContent;
        if (Date.now() - turn.lastPreview >= (options.previewIntervalMs ?? 750)) {
          turn.lastPreview = Date.now();
          emit(slot, { ...turn.identity, kind: "delta", text: turn.preview });
        }
        break;
      case "assistant.message":
        turn.messages.set(event.data.messageId, { text: event.data.content,
          ...(event.data.originatingMessageId ? { origin: event.data.originatingMessageId } : {}) });
        break;
      case "session.error":
        turn.errored = true;
        // A failed native turn may still have executing tools. Stop rather than
        // releasing the scope on a mere error notification.
        void stop(slot, turn).catch(() => diagnostics.record("RUNTIME_ERROR_STOP_FAILED"));
        break;
      case "session.idle": finish(slot, turn); break;
      default: break;
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
  function permissionDenied(permission: PermissionRequest): boolean {
    if (JSON.stringify(permission).length > 12_000) return true;
    if (permission.managedApprovalRequired || permission.kind === "memory" || permission.kind === "workflow") return true;
    return permission.kind === "shell" && (permission.requestSandboxBypass === true ||
      permission.requestSandboxPermissive === true || Boolean(permission.sandboxPathGrant) ||
      detachedAction("bash", { command: permission.fullCommandText }));
  }
  async function sessionConfig(slot: Slot, supplied: ControlledSessionOptions): Promise<SessionConfig> {
    const session = supplied.session;
    const agents = config.agents;
    if (!agents.some((agent) => agent.id === session.agentId)) throw new RuntimeError("RUNTIME_AGENT_MISSING");
    const models = await (await slot.host).client.listModels();
    const allowed = models.filter((model) => model.policy?.state !== "disabled").map((model) => model.id);
    for (const model of [session.appliedModel, ...agents.filter((agent) => agent.id !== session.agentId).map((agent) => agent.defaultModel)]) {
      if (!allowed.includes(model)) throw new RuntimeError("MODEL_UNAVAILABLE");
    }
    const customAgents = await Promise.all(agents.map(async (agent) => ({
      name: agent.id, description: agent.description,
      model: agent.id === session.agentId ? session.appliedModel : agent.defaultModel,
      prompt: `Source: ${relative(session.workspace, agent.canonicalPath)}\n${await readFile(agent.canonicalPath, "utf8")}`,
      ...(agent.tools ? { tools: agent.tools.filter((name) => !excludedTools.includes(name)) } : {}),
      ...(agent.infer === undefined ? {} : { infer: agent.infer }),
    })));
    return {
      sessionId: session.providerSessionId ?? `densemble-${session.id}`, model: session.appliedModel, allowedModels: allowed,
      agent: session.agentId, customAgents, customAgentsLocalOnly: true,
      workingDirectory: session.workspace, configDirectory: config.config.runtimeHomePath,
      enableConfigDiscovery: false, skipCustomInstructions: false,
      instructionDirectories: [session.workspace], skillDirectories: config.config.skillDirectories, enableSkills: true,
      pluginDirectories: [], includedBuiltinSkills: [], mcpServers,
      excludedBuiltinAgents: ["explore", "task", "general-purpose", "code-review", "research", "security-review"],
      enableFileHooks: false, enableHostGitOperations: false, enableOnDemandInstructionDiscovery: false,
      enableSessionStore: false, memory: { enabled: false }, skipEmbeddingRetrieval: true,
      embeddingCacheStorage: "in-memory", enableSessionTelemetry: false, manageScheduleEnabled: false,
      remoteSession: "off", streaming: true, includeSubAgentStreamingEvents: true,
      availableTools: tools, excludedTools,
      onEvent: (event) => eventFor(slot, event),
      onPermissionRequest: async (permission, invocation) => {
        const turn = slot.turn;
        const native = slot.native;
        if (!native || !turn || !live(slot, turn) || invocation.sessionId !== native.sessionId || permissionDenied(permission)) return { kind: "reject" };
        const answer = await request(slot, { kind: "permission", action: permissionNames[permission.kind] ?? "Зовнішня дія",
          parameters: sanitizeParameters(permission, secrets) });
        const approved = answer?.kind === "permission" && answer.approved && live(slot, turn);
        if (!approved) return { kind: "reject" };
        try { await bounded(native.rpc.model.getCurrent(), 2_000, "PERMISSION_CONNECTION_UNCONFIRMED"); }
        catch { loseRuntime(slot, "RUNTIME_CONNECTION_LOST"); return { kind: "reject" }; }
        if (!live(slot, turn)) return { kind: "reject" };
        if (permission.kind === "custom-tool" && permission.toolName === "densemble_export_file") {
          const args = permission.args;
          if (!permission.toolCallId || !args || typeof args !== "object" || Array.isArray(args) ||
              !("path" in args) || typeof args.path !== "string") return { kind: "reject" };
          slot.exportGrants.set(permission.toolCallId, args.path);
        }
        return { kind: "approve-once" };
      },
      onUserInputRequest: async (question, invocation) => {
        const turn = slot.turn;
        if (!turn || !live(slot, turn) || invocation.sessionId !== slot.native?.sessionId) throw new RuntimeError("QUESTION_SESSION_MISMATCH");
        const choices = question.choices ?? [];
        const answer = await request(slot, { kind: "question", fields: [{
          id: "answer", prompt: question.question, choices, multiple: false, allowFreeform: question.allowFreeform ?? true,
        }] });
        if (!live(slot, turn) || answer?.kind !== "question" || !answer.answers.answer?.[0]) throw new RuntimeError("QUESTION_CANCELLED");
        return { answer: answer.answers.answer[0], wasFreeform: !choices.includes(answer.answers.answer[0]) };
      },
      askUserVariant: "elicitation",
      onElicitationRequest: async (context) => {
        const turn = slot.turn;
        if (!turn || !live(slot, turn) || context.sessionId !== slot.native?.sessionId ||
            context.mode === "url" || !context.requestedSchema) return { action: "cancel" };
        const schema = context.requestedSchema;
        for (;;) {
          const answer = await request(slot, questionFields(schema, context.message));
          if (!answer || !live(slot, turn)) return { action: "cancel" };
          const content = elicitationContent(schema, answer);
          if (content) return { action: "accept", content };
          if (!slot.turn || !live(slot, slot.turn)) return { action: "cancel" };
          emit(slot, { ...slot.turn.identity, kind: "status", status: "Відповідь не відповідає формі. Спробуйте ще раз." });
        }
      },
      hooks: { onPreToolUse: (input, invocation) => {
        if (invocation.sessionId !== slot.native?.sessionId || !slot.turn || !live(slot, slot.turn) ||
            detachedAction(input.toolName, input.toolArgs) || excludedTools.includes(input.toolName)) {
          return { permissionDecision: "deny", permissionDecisionReason: "Дія не належить живому керованому виконанню." };
        }
        return { permissionDecision: "ask" };
      } },
      tools: [defineTool("densemble_export_file", {
        description: "Return a generated workspace file to this conversation. Requires explicit user permission. A path mentioned in text is not an export.",
        parameters: { type: "object", properties: { path: { type: "string", minLength: 1,
          description: "Absolute path or a path relative to the configured workspace." } }, required: ["path"], additionalProperties: false },
        handler: async (args: { path: string }, invocation) => {
          const turn = slot.turn;
          if (!turn || !live(slot, turn) || invocation.sessionId !== slot.native?.sessionId || !supplied.exportFile) {
            throw new RuntimeError("EXPORT_NOT_AUTHORIZED");
          }
          if (slot.exportGrants.get(invocation.toolCallId) !== args.path) throw new RuntimeError("EXPORT_NOT_AUTHORIZED");
          slot.exportGrants.delete(invocation.toolCallId);
          const signal = invocation.signal ? AbortSignal.any([turn.controller.signal, invocation.signal]) : turn.controller.signal;
          const attachment = await supplied.exportFile(turn.identity, args.path, signal);
          if (!live(slot, turn)) throw new RuntimeError("EXPORT_CANCELLED");
          return { status: "prepared_for_delivery", fileName: attachment.fileName };
        },
      })],
    };
  }
  function close(slot: Slot): Promise<void> {
    slot.closed ??= closeOwned(slot);
    return slot.closed;
  }
  async function closeOwned(slot: Slot): Promise<void> {
    slot.closing = true;
    slot.stopHealth?.();
    delete slot.stopHealth;
    slot.unsubscribeHost?.();
    delete slot.unsubscribeHost;
    revoke(slot);
    slot.turn?.controller.abort();
    const host = await slot.host;
    const outcome = await host.stop();
    slot.forcedClose = outcome?.forced ?? false;
    if (slots.get(scopeKey(slot.scope)) === slot) slots.delete(scopeKey(slot.scope));
  }
  function stop(slot: Slot, turn: Turn): Promise<void> {
    turn.stopping ??= stopOwned(slot, turn);
    return turn.stopping;
  }
  async function stopOwned(slot: Slot, turn: Turn): Promise<void> {
    if (turn.terminal) { await close(slot); return; }
    turn.cancelling = true; turn.controller.abort(); revoke(slot);
    let forced = true;
    try {
      if (slot.native) {
        await bounded(slot.native.abort(), options.abortGraceMs ?? 2_000, "ABORT_ACK_TIMEOUT");
        const deadline = Date.now() + (options.abortGraceMs ?? 2_000);
        while (!(turn.aborted && turn.idle) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
        forced = !(turn.aborted && turn.idle);
      }
    } catch { diagnostics.record("RUNTIME_ABORT_FORCED"); }
    // Even cooperative root idle does not prove native descendants exited.
    // Terminating the owned idle runtime makes the local-stop claim verifiable.
    await close(slot);
    turn.terminal = true;
    emit(slot, { ...turn.identity, kind: "stopped", forced: forced || slot.forcedClose, externalOutcomeUnknown: true });
  }
  return {
    recoverOwnedProcesses: () => recoverOwnedProcesses(config.config.runtimeDataPath),
    async open(supplied) {
      supplied.signal?.throwIfAborted();
      const slot = slotFor(supplied.session.scope, supplied.session.id);
      slot.options = supplied;
      if (slot.native) return { providerSessionId: slot.native.sessionId };
      slot.opening ??= (async () => {
        try {
          const host = await slot.host;
          await slot.ready;
          supplied.signal?.throwIfAborted();
          const settings = await sessionConfig(slot, supplied);
          supplied.signal?.throwIfAborted();
          const provider = supplied.session.providerSessionId;
          if (provider && (!ownedSessionPattern.test(provider) || provider !== `densemble-${supplied.session.id}`)) {
            throw new RuntimeError("UNOWNED_PROVIDER_SESSION");
          }
          // The CLI removes truly empty sessions on disconnect. Recreate only
          // when durable admission proves there was no previous turn to lose.
          const empty = supplied.emptyHistory ?? supplied.session.generation === 0;
          const opening = async (): Promise<NativeSession> => {
            if (provider) {
              await sessionHistoryExists(config.config.runtimeHomePath, provider);
              try { return await host.client.resumeSession(provider, { ...settings, continuePendingWork: false }); }
              catch (error) {
                if (!empty || !(error instanceof Error) || !/session.*not found|not found.*session/i.test(error.message)) throw error;
                supplied.signal?.throwIfAborted();
                if (slot.closing) throw new RuntimeError("SESSION_OPEN_CANCELLED");
                await host.client.deleteSession(provider);
                diagnostics.record("EMPTY_SESSION_RECREATED");
              }
            }
            supplied.signal?.throwIfAborted();
            if (slot.closing) throw new RuntimeError("SESSION_OPEN_CANCELLED");
            return host.client.createSession(settings);
          };
          const native = await bounded(opening(), 20_000, "SESSION_OPEN_TIMEOUT");
          if (slot.closing || supplied.signal?.aborted) {
            await close(slot); throw new RuntimeError("SESSION_OPEN_CANCELLED");
          }
          if (native.sessionId !== `densemble-${supplied.session.id}`) throw new RuntimeError("PROVIDER_SESSION_MISMATCH");
          slot.native = native;
          if (provider) {
            await bounded(native.setModel(supplied.session.appliedModel), 10_000, "MODEL_RESTORE_TIMEOUT");
          }
          const actual = await bounded(native.rpc.model.getCurrent(), 8_000, "MODEL_CONFIRM_TIMEOUT");
          if (slot.closing || supplied.signal?.aborted) throw new RuntimeError("SESSION_OPEN_CANCELLED");
          if (actual.modelId !== supplied.session.appliedModel) throw new RuntimeError("MODEL_CONFIRM_MISMATCH");
          return { providerSessionId: native.sessionId };
        } catch (error) {
          await close(slot); throw error;
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
      if (!slot.native || slot.switching || slot.closing) throw new RuntimeError("RUNTIME_SESSION_NOT_READY");
      if (command.kind === "send") {
        if (slot.turn && !slot.turn.terminal) throw new RuntimeError("RUNTIME_TURN_ACTIVE");
        slot.turn = { identity: command.identity, controller: new AbortController(), sendIds: new Set(), sending: 0,
          messages: new Map(), preview: "", lastPreview: 0, terminal: false, cancelling: false, aborted: false,
          idle: false, errored: false, startedAt: Date.now() };
      }
      const turn = slot.turn;
      if (!turn || turn.identity.runId !== command.identity.runId ||
          turn.identity.generation !== command.identity.generation || !live(slot, turn)) throw new RuntimeError("RUNTIME_STALE_RUN");
      turn.sending++;
      turn.idle = false;
      try {
        const id = await bounded(slot.native.send({
          prompt: command.input.text,
          mode: command.kind === "steer" ? "immediate" : "enqueue",
          attachments: command.input.images.map((image) => ({ type: "file" as const, path: image.path, displayName: image.displayName })),
        }), 10_000, "SEND_ADMISSION_TIMEOUT");
        if (!live(slot, turn)) return;
        turn.sendIds.add(id);
      } finally { turn.sending--; finish(slot, turn); }
    },
    async models(scope, sessionId): Promise<ModelInfo[]> {
      const slot = slotFor(scope, sessionId);
      await slot.ready;
      if (slot.closing) throw new RuntimeError("RUNTIME_CLOSED");
      const models = await bounded((await slot.host).client.listModels(), 10_000, "MODEL_LIST_TIMEOUT");
      return models.filter((model) => model.policy?.state !== "disabled")
        .map((model) => ({ id: model.id, name: model.name, supportsImages: model.capabilities.supports.vision }));
    },
    async setModel(scope, sessionId, model) {
      const slot = slots.get(scopeKey(scope));
      if (!slot?.native || slot.sessionId !== sessionId || (slot.turn && !slot.turn.terminal) || slot.switching || slot.closing) {
        throw new RuntimeError("MODEL_BOUNDARY_REQUIRED");
      }
      slot.switching = true;
      try {
        const models = await (await slot.host).client.listModels();
        if (!models.some((entry) => entry.id === model && entry.policy?.state !== "disabled")) throw new RuntimeError("MODEL_UNAVAILABLE");
        if (slot.closing) throw new RuntimeError("MODEL_SWITCH_CANCELLED");
        await bounded(slot.native.setModel(model), 10_000, "MODEL_SWITCH_TIMEOUT");
        const actual = await bounded(slot.native.rpc.model.getCurrent(), 8_000, "MODEL_CONFIRM_TIMEOUT");
        if (slot.closing) throw new RuntimeError("MODEL_SWITCH_CANCELLED");
        if (actual.modelId !== model) throw new RuntimeError("MODEL_CONFIRM_MISMATCH");
      } catch (error) {
        await close(slot);
        throw error instanceof RuntimeError ? error : new RuntimeError("MODEL_SWITCH_FAILED");
      } finally { slot.switching = false; }
    },
    async disconnect(scope, sessionId) {
      const slot = slots.get(scopeKey(scope));
      if (slot?.sessionId !== sessionId) return;
      if (slot.turn && !slot.turn.terminal) throw new RuntimeError("RUNTIME_TURN_ACTIVE");
      slot.closing = true;
      revoke(slot);
      if (slot.native) {
        try { await bounded(slot.native.disconnect(), 3_000, "SESSION_DISCONNECT_TIMEOUT"); }
        finally { await close(slot); }
      } else await close(slot);
    },
    async deleteSession(scope, sessionId, providerSessionId) {
      if (!ownedSessionPattern.test(providerSessionId) || providerSessionId !== `densemble-${sessionId}`) {
        throw new RuntimeError("UNOWNED_PROVIDER_SESSION");
      }
      const slot = slotFor(scope, sessionId);
      if (slot.turn && !slot.turn.terminal) throw new RuntimeError("RUNTIME_TURN_ACTIVE");
      try {
        await slot.ready;
        await sessionHistoryExists(config.config.runtimeHomePath, providerSessionId);
        try { await bounded((await slot.host).client.deleteSession(providerSessionId), 10_000, "SESSION_DELETE_TIMEOUT"); }
        catch {
          if (await sessionHistoryExists(config.config.runtimeHomePath, providerSessionId)) throw new RuntimeError("SESSION_DELETE_FAILED");
        }
        if (await sessionHistoryExists(config.config.runtimeHomePath, providerSessionId)) throw new RuntimeError("SESSION_DELETE_INCOMPLETE");
      }
      finally { await close(slot); }
    },
    async shutdown() {
      shuttingDown = true;
      const results = await Promise.allSettled([...slots.values()].map((slot) => close(slot)));
      if (results.some((result) => result.status === "rejected")) throw new RuntimeError("RUNTIME_SHUTDOWN_UNCONFIRMED");
    },
  };
}
