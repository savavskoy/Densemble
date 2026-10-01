import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineTool, ToolSet } from "@github/copilot-sdk";
import type { CopilotSession, MessageOptions, ModelInfo, SessionConfig, Tool } from "@github/copilot-sdk";
import type { AuthMode, Check, Contract, Observation } from "./contracts.js";
import { bounded, safeError } from "./contracts.js";
import { deferred, ExactPolicy, Journal, requireEvidence, until } from "./evidence.js";
import { fixtures, greenPng } from "./fixtures.js";
import { descendants, IsolatedRuntime, processes, sameProcess } from "./runtime.js";
import type { ProcessIdentity } from "./runtime.js";
import { discoverPersonaMetadata } from "./personas.js";

const TURN_TIMEOUT = 60_000;
const noCrossSession = ["store_memory", "session_store", "session_store_sql", "session_history", "search_sessions"];

export type BehaviorSummary = {
  submittedMessages: number;
  observedModelCalls: number;
  modelIds: string[];
  inputTokens: number;
  outputTokens: number;
  sessionsCreated: number;
};

export function chooseModels(models: ModelInfo[]): [ModelInfo, ModelInfo] {
  const permitted = models.filter((m) => m.policy?.state !== "disabled");
  const preferences = ["gpt-5.4-mini", "gpt-5-mini", "claude-haiku-4.5", "gpt-4.1"];
  const sorted = [...permitted].sort((a, b) => {
    const rank = (id: string): number => {
      const index = preferences.indexOf(id);
      return index < 0 ? preferences.length : index;
    };
    return rank(a.id) - rank(b.id);
  });
  const primary = sorted.find((m) => m.capabilities.supports.vision);
  const alternate = sorted.find((m) => m.id !== primary?.id);
  requireEvidence(primary && alternate, "TWO_SUITABLE_MODELS_REQUIRED");
  return [primary, alternate];
}

export function isolatedSessionConfig(
  runtime: IsolatedRuntime, model: string, policy: ExactPolicy, journal: Journal,
): SessionConfig {
  return {
    model,
    workingDirectory: runtime.workspace,
    configDirectory: runtime.baseDirectory,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableOnDemandInstructionDiscovery: false,
    enableSessionStore: false,
    memory: { enabled: false },
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    enableSessionTelemetry: false,
    enableCitations: false,
    enableFileChangeTracking: false,
    manageScheduleEnabled: false,
    coauthorEnabled: false,
    remoteSession: "off",
    streaming: true,
    includeSubAgentStreamingEvents: true,
    infiniteSessions: { enabled: false },
    availableTools: [],
    excludedTools: noCrossSession,
    excludedBuiltinAgents: ["explore", "task", "general-purpose", "code-review", "research", "security-review"],
    includedBuiltinSkills: [],
    skillDirectories: [],
    instructionDirectories: [],
    pluginDirectories: [],
    mcpServers: {},
    customAgents: [],
    onPermissionRequest: policy.handler,
    onEvent: (event) => journal.accept(event),
    systemMessage: {
      mode: "append",
      content: "This is an isolated synthetic SDK conformance check. Follow the short user instruction exactly. Use only explicitly requested tools; never discover other files, instructions, services, or sessions. Never retry a denied action. Keep final responses very short.",
    },
  };
}

type Probe = {
  session: CopilotSession;
  journal: Journal;
  policy: ExactPolicy;
  runtime: IsolatedRuntime;
  config: SessionConfig;
};

