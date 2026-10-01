import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Chat, Message, Update, User, UserFromGetMe } from "grammy/types";
import { expect, it } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";
import type { RuntimeCommand, RuntimeEvent } from "../../src/domain.js";
import type { AgentRuntime } from "../../src/ports.js";
import type { ControlledSessionOptions } from "../../src/agents/contracts.js";
import { createApplication } from "../../src/application/index.js";
import { createMediaPipeline } from "../../src/media/index.js";
import { createTelegramAdapter, type TelegramApi } from "../../src/telegram/index.js";
import { RateLimiter } from "../../src/telegram/common.js";
import { openStore } from "../../src/storage/index.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("FLOW_TIMEOUT");
    await pause(5);
  }
}

it("wires authorized durable Telegram ingress through document workers, runtime events and one outbox consumer", async () => {
  mkdirSync(resolve(".cache"), { recursive: true });
  const root = mkdtempSync(resolve(".cache", "service-flow-"));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  const home = join(root, "copilot");
  for (const path of [workspace, data, home]) mkdirSync(path);
  const canonical = join(workspace, "AGENT.md");
  writeFileSync(canonical, "Synthetic persona.");
  const config: LoadedConfig = {
    config: { workspacePath: workspace, agentDefinitionsPath: workspace, agentLaunchersPath: workspace,
      secretsPath: join(workspace, "secrets.local.json"), runtimeDataPath: data, runtimeHomePath: home,
      skillDirectories: [], ownerId: 101, bots: [{ id: "helper", agentId: "helper", tokenRef: "telegram.helper" }],
      bindings: [{ botId: "helper", chatId: 101, topicId: null, kind: "private" }], mcp: { mode: "none" } },
    agents: [{ id: "helper", description: "Synthetic", defaultModel: "example", userInvocable: true,
      canonicalPath: canonical, launcherPath: canonical }],
    tokenForBot: () => "701:synthetic", resolveSecret: () => "synthetic",
  };
  const identity: UserFromGetMe = {
    id: 701, is_bot: true, first_name: "Synthetic", username: "SyntheticBot",
    can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  };
  const message = (id: number, owner = 101): Message.TextMessage & { chat: Chat.PrivateChat; from: User } => ({
    message_id: id, date: 1, chat: { id: 101, type: "private", first_name: "Synthetic" },
    from: { id: owner, is_bot: false, first_name: "Synthetic" }, text: "Read this note",
  });
  const updates: Update[] = [{ update_id: 1, message: message(1, 999) }, {
    update_id: 2, message: { ...message(2), document: {
      file_id: "document", file_unique_id: "unique", file_name: "note.txt", mime_type: "text/plain", file_size: 14,
    } },
  }];
  const sent: string[] = [];
  let remoteId = 100;
  let downloads = 0;
  const api: TelegramApi = {
    getMe: async () => identity,
    getWebhookInfo: async () => ({ url: "", pending_update_count: 0, has_custom_certificate: false }),
    getUpdates: async (_payload, signal) => {
      await pause(5, undefined, { ...(signal ? { signal } : {}) });
      return updates.splice(0);
    },
    sendMessage: async (payload) => { sent.push(payload.text); return { ...message(++remoteId), from: identity, text: payload.text }; },
    sendDocument: async () => ({ ...message(++remoteId), document: { file_id: "output", file_unique_id: "output" } }),
    editMessageText: async () => true,
    answerCallbackQuery: async () => true,
    sendChatAction: async () => true,
    deleteMessage: async () => true,
    getFile: async () => ({ file_id: "document", file_unique_id: "unique", file_path: "documents/note.txt", file_size: 14 }),
  };
  const store = openStore({ path: join(data, "state.sqlite") });
  const commands: RuntimeCommand[] = [];
  const hooks = new Map<string, ControlledSessionOptions>();
  const runtime: AgentRuntime = {
    open: async (options: ControlledSessionOptions) => {
      hooks.set(options.session.id, options);
      return { providerSessionId: `densemble-${options.session.id}` };
    },
    execute: async (command) => {
      commands.push(command);
      if (command.kind === "stop") hooks.get(command.identity.sessionId)?.onEvent({
        ...command.identity, kind: "stopped", forced: false, externalOutcomeUnknown: true,
      });
    },
    models: async () => [{ id: "example", name: "Example", supportsImages: true }],
    setModel: async () => {}, disconnect: async () => {}, deleteSession: async () => {}, shutdown: async () => {},
  };
  const diagnostics = { record: (_code: string) => {} };
  let clock = Date.now();
  const limiter = new RateLimiter(async (ms, signal) => { signal.throwIfAborted(); clock += ms; }, () => clock);
  let media: ReturnType<typeof createMediaPipeline>;
  const telegram = createTelegramAdapter({
    config, store, diagnostics, apiFactory: () => api, limiter,
    resolveAttachment: (scope, id) => media.resolveAttachment(scope, id),
    fetch: async () => { downloads++; return new Response("Synthetic note", { status: 200, headers: { "content-length": "14" } }); },
  });
  media = createMediaPipeline({ config, store, diagnostics, download: telegram.downloadFile });
  const app = createApplication({ config, store, runtime, media, delivery: telegram.transport, diagnostics,
    refreshAgents: false });
  const emit = (event: RuntimeEvent) => hooks.get(event.sessionId)?.onEvent(event);
  try {
    await app.start(store.recover());
    await telegram.start(app);
    await until(() => commands.some((command) => command.kind === "send"));
    const first = commands.find((command) => command.kind === "send")!;
    expect(first.kind).toBe("send");
    if (first.kind !== "send") throw new Error("EXPECTED_SEND");
    expect(first.input.text).toContain("Synthetic note");
    expect(downloads).toBe(1);
    expect(store.inbox.offset("helper")).toBe(3);
    emit({ ...first.identity, kind: "completed", text: "Document result" });
    await until(() => sent.some((text) => text.includes("Document result")));
    expect(store.runs.get(first.identity.scope, first.identity.runId)?.status).toBe("succeeded");
    updates.push({ update_id: 3, message: message(2) });
    await until(() => store.inbox.offset("helper") === 4);
    expect(commands.filter((command) => command.kind === "send")).toHaveLength(1);
    expect(downloads).toBe(1);
    updates.push({ update_id: 4, message: message(4) });
    await until(() => commands.filter((command) => command.kind === "send").length === 2);
    const stop = { ...message(5), text: "/stop", entities: [{ type: "bot_command" as const, offset: 0, length: 5 }] };
    updates.push({ update_id: 5, message: stop });
    await until(() => commands.some((command) => command.kind === "stop"));
    await until(() => store.runs.active(first.identity.scope) === null);
    expect(sent.filter((text) => text.includes("Document result"))).toHaveLength(1);
  } finally {
    await telegram.stop();
    await app.shutdown();
    store.close();
    rmSync(root, { recursive: true });
  }
}, 15_000);
