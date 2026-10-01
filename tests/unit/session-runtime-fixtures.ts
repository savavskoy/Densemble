import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";
import type { IncomingMessage, LogicalInput, OutboxItem, RunIdentity, RuntimeCommand, RuntimeEvent, Scope } from "../../src/domain.js";
import type { AgentRuntime, DeliveryTransport } from "../../src/ports.js";
import type { ControlledSessionOptions } from "../../src/agents/contracts.js";
import { createApplication } from "../../src/application/index.js";
import { isMenuPayload } from "../../src/application/menu.js";
import type { ApplicationMedia, ApplicationOptions } from "../../src/application/index.js";
import { openStore } from "../../src/storage/index.js";

export const scope: Scope = { ownerId: 101, botId: "synthetic-bot", chatId: 101, topicId: null };
export const neighbor: Scope = { ...scope, chatId: -201, topicId: 2 };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
export async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TEST_CONDITION_TIMEOUT");
    await new Promise((done) => setTimeout(done, 2));
  }
}
export function fixture({ autoDelivery = true, ...extra }: Partial<ApplicationOptions> & { autoDelivery?: boolean } = {}) {
  const root = resolve(".cache", `session-runtime-${randomUUID()}`);
  const workspace = join(root, "workspace");
  const canonical = join(workspace, "AGENT.md");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(canonical, "Synthetic testing persona. No external actions.");
  const config: LoadedConfig = {
    config: {
      workspacePath: workspace, agentDefinitionsPath: workspace, agentLaunchersPath: workspace,
      secretsPath: join(root, "secrets.local.json"), runtimeDataPath: root, runtimeHomePath: join(root, "home"),
      skillDirectories: [workspace], ownerId: scope.ownerId,
      bots: [{ id: scope.botId, agentId: "synthetic-agent", tokenRef: "synthetic.bot" }],
      bindings: [
        { botId: scope.botId, chatId: scope.chatId, topicId: null, kind: "private" },
        { botId: neighbor.botId, chatId: neighbor.chatId, topicId: neighbor.topicId, kind: "forum" },
      ],
      mcp: { mode: "none" },
    },
    agents: [{ id: "synthetic-agent", description: "Synthetic agent", defaultModel: "model-one", userInvocable: true,
      canonicalPath: canonical, launcherPath: canonical }],
    resolveSecret: () => "synthetic-secret", tokenForBot: () => "123456:synthetic",
  };
  const store = openStore({ path: join(root, "state.sqlite") });
  const hooks = new Map<string, ControlledSessionOptions>();
  const commands: RuntimeCommand[] = [];
  const runtime: AgentRuntime = {
    open: vi.fn(async (options: ControlledSessionOptions) => {
      hooks.set(options.session.id, options);
      return { providerSessionId: `densemble-${options.session.id}` };
    }),
    execute: vi.fn(async (command: RuntimeCommand) => { commands.push(command); }),
    setModel: vi.fn(async () => undefined),
    models: vi.fn(async () => Array.from({ length: 10 }, (_, i) => ({
      id: i === 0 ? "model-one" : `model-${i + 1}`, name: `Модель ${i + 1}`, supportsImages: i !== 2,
    }))),
    disconnect: vi.fn(async () => undefined), deleteSession: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined),
  };
  const media: ApplicationMedia = {
    prepare: vi.fn(async (input: LogicalInput) => ({
      text: input.messages.map((entry) => entry.text).join("\n"), images: [], attachmentIds: [], notices: [],
    })),
    transcribe: vi.fn(async () => "Синтетична відповідь"),
    exportFile: vi.fn(async (identity: RunIdentity) => store.attachments.add({
      scope: identity.scope, sessionId: identity.sessionId, runId: identity.runId, kind: "output",
      relativePath: "output/synthetic.txt", fileName: "synthetic.txt", mimeType: "text/plain", sizeBytes: 10,
    })),
    cleanup: vi.fn(async () => undefined),
    releaseRun: vi.fn(),
    removeArtifacts: vi.fn(async () => undefined),
  };
  const delivered: OutboxItem[] = [];
  let remoteId = 500;
  const delivery: DeliveryTransport = {
    deliver: vi.fn(async (item: OutboxItem) => { delivered.push(item); return { status: "sent" as const, remoteMessageIds: [++remoteId] }; }),
    preview: vi.fn(async () => undefined), acknowledgeCallback: vi.fn(async () => undefined),
    invalidatePreview: vi.fn(async () => undefined),
  };
  const diagnostics = { record: vi.fn() };
  const app = createApplication({ config, store, runtime, media, delivery, diagnostics, refreshAgents: false,
    idleReleaseMs: 60_000, stopTimeoutMs: 250, ...extra });
  let deliveryWork: Promise<void> | undefined;
  function flushDeliveries(): Promise<void> {
    if (deliveryWork) return deliveryWork;
    deliveryWork = (async () => {
      for (;;) {
        const item = store.outbox.claim();
        if (!item) return;
        if (item.payload.kind === "request") {
          const request = store.requests.get(item.scope, item.payload.requestId);
          if (!request || request.status !== "pending" || !store.runs.isLive(request) || request.expiresAt <= Date.now()) {
            store.outbox.settle(item.id, item.attempts, { status: "failed", errorCode: "REQUEST_EXPIRED" });
            continue;
          }
        }
        try {
          const outcome = await delivery.deliver(item);
          const promptId = outcome.remoteMessageIds?.at(-1);
          if (item.payload.kind === "request" && outcome.status === "sent" && promptId !== undefined) {
            store.requests.setPrompt(item.scope, item.payload.requestId, promptId);
          }
          store.outbox.settle(item.id, item.attempts, outcome);
        } catch {
          store.outbox.settle(item.id, item.attempts, { status: "uncertain", errorCode: "DELIVERY_UNCERTAIN" });
        }
      }
    })().finally(() => { deliveryWork = undefined; });
    return deliveryWork;
  }
  // Test-only transport worker; production delivery belongs exclusively to Telegram.
  const drainApplication = app.drain.bind(app);
  app.drain = async () => {
    await drainApplication();
    if (autoDelivery) await flushDeliveries();
  };
  let sequence = 0;
  function message(text = "Синтетичний запит", target = scope, properties: Partial<IncomingMessage> = {}): IncomingMessage {
    sequence++;
    return { kind: "message", scope: target, chatKind: target.topicId === null ? "private" : "forum",
      text, updateId: sequence, messageId: sequence, receivedAt: Date.now(), attachments: [], ...properties };
  }
  function command(name: string, target = scope): IncomingMessage {
    return message(`/${name}`, target, { command: { name, arguments: "" } });
  }
  function emit(event: RuntimeEvent): void { hooks.get(event.sessionId)?.onEvent(event); }
  function button(label: string, target = scope) {
    const candidates = store.outbox.list(target).filter((entry) => (entry.payload.kind === "request" || isMenuPayload(entry.payload)) &&
      entry.payload.buttons.some((row) => row.some((button) => button.text.includes(label))));
    const item = candidates.at(-1);
    if (!item || (item.payload.kind !== "request" && !isMenuPayload(item.payload))) throw new Error(`TEST_BUTTON_NOT_FOUND:${label}`);
    const data = item.payload.buttons.flat().find((entry) => entry.text.includes(label))!.data;
    return { item, data };
  }
  async function click(label: string, target = scope, override?: { data: string; messageId: number }): Promise<void> {
    if (autoDelivery) await flushDeliveries();
    const entry = override ?? (() => {
      const { item, data } = button(label, target);
      return { data, messageId: item.remoteMessageIds.at(-1)! };
    })();
    sequence++;
    await app.handle({ kind: "callback", scope: target, chatKind: target.topicId === null ? "private" : "forum",
      updateId: sequence, messageId: entry.messageId, receivedAt: Date.now(), callbackId: `cb-${sequence}`, data: entry.data });
    if (autoDelivery) await flushDeliveries();
  }
  async function close() {
    await app.shutdown();
    store.close(); rmSync(root, { recursive: true, force: true });
  }
  return { root, config, store, runtime, media, delivery, diagnostics, app, hooks, commands, delivered,
    message, command, emit, button, click, flushDeliveries, close };
}