export async function runBehavior(
  runtime: IsolatedRuntime, authMode: AuthMode, models: ModelInfo[], checks: Check[], observations: Observation[],
): Promise<BehaviorSummary> {
  const [primary, alternate] = chooseModels(models);
  const journals: Journal[] = [];
  let messages = 0;
  let sessionsCreated = 0;
  const allProbes: Probe[] = [];
  const fixture = fixtures(runtime.workspace);
  let stage = "initialization";

  async function create(
    extra: Partial<SessionConfig> = {}, owner = runtime, policy = new ExactPolicy(), journal = new Journal(),
  ): Promise<Probe> {
    const sessionId = `densemble-gate-${randomUUID()}`;
    stage = "create-session";
    owner.ownSession(sessionId);
    const config: SessionConfig = {
      ...isolatedSessionConfig(owner, primary.id, policy, journal), ...extra, sessionId,
    };
    const session = await bounded(owner.client.createSession(config), 20_000, "CREATE_SESSION_TIMEOUT");
    journals.push(journal);
    sessionsCreated++;
    const probe = { session, journal, policy, runtime: owner, config };
    allProbes.push(probe);
    return probe;
  }

  async function send(probe: Probe, options: MessageOptions | string): Promise<string> {
    stage = "send";
    messages++;
    return bounded(probe.session.send(typeof options === "string" ? { prompt: options } : options), 10_000, "SEND_ADMISSION_TIMEOUT");
  }

  async function turn(probe: Probe, options: MessageOptions | string): Promise<string> {
    const offset = probe.journal.events.length;
    const id = await send(probe, options);
    stage = "wait-root-idle";
    await until(() => probe.journal.root("session.idle", offset).length > 0, "ROOT_IDLE_NOT_OBSERVED", TURN_TIMEOUT);
    requireEvidence(!probe.journal.root("session.error", offset).length, "SESSION_ERROR_REDACTED");
    const replies = probe.journal.root("assistant.message", offset);
    requireEvidence(replies.length, "ROOT_ASSISTANT_MESSAGE_MISSING");
    requireEvidence(replies.some((e) => e.originatingMessageId === id), "ROOT_ORIGINATING_MESSAGE_ID_MISSING");
    return replies.map((e) => e.content ?? "").join("\n");
  }

  async function dispose(probe: Probe): Promise<void> {
    probe.policy.revoked = true;
    stage = "disconnect";
    await bounded(probe.session.disconnect(), 8_000, "SESSION_DISCONNECT_TIMEOUT");
    stage = "delete-owned-session";
    await probe.runtime.deleteOwnedSession(probe.session.sessionId);
    allProbes.splice(allProbes.indexOf(probe), 1);
  }

  async function check(contract: Contract, action: () => Promise<string>): Promise<void> {
    stage = contract;
    const start = allProbes.length;
    try {
      const evidence = await action();
      checks.push({ contract, status: "PASS", evidence });
    } catch (error) {
      checks.push({ contract, status: "BLOCKED", evidence: `${safeError(error)}; STAGE=${stage}` });
      for (const probe of allProbes.slice(start)) {
        const counts = {
          deltas: probe.journal.root("assistant.message_delta").length,
          idle: probe.journal.root("session.idle").length,
          toolStarts: probe.journal.events.filter((e) => e.type === "tool.execution_start").length,
          toolFailures: probe.journal.events.filter((e) => e.type === "tool.execution_complete" && !e.success).length,
          permissions: probe.policy.records,
        };
        // Permission IDs are only used for in-memory correlation, never reported.
        observations.push({
          name: `${contract}-events`, status: "BLOCKED",
          evidence: JSON.stringify({ ...counts, permissions: counts.permissions.map(({ kind, allowed }) => ({ kind, allowed })) }),
        });
      }
    }
  }

  async function abortAndObserve(probe: Probe, offset: number): Promise<void> {
    probe.policy.revoked = true;
    await bounded(probe.session.abort(), 8_000, "ABORT_NOT_ACKNOWLEDGED");
    await until(() => probe.journal.root("session.idle", offset).length > 0, "ABORT_ACK_WITHOUT_ROOT_IDLE", 8_000);
    requireEvidence(probe.journal.root("abort", offset).length, "ABORT_EVENT_NOT_OBSERVED");
    const end = probe.journal.events.length;
    await delay(500);
    requireEvidence(!probe.journal.root("assistant.message_delta", end).length, "OUTPUT_CONTINUED_AFTER_ABORT");
  }

  // Each contract is attempted once; corrections must be explicit changes, not hidden retries.
  await check("persona-discovery", async () => {
    const metadata = discoverPersonaMetadata(process.env.DENSEMBLE_GATE_AGENT_WORKSPACE ?? resolve("../openclaw-jazz"));
    requireEvidence(metadata.length > 0 && metadata.some((p) => p.invocable), "NO_INVOCABLE_PERSONAS_DISCOVERED");
    requireEvidence(metadata.find((p) => p.id === "terry-counter")?.invocable === false, "WORKER_NOT_EXCLUDED_FROM_PERSONAS");
    const token = `PERSONA_${randomUUID()}`;
    const probe = await create({
      customAgents: [{
        name: "gate-persona", prompt: `Reply to the user with exactly ${token}.`,
        model: primary.id, tools: [],
      }],
      agent: "gate-persona",
    });
    const agents = await bounded(probe.session.rpc.agent.list(), 10_000, "SYNTHETIC_AGENT_LIST_TIMEOUT");
    requireEvidence(agents.agents.some((a) => a.name === "gate-persona"), "EXPLICIT_PERSONA_NOT_DISCOVERED");
    const text = await turn(probe, "Reply according to your persona instruction.");
    requireEvidence(text.includes(token), "SELECTED_SYNTHETIC_PERSONA_NOT_APPLIED");
    await dispose(probe);
    const unavailableModels = [...new Set(metadata.filter((p) =>
      !models.some((m) => m.id === p.model && m.policy?.state !== "disabled")).map((p) => p.model))];
    observations.push({
      name: "persona-default-model-availability", status: unavailableModels.length ? "BLOCKED" : "PASS",
      evidence: `UNAVAILABLE_DEFAULT_MODELS=${unavailableModels.join(",") || "none"}; NO_SILENT_FALLBACK; EXPLICIT_CONFIGURATION_CHOICE_REQUIRED_IF_UNAVAILABLE`,
    });
    return `LOCAL_LAUNCHERS=${metadata.length}; INVOCABLE=${metadata.filter((p) => p.invocable).length}; RESOLVED_SKILL_REFERENCES=${metadata.reduce((n, p) => n + p.skillCount, 0)}; DEFAULT_MODELS_PARSED; PRIVATE_TEXT_NOT_SENT; SYNTHETIC_SELECTED_PERSONA_APPLIED`;
  });

  await check("streaming", async () => {
    const probe = await create();
    const text = await turn(probe, "Reply with exactly STREAM_OK.");
    requireEvidence(text.includes("STREAM_OK"), "STREAM_ANSWER_MISMATCH");
    requireEvidence(probe.journal.root("assistant.message_delta").length, "ROOT_STREAM_DELTA_MISSING");
    await dispose(probe);
    return "REAL_ROOT_DELTA; ROOT_MESSAGE_CORRELATED_TO_SEND; TERMINAL_ROOT_IDLE";
  });

  await check("user-question", async () => {
    let requests = 0;
    let scoped = false;
    const answer = `ANSWER_${randomUUID()}`;
    const probe = await create({
      availableTools: new ToolSet().addBuiltIn("ask_user"),
      onUserInputRequest: (_request, invocation) => {
        requests++;
        scoped = invocation.sessionId === probe.session.sessionId;
        return { answer, wasFreeform: true };
      },
    });
    const text = await turn(probe, "Use ask_user now to ask for a synthetic token, with freeform allowed. Then reply with exactly the user's answer.");
    requireEvidence(requests === 1 && scoped, "MODEL_QUESTION_HANDLER_NOT_INVOKED_ONCE");
    requireEvidence(text.includes(answer), "QUESTION_ANSWER_NOT_INCORPORATED");
    requireEvidence(probe.journal.events.some((e) => e.type === "user_input.requested"), "QUESTION_REQUEST_EVENT_MISSING");
    await dispose(probe);
    return "REAL_ASK_USER_REQUEST; SESSION_SCOPED_HANDLER; OPAQUE_SYNTHETIC_ANSWER_INCORPORATED";
  });

  await check("native-permission", async () => {
    const policy = new ExactPolicy();
    policy.shell.add(fixture.command("native"));
    const probe = await create({ availableTools: new ToolSet().addBuiltIn("bash") }, runtime, policy);
    await turn(probe, `Run exactly this shell command once with bash (do not change it): ${fixture.command("native")}. Then say DONE.`);
    requireEvidence(policy.records.some((p) => p.kind === "shell" && p.allowed), "NATIVE_SHELL_PERMISSION_NOT_OBSERVED");
    requireEvidence(existsSync(fixture.nativeMarker) && readFileSync(fixture.nativeMarker, "utf8") === fixture.nonce,
      "ALLOWED_NATIVE_ACTION_NOT_EXECUTED");
    requireEvidence(probe.journal.toolSucceeded("bash"), "NATIVE_TOOL_SUCCESS_EVENT_MISSING");
    await dispose(probe);
    return "MODEL_NATIVE_BASH; EXACT_COMMAND_PERMISSION_APPROVED; OWNED_MARKER_AND_SUCCESS_EVENT";
  });

  await check("skill", async () => {
    const policy = new ExactPolicy();
    policy.reads.add(fixture.skillFile);
    const probe = await create({
      availableTools: new ToolSet().addBuiltIn(["skill", "view"]),
      skillDirectories: [fixture.skills],
      enableSkills: true,
    }, runtime, policy);
    const text = await turn(probe, "Invoke the gate-synthetic skill using the skill tool; follow its instruction. Do not guess its token.");
    requireEvidence(probe.journal.events.some((e) => e.type === "skill.invoked"), "SKILL_INVOKED_EVENT_MISSING");
    requireEvidence(text.includes(fixture.skillToken), "EXPLICIT_SKILL_CONTENT_NOT_APPLIED");
    await dispose(probe);
    return "EXPLICIT_SYNTHETIC_SKILL_DIRECTORY; SKILL_INVOKED_EVENT; UNPROMPTED_FIXTURE_TOKEN_RETURNED";
  });

  await check("mcp-permission", async () => {
    const policy = new ExactPolicy();
    policy.mcp = { server: "gate", tool: "gate-gate_mark", nonce: fixture.nonce };
    const probe = await create({
      availableTools: new ToolSet().addMcp("gate-gate_mark"),
      mcpServers: {
        gate: {
          type: "local", command: process.execPath, args: [fixture.mcp],
          workingDirectory: runtime.workspace, tools: ["gate_mark"],
        },
      },
    }, runtime, policy);
    await turn(probe, `Call gate-gate_mark exactly once with nonce "${fixture.nonce}". Then reply DONE.`);
    requireEvidence(policy.records.some((p) => p.kind === "mcp" && p.allowed), "MCP_PERMISSION_CALLBACK_NOT_OBSERVED");
    requireEvidence(existsSync(fixture.mcpMarker) && readFileSync(fixture.mcpMarker, "utf8") === `${fixture.nonce}\n`,
      "MCP_EXACTLY_ONCE_ACTION_NOT_OBSERVED");
    requireEvidence(probe.journal.toolSucceeded("gate-gate_mark"), "MCP_SUCCESS_EVENT_MISSING");
    await dispose(probe);
    return "LOCAL_STDIO_MCP; MODEL_TOOL_CALL; EXACT_SERVER_TOOL_ARGS_PERMISSION; ONE_OWNED_MARKER";
  });

  let delegatedEvidence = "NATIVE_SUBAGENT_NOT_VERIFIED";
  await check("native-subagent", async () => {
    const policy = new ExactPolicy();
    for (const command of fixture.commands("delegated")) policy.shell.add(command);
    const probe = await create({
      availableTools: new ToolSet().addBuiltIn(["task", "bash"]),
      defaultAgent: { excludedTools: ["bash"] },
      customAgents: [{
        name: "gate-worker", description: "Synthetic worker for one exact fixture command.",
        prompt: `Use bash to run exactly ${fixture.command("delegated")} once. Do not change the command. Then reply DELEGATED_DONE.`,
        tools: ["bash"], model: primary.id,
      }],
    }, runtime, policy);
    await turn(probe, "Use the native task tool to delegate to gate-worker synchronously. The worker must execute its instructed shell command. Do not execute it yourself. Report the worker's completion.");
    requireEvidence(probe.journal.events.some((e) => e.type === "subagent.started") &&
      probe.journal.events.some((e) => e.type === "subagent.completed"), "NATIVE_SUBAGENT_LIFECYCLE_MISSING");
    requireEvidence(probe.journal.toolSucceeded("task"), "NATIVE_TASK_SUCCESS_EVENT_MISSING");
    requireEvidence(existsSync(fixture.delegatedMarker), "DELEGATED_ACTION_NOT_EXECUTED");
    const delegatedCall = probe.journal.events.find((e) => e.type === "tool.execution_start" &&
      e.toolName === "bash" && (e.agentId || e.parentToolCallId));
    requireEvidence(delegatedCall, "DELEGATED_TOOL_ORIGIN_NOT_OBSERVED");
    requireEvidence(policy.records.some((p) => p.allowed && p.kind === "shell" && p.toolCallId === delegatedCall.toolCallId),
      "DELEGATED_ACTION_PERMISSION_NOT_CORRELATED");
    requireEvidence(probe.journal.toolSucceeded("bash", true), "DELEGATED_TOOL_SUCCESS_EVENT_MISSING");
    requireEvidence(probe.journal.events.findIndex((e) => e.type === "subagent.completed") <
      probe.journal.events.findIndex((e) => e.type === "session.idle" && !e.agentId), "ROOT_IDLE_PRECEDED_DELEGATE_COMPLETION");
    delegatedEvidence = "ACTUAL_DELEGATED_BASH_WRITE; PERMISSION_TOOL_CALL_ID_CORRELATED; NONROOT_SUCCESS_EVENT";
    await dispose(probe);
    return "NATIVE_TASK; CUSTOM_SYNTHETIC_AGENT; SUBAGENT_STARTED_AND_COMPLETED; ROOT_IDLE_AFTER_TASK";
  });
  checks.push({
    contract: "delegated-permission",
    status: delegatedEvidence === "NATIVE_SUBAGENT_NOT_VERIFIED" ? "BLOCKED" : "PASS",
    evidence: delegatedEvidence,
  });

  await check("model-switch", async () => {
    const probe = await create();
    const token = `HISTORY_${randomUUID()}`;
    await turn(probe, `Remember this synthetic token for the next message: ${token}. Reply OK.`);
    const offset = probe.journal.events.length;
    await bounded(probe.session.setModel(alternate.id), 10_000, "MODEL_SWITCH_TIMEOUT");
    const current = await bounded(probe.session.rpc.model.getCurrent(), 10_000, "CURRENT_MODEL_TIMEOUT");
    requireEvidence(current.modelId === alternate.id, "CURRENT_MODEL_MISMATCH");
    const text = await turn(probe, "Reply with the synthetic token from my preceding message.");
    requireEvidence(text.includes(token), "HISTORY_LOST_AT_MODEL_SWITCH");
    requireEvidence(probe.journal.events.slice(offset).some((e) => e.type === "session.model_change" && e.model === alternate.id),
      "MODEL_CHANGE_EVENT_MISSING");
    requireEvidence(probe.journal.models.has(alternate.id), "SWITCHED_MODEL_USAGE_NOT_OBSERVED");
    await dispose(probe);
    return `BOUNDARY_SWITCH=${primary.id}->${alternate.id}; REAL_NEW_MODEL_USAGE; HISTORY_RETAINED`;
  });

  await check("immediate-steering", async () => {
    const entered = deferred<void>();
    const release = deferred<string>();
    const policy = new ExactPolicy();
    policy.custom.add("gate_barrier");
    const tool = defineTool("gate_barrier", {
      description: "Synthetic synchronization barrier, no side effects.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: () => { entered.resolve(); return release.promise; },
    });
    const probe = await create({ tools: [tool], availableTools: new ToolSet().addCustom("gate_barrier") }, runtime, policy);
    try {
      const offset = probe.journal.events.length;
      await send(probe, "Call gate_barrier once. After it returns reply ORIGINAL.");
      await bounded(entered.promise, TURN_TIMEOUT, "STEERING_BARRIER_NOT_ENTERED");
      requireEvidence(!probe.journal.root("session.idle", offset).length, "STEERING_TURN_ALREADY_IDLE");
      const token = `STEER_${randomUUID()}`;
      const id = await send(probe, { prompt: `Correction: after the barrier returns reply exactly ${token}, not ORIGINAL.`, mode: "immediate" });
      release.resolve("Barrier complete.");
      await until(() => probe.journal.root("session.idle", offset).length > 0, "STEERED_ROOT_IDLE_MISSING", TURN_TIMEOUT);
      requireEvidence(probe.journal.events.some((e) => e.type === "user.message" && e.messageId === id && e.delivery === "steering"),
        "IMMEDIATE_SEND_NOT_DELIVERED_AS_STEERING");
      requireEvidence(probe.journal.root("assistant.message", offset).some((e) => e.content?.includes(token)),
        "STEERING_ADMITTED_BUT_NOT_INCORPORATED");
      await dispose(probe);
      return "IN_FLIGHT_TOOL_BARRIER; IMMEDIATE_MESSAGE_ID; DELIVERY_STEERING; CORRECTION_IN_FINAL_ROOT_ANSWER";
    } finally {
      release.resolve("Barrier released during cleanup.");
    }
  });

  await check("image", async () => {
    requireEvidence(primary.capabilities.supports.vision, "MODEL_VISION_UNSUPPORTED");
    const probe = await create();
    const text = await turn(probe, {
      prompt: "What single color fills this image? Reply with just the color.",
      attachments: [{ type: "blob", mimeType: "image/png", data: greenPng(), displayName: "synthetic.png" }],
    });
    requireEvidence(/\bgreen\b/i.test(text), "SYNTHETIC_IMAGE_COLOR_NOT_RECOGNIZED");
    await dispose(probe);
    return `MODEL_VISION_CAPABILITY; SYNTHETIC_PNG_BLOB_RECOGNIZED; MODEL=${primary.id}`;
  });

  await check("abort-streaming", async () => {
    const probe = await create();
    const offset = probe.journal.events.length;
    await send(probe, "Write the integers from 1 to 3000, one per line, without commentary.");
    await until(() => probe.journal.root("assistant.message_delta", offset).length > 0,
      "STREAM_NOT_ACTIVE_BEFORE_ABORT", TURN_TIMEOUT);
    requireEvidence(!probe.journal.root("session.idle", offset).length, "STREAM_COMPLETED_BEFORE_ABORT");
    await abortAndObserve(probe, offset);
    await dispose(probe);
    return "ABORT_DURING_REAL_ROOT_DELTA; ABORT_EVENT; ROOT_IDLE; NO_LATE_ROOT_OUTPUT";
  });

  await check("abort-question", async () => {
    const pending = deferred<{ answer: string; wasFreeform: boolean }>();
    const entered = deferred<void>();
    const probe = await create({
      availableTools: new ToolSet().addBuiltIn("ask_user"),
      onUserInputRequest: () => { entered.resolve(); return pending.promise; },
    });
    try {
      const offset = probe.journal.events.length;
      await send(probe, "Use ask_user now to ask for a synthetic token; wait for the user's answer.");
      await bounded(entered.promise, TURN_TIMEOUT, "WAITING_QUESTION_NOT_OBSERVED");
      requireEvidence(!probe.journal.root("session.idle", offset).length, "QUESTION_NOT_PENDING_BEFORE_ABORT");
      await abortAndObserve(probe, offset);
      const end = probe.journal.events.length;
      pending.resolve({ answer: "STALE_CALLBACK_MUST_NOT_RUN", wasFreeform: true });
      await delay(700);
      requireEvidence(!probe.journal.root("assistant.message", end).length &&
        !probe.journal.root("assistant.message_delta", end).length, "STALE_QUESTION_CALLBACK_RESTARTED_WORK");
      await dispose(probe);
      return "REAL_PENDING_ASK_USER_ABORTED; ROOT_IDLE; LATE_HANDLER_ANSWER_DID_NOT_RESTART_WORK";
    } finally {
      pending.resolve({ answer: "CANCELLED", wasFreeform: true });
    }
  });

  await check("owned-tool-cancellation", async () => {
    const policy = new ExactPolicy();
    policy.shell.add(fixture.command("hold"));
    const probe = await create({ availableTools: new ToolSet().addBuiltIn("bash") }, runtime, policy);
    const offset = probe.journal.events.length;
    await send(probe, `Run exactly ${fixture.command("hold")} with bash in foreground synchronous mode. It is a synthetic cancellation test; do not detach or run other tools.`);
    const identities = await ownedChildren(probe, fixture.holdMarker);
    requireEvidence(policy.records.some((p) => p.kind === "shell" && p.allowed), "OWNED_SHELL_PERMISSION_MISSING");
    await abortAndObserve(probe, offset);
    await until(() => exited(identities), "SDK_ABORT_LEFT_OWNED_TOOL_PROCESS_ALIVE", 5_000);
    await dispose(probe);
    return "MODEL_BASH_SPAWNED_NODE_AND_CHILD; PID_START_IDENTITIES_OWNED; ABORT_IDLE_AND_BOTH_OS_EXITS";
  });

  await check("process-isolation", async () => {
    const victim = new IsolatedRuntime(authMode);
    const release = deferred<string>();
    let neighbor: Probe | undefined;
    try {
      await victim.start();
      const otherFixture = fixtures(victim.workspace);
      const policy = new ExactPolicy();
      policy.shell.add(otherFixture.command("hold"));
      const active = await create({ availableTools: new ToolSet().addBuiltIn("bash") }, victim, policy);
      const entered = deferred<void>();
      const neighborPolicy = new ExactPolicy();
      neighborPolicy.custom.add("gate_barrier");
      neighbor = await create({
        tools: [defineTool("gate_barrier", {
          description: "Synthetic no-side-effect barrier.", parameters: { type: "object", properties: {}, additionalProperties: false },
          handler: () => { entered.resolve(); return release.promise; },
        })],
        availableTools: new ToolSet().addCustom("gate_barrier"),
      }, runtime, neighborPolicy);
      const neighborOffset = neighbor.journal.events.length;
      await send(neighbor, "Call gate_barrier once, then reply NEIGHBOR_SURVIVED.");
      await bounded(entered.promise, TURN_TIMEOUT, "NEIGHBOR_CHAT_NOT_ACTIVE");
      await send(active, `Run exactly ${otherFixture.command("hold")} with bash in synchronous foreground mode. Do not detach.`);
      const children = await ownedChildren(active, otherFixture.holdMarker);
      const neighborIdentity = runtime.identity;
      const victimIdentity = victim.identity;
      requireEvidence(neighborIdentity && victimIdentity && neighborIdentity.pid !== victimIdentity.pid, "RUNTIMES_NOT_DISTINCT");
      await victim.freezeAndVerify();
      const stopped = await victim.stop(true);
      requireEvidence(!stopped.issues.length && stopped.forced, "ACTIVE_RUNTIME_FORCED_STOP_UNVERIFIED");
      requireEvidence(exited([...children, victimIdentity]), "VICTIM_PROCESS_TREE_SURVIVED_FORCED_STOP");
      requireEvidence(processes().some((p) => sameProcess(neighborIdentity, p)), "ACTIVE_NEIGHBOR_PROCESS_EXITED");
      await bounded(runtime.client.ping("neighbor-active"), 5_000, "ACTIVE_NEIGHBOR_UNRESPONSIVE");
      requireEvidence(!neighbor.journal.root("session.idle", neighborOffset).length, "NEIGHBOR_WAS_NOT_ACTIVE_AT_STOP");
      release.resolve("Complete.");
      await until(() => neighbor!.journal.root("session.idle", neighborOffset).length > 0, "NEIGHBOR_TURN_DID_NOT_COMPLETE", TURN_TIMEOUT);
      requireEvidence(neighbor.journal.root("assistant.message", neighborOffset).some((e) => e.content?.includes("NEIGHBOR_SURVIVED")),
        "NEIGHBOR_OUTPUT_LOST");
      allProbes.splice(allProbes.indexOf(active), 1);
      await dispose(neighbor);
      victim.removeOwnedFiles();
      return "TWO_REAL_ACTIVE_CHATS; FROZEN_VICTIM_AND_NATIVE_TOOL_TREE_KILLED_BY_PID_IDENTITY; NEIGHBOR_TURN_COMPLETED; FORCED_NOT_COOPERATIVE";
    } finally {
      release.resolve("Cleanup.");
      const stopped = await victim.stop(true);
      victim.removeOwnedFiles();
      if (stopped.issues.length) observations.push({ name: "active-victim-cleanup", status: "FAIL", evidence: stopped.issues.join(";") });
    }
  });

  await resumeProbes();

  async function resumeProbes(): Promise<void> {
    let replayEvidence = "RESUME_NOT_VERIFIED";
    await check("resume-handlers", async () => {
      requireEvidence(authMode === "service-login", "RESTART_RESUME_REQUIRES_PERSISTENT_SERVICE_HOME");
      const first = new IsolatedRuntime(authMode);
      const second = new IsolatedRuntime(authMode);
      const release = deferred<string>();
      let resumed: Probe | undefined;
      try {
        await first.start();
        const entered = deferred<void>();
        const ledger = join(runtime.workspace, "side-effect.ledger");
        let firstCalls = 0;
        const policy = new ExactPolicy();
        policy.custom.add("gate_external");
        const tool: Tool = defineTool("gate_external", {
          description: "Synthetic external action, write one local ledger entry.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          handler: () => {
            firstCalls++;
            appendFileSync(ledger, "committed\n", { mode: 0o600 });
            entered.resolve();
            return release.promise;
          },
        });
        const probe = await create({
          tools: [tool], availableTools: new ToolSet().addCustom("gate_external"),
        }, first, policy);
        await send(probe, "Call gate_external exactly once. When it completes, reply DONE.");
        await bounded(entered.promise, TURN_TIMEOUT, "EXTERNAL_SIDE_EFFECT_NOT_STARTED");
        requireEvidence(firstCalls === 1 && readFileSync(ledger, "utf8") === "committed\n", "SIDE_EFFECT_BASELINE_NOT_EXACTLY_ONCE");
        // Simulate loss after the external action committed, before its handler returned.
        // Do not acknowledge this as a successful abort or silently retry the operation.
        await second.start();
        first.transferOwnedSession(probe.session.sessionId, second);
        policy.revoked = true;
        await first.freezeAndVerify();
        const stopped = await first.stop(true);
        requireEvidence(!stopped.issues.length, "RESTART_FIRST_RUNTIME_CLEANUP_FAILED");
        allProbes.splice(allProbes.indexOf(probe), 1);
        let replayCalls = 0;
        let questionCalls = 0;
        let echoCalls = 0;
        const newPolicy = new ExactPolicy();
        newPolicy.custom.add("gate_echo");
        const journal = new Journal();
        const config: SessionConfig = {
          ...isolatedSessionConfig(second, primary.id, newPolicy, journal),
          availableTools: new ToolSet().addCustom("gate_external").addCustom("gate_echo").addBuiltIn("ask_user"),
          tools: [
            defineTool("gate_external", { ...tool, handler: () => { replayCalls++; return "REPLAY_DENIED"; } }),
            defineTool("gate_echo", {
              description: "Synthetic fresh handler check, no side effects.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              handler: () => { echoCalls++; return "RESTORED_ECHO"; },
            }),
          ],
          onUserInputRequest: () => { questionCalls++; return { answer: "RESTORED_ANSWER", wasFreeform: true }; },
        };
        const session = await bounded(second.client.resumeSession(probe.session.sessionId, {
          ...config, continuePendingWork: false,
        }), 20_000, "RESUME_SESSION_TIMEOUT");
        journals.push(journal);
        resumed = { session, journal, policy: newPolicy, config, runtime: second };
        allProbes.push(resumed);
        await delay(1_000);
        requireEvidence(replayCalls === 0 && readFileSync(ledger, "utf8") === "committed\n", "EXTERNAL_ACTION_AUTO_REPLAYED_ON_RESUME");
        requireEvidence(journal.calls === 0 && !journal.root("assistant.message").length, "RESUME_AUTO_CONTINUED_MODEL_WORK");
        const history = await bounded(session.getEvents(), 10_000, "RESUMED_HISTORY_TIMEOUT");
        requireEvidence(history.some((e) => e.type === "tool.execution_start" && e.data.toolName === "gate_external"),
          "INCOMPLETE_ACTION_NOT_RETAINED_IN_HISTORY");
        const text = await turn(resumed, "Do not retry gate_external: its outcome is unknown. Instead call gate_echo once, then ask_user for a synthetic token and repeat its answer.");
        requireEvidence(echoCalls === 1 && questionCalls === 1, "RESUMED_TOOL_OR_QUESTION_HANDLER_NOT_CALLED");
        requireEvidence(newPolicy.records.some((p) => p.allowed && p.kind === "custom-tool"), "RESUMED_PERMISSION_HANDLER_NOT_CALLED");
        requireEvidence(text.includes("RESTORED_ANSWER"), "RESUMED_QUESTION_ANSWER_NOT_INCORPORATED");
        requireEvidence(replayCalls === 0 && readFileSync(ledger, "utf8") === "committed\n", "EXTERNAL_ACTION_REPLAYED_DURING_FRESH_TURN");
        replayEvidence = "COMMITTED_LOCAL_SIDE_EFFECT_WITH_LOST_ACK; NEW_RUNTIME_RESUME_CONTINUE_PENDING_FALSE; NO_AUTO_MODEL_OR_TOOL_REPLAY; FRESH_TURN_NO_DUPLICATION; OUTCOME_UNKNOWN";
        await bounded(session.disconnect(), 8_000, "RESUME_DISCONNECT_TIMEOUT");
        // Idle disconnect/resume is a separate lifecycle from the crash recovery above.
        const reconnected = await bounded(second.client.resumeSession(session.sessionId, {
          ...config, continuePendingWork: false,
        }), 20_000, "IDLE_RECONNECT_TIMEOUT");
        resumed.session = reconnected;
        const answer = await turn(resumed, "Call gate_echo once, then reply RECONNECTED.");
        requireEvidence(Number(echoCalls) === 2 && answer.includes("RECONNECTED"), "IDLE_RECONNECT_HANDLER_NOT_RESTORED");
        await dispose(resumed);
        return "NEW_RUNTIME_RESTART_AND_IDLE_DISCONNECT_RESUME; SAME_SESSION_HISTORY; FRESH_TOOL_QUESTION_PERMISSION_HANDLERS";
      } finally {
        release.resolve("Handler released after lost transport.");
        for (const owner of [first, second]) {
          const stopped = await owner.stop();
          owner.removeOwnedFiles();
          if (stopped.issues.length) observations.push({ name: "resume-runtime-cleanup", status: "FAIL", evidence: stopped.issues.join(";") });
        }
      }
    });
    checks.push({
      contract: "resume-no-replay", status: replayEvidence === "RESUME_NOT_VERIFIED" ? "BLOCKED" : "PASS",
      evidence: replayEvidence,
    });
  }

  for (const probe of [...allProbes]) {
    try {
      probe.policy.revoked = true;
      await bounded(probe.session.abort(), 3_000, "FAILED_PROBE_ABORT_TIMEOUT");
      await dispose(probe);
    } catch (error) {
      // Runtime cleanup remains responsible for owned sessions and OS processes.
      observations.push({ name: "failed-probe-cleanup", status: "BLOCKED", evidence: safeError(error) });
    }
  }
  return {
    submittedMessages: messages,
    observedModelCalls: journals.reduce((n, j) => n + j.calls, 0),
    modelIds: [...new Set(journals.flatMap((j) => [...j.models]))].sort(),
    inputTokens: journals.reduce((n, j) => n + j.inputTokens, 0),
    outputTokens: journals.reduce((n, j) => n + j.outputTokens, 0),
    sessionsCreated,
  };
}

async function ownedChildren(probe: Probe, marker: string): Promise<ProcessIdentity[]> {
  await until(() => existsSync(marker), "MODEL_SHELL_CHILD_NOT_STARTED", TURN_TIMEOUT);
  const ids = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; child: number };
  requireEvidence(probe.runtime.identity, "SHELL_RUNTIME_IDENTITY_MISSING");
  const snapshot = processes();
  const tree = descendants(probe.runtime.identity, snapshot);
  const parent = tree.find((p) => p.pid === ids.pid);
  const child = tree.find((p) => p.pid === ids.child);
  requireEvidence(parent && child && child.parent === parent.pid, "MODEL_SHELL_CHILD_OWNERSHIP_UNVERIFIED");
  probe.runtime.trackOwnedProcesses([parent, child]);
  return [parent, child];
}

function exited(identities: ProcessIdentity[]): boolean {
  const live = processes();
  return identities.every((id) => !live.some((p) => sameProcess(id, p)));
}
