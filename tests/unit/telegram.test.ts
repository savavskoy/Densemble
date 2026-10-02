import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { open, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Api, GrammyError, InputFile } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";
import type { IncomingMessage, NormalizedIngress, Scope } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { openStore } from "../../src/storage/index.js";
import { RateLimiter } from "../../src/telegram/common.js";
import { createDeliveryTransport } from "../../src/telegram/delivery.js";
import { downloadTelegramFile, openUpload, TELEGRAM_DOWNLOAD_LIMIT, TELEGRAM_UPLOAD_LIMIT } from "../../src/telegram/files.js";
import { createTelegramAdapter, normalizeUpdate, renderTelegramHtml, type TelegramAdapter, type TelegramApi } from "../../src/telegram/index.js";

let root: string;
let store: StateStore;
let config: LoadedConfig;
let adapters: TelegramAdapter[];
const scope: Scope = { ownerId: 101, botId: "bot-one", chatId: 101, topicId: null };
const identity: UserFromGetMe = {
  id: 701, is_bot: true, first_name: "Synthetic", username: "SyntheticBot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
  has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
const diagnostics = { record: vi.fn() };
const fastLimiter = () => {
  let now = 0;
  return new RateLimiter(async (ms, signal) => { signal.throwIfAborted(); now += ms; }, () => now);
};
const clockLimiter = () => new RateLimiter(async (ms, signal) => {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
  signal.throwIfAborted();
}, () => Date.now());
function message(overrides: Record<string, unknown> = {}): Message {
  return {
    message_id: 1, date: 100, chat: { id: 101, type: "private", first_name: "Synthetic" },
    from: { id: 101, is_bot: false, first_name: "Synthetic" }, text: "hello", ...overrides,
  } as Message;
}
function update(id: number, overrides: Record<string, unknown> = {}): Update {
  return { update_id: id, message: message({ message_id: id + 1, ...overrides }) } as Update;
}
function incoming(id = 100): IncomingMessage {
  return { kind: "message", scope, chatKind: "private", updateId: id, messageId: id, receivedAt: Date.now(), text: "synthetic", attachments: [] };
}
function session(target = scope) {
  return store.sessions.current(target) ?? store.sessions.create(target, { agentId: "first", workspace: root, model: "synthetic" });
}
function run() {
  return store.inbox.admit(incoming(), { sessionId: session().id, reserveRun: true }).run!;
}
function accepted(ingress: NormalizedIngress) {
  if (ingress.kind === "callback" || ingress.command) store.inbox.recordControl(ingress);
  else store.inbox.admit(ingress, { sessionId: session(ingress.scope).id });
}
type FakeHandler = (payload: Record<string, unknown>, signal?: AbortSignal) => unknown | Promise<unknown>;
function fakeApi(handlers: Record<string, FakeHandler> = {}, botIdentity = identity) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api(`${botIdentity.id}:synthetic_token`);
  let messageId = 500;
  api.config.use(async (_previous, method, payload, signal) => {
    const data = payload as Record<string, unknown>;
    calls.push({ method, payload: data });
    let result: unknown;
    if (handlers[method]) result = await handlers[method]!(data, signal as unknown as AbortSignal);
    else if (method === "getMe") result = botIdentity;
    else if (method === "getWebhookInfo") result = { url: "", pending_update_count: 0 };
    else if (method === "getUpdates") result = [];
    else if (method === "getFile") result = { file_id: "synthetic", file_unique_id: "unique", file_path: "documents/file_1.txt" };
    else if (method === "sendMessage" || method === "sendDocument" || method === "editMessageText") result = message({ message_id: ++messageId, from: botIdentity });
    else result = true;
    return { ok: true, result } as never;
  });
  return { api: api.raw as unknown as TelegramApi, calls };
}
function apiError(code: number, description = "Synthetic rejection", retryAfter?: number) {
  return new GrammyError("Sanitized synthetic failure", {
    ok: false, error_code: code, description, ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  }, "synthetic", {});
}
function transport(api: TelegramApi, resolver?: (target: Scope, id: string) => Promise<{ path: string; fileName: string; mimeType: string }>) {
  return createDeliveryTransport({ config, store, diagnostics, apiForBot: () => api,
    signal: new AbortController().signal, limiter: fastLimiter(), ...(resolver ? { resolveAttachment: resolver } : {}) });
}
function enqueue(text = "Hello", target = scope, replyToMessageId?: number) {
  return store.outbox.enqueue({
    scope: target, sessionId: session(target).id, dedupKey: randomUUID(), payload: { kind: "text", text },
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  });
}
function adapter(api: TelegramApi, extra: Partial<Parameters<typeof createTelegramAdapter>[0]> = {}) {
  const result = createTelegramAdapter({ config, store, diagnostics, apiFactory: () => api, limiter: fastLimiter(), ...extra });
  adapters.push(result);
  return result;
}

beforeEach(() => {
  root = resolve(".cache", `telegram-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  store = openStore({ path: join(root, "state.sqlite") });
  adapters = [];
  config = {
    config: {
      ownerId: 101, bots: [{ id: "bot-one", agentId: "first", tokenRef: "synthetic" }],
      bindings: [
        { botId: "bot-one", chatId: 101, kind: "private", topicId: null },
        { botId: "bot-one", chatId: -201, kind: "group", topicId: null },
        { botId: "bot-one", chatId: -202, kind: "forum", topicId: 4 },
      ],
      workspacePath: root, agentDefinitionsPath: root, agentLaunchersPath: root, secretsPath: root,
      runtimeDataPath: root, runtimeHomePath: root, skillDirectories: [], mcp: { mode: "none" },
    },
    agents: [{ id: "first", description: "Synthetic", defaultModel: "synthetic", userInvocable: true, launcherPath: root, canonicalPath: root }],
    tokenForBot: () => "701:synthetic_token", resolveSecret: () => "synthetic",
  };
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(adapters.map((instance) => instance.stop()));
  store.close();
  rmSync(root, { recursive: true, force: true });
  for (const [code, metadata] of diagnostics.record.mock.calls) {
    expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,95}$/);
    for (const key of Object.keys((metadata ?? {}) as object)) {
      expect(["botId", "attempt", "count", "forced", "retryAfter", "externalOutcomeUnknown"]).toContain(key);
    }
  }
});

describe("normalization and owner/topic boundary", () => {
  it.each([
    { from: { id: 102, is_bot: false, first_name: "Synthetic" } },
    { from: { id: 101, is_bot: true, first_name: "Synthetic" } },
    { from: undefined },
    { sender_chat: { id: -201, type: "group", title: "Synthetic" } },
    { chat: { id: -202, type: "supergroup", is_forum: true }, message_thread_id: 5 },
    { chat: { id: -202, type: "supergroup", is_forum: true } },
    { chat: { id: -201, type: "supergroup", is_forum: true }, message_thread_id: 4 },
    { chat: { id: -201, type: "channel" } },
    { chat: { id: 103, type: "private" } },
  ])("rejects unauthenticated/wrongly bound input before handling %#", (overrides) => {
    expect(normalizeUpdate(config.config, "bot-one", identity, update(1, overrides)).kind).toBe("ignored");
  });
  it("uses exact binding bot rather than a global chat allowlist", () => {
    const input = update(1, { chat: { id: -202, type: "supergroup", is_forum: true }, message_thread_id: 4 });
    expect(normalizeUpdate(config.config, "bot-one", identity, input).kind).toBe("ingress");
    expect(normalizeUpdate(config.config, "bot-other", identity, input).kind).toBe("ignored");
  });
  it("uses offset-zero UTF16 entities, actual username and ignores commands to another bot", () => {
    const text = "/STOP@SyntheticBot 😀 argument";
    const input = update(1, { text, entities: [{ type: "bot_command", offset: 0, length: 18 }] });
    expect(normalizeUpdate(config.config, "bot-one", identity, input)).toMatchObject({
      kind: "ingress", ingress: { command: { name: "stop", targetBotUsername: "SyntheticBot", arguments: "😀 argument" } },
    });
    expect(normalizeUpdate(config.config, "bot-one", identity, update(2, {
      text: "/stop@OtherBot 😀", entities: [{ type: "bot_command", offset: 0, length: 14 }],
    }))).toMatchObject({ kind: "ignored", code: "TG_OTHER_BOT_COMMAND" });
    const notCommand = normalizeUpdate(config.config, "bot-one", identity, update(3, {
      text: "😀 /stop", entities: [{ type: "bot_command", offset: 3, length: 5 }],
    }));
    expect(notCommand).toMatchObject({ kind: "ingress", ingress: { text: "😀 /stop" } });
    if (notCommand.kind === "ingress") expect(notCommand.ingress).not.toHaveProperty("command");
  });
  it("selects largest photo and retains album caption, voice metadata and only its own replies", () => {
    const result = normalizeUpdate(config.config, "bot-one", identity, update(1, {
      text: undefined, caption: "caption 😀", media_group_id: "album",
      photo: [{ file_id: "large", file_unique_id: "L", width: 800, height: 600, file_size: 999 },
        { file_id: "small", file_unique_id: "S", width: 80, height: 60 }],
      reply_to_message: message({ from: identity, message_id: 77 }),
    }));
    expect(result).toMatchObject({ kind: "ingress", ingress: {
      text: "caption 😀", mediaGroupId: "album", replyToMessageId: 77,
      attachments: [{ kind: "photo", fileId: "large", sizeBytes: 999 }],
    } });
    const voice = normalizeUpdate(config.config, "bot-one", identity, update(2, {
      text: undefined, voice: { file_id: "voice", file_unique_id: "V", duration: 20, mime_type: "audio/ogg" },
      reply_to_message: message({ from: { ...identity, id: 702 } }),
    }));
    expect(voice).toMatchObject({ kind: "ingress", ingress: { attachments: [{ kind: "voice", durationSeconds: 20 }] } });
    if (voice.kind === "ingress") expect(voice.ingress).not.toHaveProperty("replyToMessageId");
  });
  it("treats Telegram filenames as metadata, not local paths", () => {
    expect(normalizeUpdate(config.config, "bot-one", identity, update(1, {
      document: { file_id: "D", file_unique_id: "D", file_name: "../../private/notes.txt" },
    }))).toMatchObject({ kind: "ingress", ingress: { attachments: [{ fileName: "notes.txt" }] } });
  });
  it("rejects malformed unknown shapes without poisoning future updates", () => {
    expect(normalizeUpdate(config.config, "bot-one", identity, {
      update_id: 7, message: { from: { id: 101, is_bot: false } },
    } as Update)).toMatchObject({ kind: "ignored", code: "TG_UPDATE_MALFORMED" });
    expect(normalizeUpdate(config.config, "bot-one", identity, update(8, { photo: [] }))).toMatchObject({
      kind: "ingress", ingress: { text: "hello", attachments: [] },
    });
  });
  it("rejects inaccessible, foreign-owner, wrong-topic and other-bot callbacks", () => {
    const callback = (overrides: Record<string, unknown> = {}): Update => ({
      update_id: 1, callback_query: {
        id: "cb", from: { id: 101, is_bot: false, first_name: "Synthetic" }, chat_instance: "synthetic",
        message: message({ from: identity }), data: "q:opaque_id:1", ...overrides,
      },
    } as Update);
    expect(normalizeUpdate(config.config, "bot-one", identity, callback()).kind).toBe("ingress");
    for (const overrides of [
      { message: message({ date: 0, from: identity }) }, { message: undefined },
      { from: { id: 102, is_bot: false, first_name: "Synthetic" } },
      { message: message({ from: { ...identity, id: 702 } }) },
      { message: message({ from: identity, chat: { id: -202, type: "supergroup", is_forum: true }, message_thread_id: 5 }) },
      { data: "a".repeat(65) }, { data: '{"action":"shell"}' },
    ]) expect(normalizeUpdate(config.config, "bot-one", identity, callback(overrides)).kind).toBe("ignored");
  });
});

describe("durable ordered polling with actual grammY API", () => {
  it("registers supported Ukrainian slash commands only for the owner's bound chats", async () => {
    config.config.bindings.push(
      { botId: "bot-one", chatId: -202, kind: "forum", topicId: 5 },
      { botId: "bot-other", chatId: -303, kind: "group", topicId: null },
    );
    const fake = fakeApi();
    await adapter(fake.api).start({ handle: async () => undefined });
    const registrations = () => fake.calls.filter((call) => call.method === "setMyCommands");
    await vi.waitFor(() => expect(registrations()).toHaveLength(3));
    const commands = [
      { command: "start", description: "Інформація про агента та початок роботи" },
      { command: "help", description: "Довідка про доступні команди" },
      { command: "status", description: "Стан виконання, модель і доставки" },
      { command: "model", description: "Переглянути та змінити модель" },
      { command: "new", description: "Створити нову сесію зі збереженням попередньої" },
      { command: "sessions", description: "Переглянути та керувати сесіями цієї розмови" },
      { command: "stop", description: "Зупинити виконання в цій розмові" },
    ];
    expect(registrations().map((call) => call.payload)).toEqual([
      { commands, scope: { type: "chat", chat_id: 101 } },
      { commands, scope: { type: "chat_member", chat_id: -201, user_id: 101 } },
      { commands, scope: { type: "chat_member", chat_id: -202, user_id: 101 } },
    ]);
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });
  it.each([
    ["network", () => new Error("synthetic network failure"), 500],
    ["429", () => apiError(429, "Synthetic rate limit", 1), 1000],
    ["500", () => apiError(500), 2000],
  ] as const)("retries %s command registration without delaying polling", async (_name, error, delay) => {
    config.config.bindings = config.config.bindings.slice(0, 1);
    const attempts: number[] = [];
    const limiter = fastLimiter();
    const block = vi.spyOn(limiter, "block");
    const fake = fakeApi({
      setMyCommands: () => {
        attempts.push(Date.now());
        if (attempts.length === 1) throw error();
        return true;
      },
      getUpdates: (payload) => Number(payload.offset) === 0 ? [update(9)] : [],
    });
    await adapter(fake.api, { limiter }).start({ handle: async (ingress) => accepted(ingress) });
    await vi.waitFor(() => expect(store.inbox.offset("bot-one")).toBe(10));
    expect(attempts).toHaveLength(1);
    await vi.waitFor(() => expect(attempts).toHaveLength(2), { timeout: 3500 });
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(delay - 10);
    const calls = fake.calls.filter((call) => call.method === "setMyCommands");
    expect(calls[1]?.payload).toEqual(calls[0]?.payload);
    expect(diagnostics.record).toHaveBeenCalledWith("TG_COMMANDS_REGISTRATION_RETRY",
      { botId: "bot-one", retryAfter: expect.any(Number) });
    if (_name !== "network") expect(block).toHaveBeenCalledWith("bot-one", delay);
  });
  it.each([400, 403])("does not endlessly retry a %i menu rejection or block other bindings", async (code) => {
    const fake = fakeApi({ setMyCommands: (payload) => {
      if ((payload.scope as { chat_id: number }).chat_id === 101) throw apiError(code);
      return true;
    } });
    await adapter(fake.api).start({ handle: async () => undefined });
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(3));
    expect(diagnostics.record).toHaveBeenCalledWith("TG_COMMANDS_REGISTRATION_FAILED", { botId: "bot-one" });
    expect(fake.calls.some((call) => call.method === "getUpdates")).toBe(true);
  });
  it("aborts command-registration retry waits on shutdown", async () => {
    const fake = fakeApi({ setMyCommands: () => { throw apiError(429, "Synthetic rate limit", 60); } });
    const instance = adapter(fake.api);
    await instance.start({ handle: async () => undefined });
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(1));
    await instance.stop();
    expect(fake.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(1);
  });
  it("registers menus after transient identity initialization recovers", async () => {
    let identities = 0;
    const fake = fakeApi({ getMe: () => {
      if (++identities === 1) throw new Error("Synthetic initialization failure");
      return identity;
    } });
    await adapter(fake.api).start({ handle: async () => undefined });
    expect(fake.calls.some((call) => call.method === "setMyCommands")).toBe(false);
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(3),
      { timeout: 2000 });
  });
  it("disables only a bot whose command registration reports an invalid token", async () => {
    config.config.bots.push({ id: "bot-two", agentId: "first", tokenRef: "other" });
    config.config.bindings.push({ botId: "bot-two", chatId: 101, kind: "private", topicId: null });
    config.tokenForBot = (id) => id === "bot-one" ? "701:synthetic_token" : "702:synthetic_token";
    const first = fakeApi({ setMyCommands: () => { throw apiError(401); } });
    const second = fakeApi({ getUpdates: (payload) => Number(payload.offset) === 0 ? [update(9)] : [] },
      { ...identity, id: 702, username: "SecondBot" });
    await adapter(first.api, { apiFactory: (token) => token.startsWith("701:") ? first.api : second.api })
      .start({ handle: async (ingress) => accepted(ingress) });
    await vi.waitFor(() => expect(store.inbox.offset("bot-two")).toBe(10));
    expect(diagnostics.record).toHaveBeenCalledWith("TG_TOKEN_INVALID", { botId: "bot-one" });
    expect(first.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(1);
    expect(second.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(1);
  });
  it("records ignored updates, rejects owner/topic before effects and survives duplicate sparse polls", async () => {
    let polls = 0;
    const unauthorized = update(7, { from: { id: 102, is_bot: false }, document: { file_id: "never", file_unique_id: "never" } });
    const fake = fakeApi({ getUpdates: () => ++polls === 1 ? [unauthorized, update(100)] :
      polls === 2 ? [update(100), { update_id: 500, edited_message: message() }] : [] });
    const handle = vi.fn(async (ingress: NormalizedIngress) => accepted(ingress));
    await adapter(fake.api).start({ handle });
    await vi.waitFor(() => expect(store.inbox.offset("bot-one")).toBe(501));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(store.inbox.queued()).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "getFile")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.method === "getUpdates").map((call) => call.payload.offset).slice(0, 3)).toEqual([0, 101, 501]);
  });
  it("does not ACK or skip a failed handler; crash replay deduplicates already-durable admission", async () => {
    let fail = true;
    const fake = fakeApi({ getUpdates: (payload) => Number(payload.offset) === 0 ? [update(30), update(50)] : [] });
    const handle = vi.fn(async (ingress: NormalizedIngress) => {
      accepted(ingress);
      if (fail) { fail = false; throw new Error("synthetic crash after commit"); }
    });
    const first = adapter(fake.api);
    await first.start({ handle });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    expect(store.inbox.offset("bot-one")).toBe(0);
    await first.stop();
    store.close();
    store = openStore({ path: join(root, "state.sqlite") });
    const second = adapter(fake.api);
    await second.start({ handle });
    await vi.waitFor(() => expect(store.inbox.offset("bot-one")).toBe(51));
    expect(store.inbox.queued()).toHaveLength(2);
    expect(handle).toHaveBeenCalledTimes(3);
  });
  it("refuses nondurable handlers and never requests a higher offset", async () => {
    const fake = fakeApi({ getUpdates: () => [update(10), update(20)] });
    const handle = vi.fn(async () => undefined);
    await adapter(fake.api).start({ handle });
    await vi.waitFor(() => expect(handle).toHaveBeenCalled());
    expect(store.inbox.offset("bot-one")).toBe(0);
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it("groups album parts through real SQLite into one queued input", async () => {
    let polled = false;
    const fake = fakeApi({ getUpdates: () => {
      if (polled) return [];
      polled = true;
      return [1, 2].map((id) => update(id, { text: undefined, caption: `caption${id}`, media_group_id: "album",
        photo: [{ file_id: `p${id}`, file_unique_id: `p${id}`, width: 800, height: 600 }] }));
    } });
    await adapter(fake.api).start({ handle: async (ingress) => accepted(ingress) });
    await vi.waitFor(() => expect(store.inbox.offset("bot-one")).toBe(3));
    expect(store.inbox.queued()).toHaveLength(1);
    expect(store.inbox.queued()[0]?.messages.map((entry) => entry.text)).toEqual(["caption1", "caption2"]);
  });
  it("reports webhook and 409 conflicts independently without deleting a webhook", async () => {
    config.config.bots.push({ id: "bot-two", agentId: "second", tokenRef: "other" });
    config.config.bindings.push({ botId: "bot-two", chatId: 101, kind: "private", topicId: null });
    config.tokenForBot = (id) => id === "bot-one" ? "701:synthetic_token" : "702:synthetic_token";
    const first = fakeApi({ getWebhookInfo: () => ({ url: "https://example.invalid/webhook" }) });
    const second = fakeApi({ getUpdates: () => { throw apiError(409); } }, { ...identity, id: 702, username: "SecondBot" });
    await adapter(first.api, { apiFactory: (token) => token.startsWith("701:") ? first.api : second.api }).start({ handle: async () => undefined });
    await vi.waitFor(() => expect(diagnostics.record).toHaveBeenCalledWith("TG_POLLING_CONFLICT", { botId: "bot-two" }));
    expect(diagnostics.record).toHaveBeenCalledWith("TG_WEBHOOK_CONFLICT", { botId: "bot-one" });
    expect(first.calls.filter((call) => call.method === "getUpdates")).toHaveLength(0);
    expect(first.calls.some((call) => call.method === "setMyCommands")).toBe(false);
    expect([...first.calls, ...second.calls].some((call) => call.method === "deleteWebhook")).toBe(false);
  });
  it.each([401, 409])("keeps a healthy bot polling after another bot's %i error", async (code) => {
    config.config.bots.push({ id: "bot-two", agentId: "second", tokenRef: "other" });
    config.config.bindings.push({ botId: "bot-two", chatId: 101, kind: "private", topicId: null });
    config.tokenForBot = (id) => id === "bot-one" ? "701:synthetic_token" : "702:synthetic_token";
    const first = fakeApi({ [code === 401 ? "getMe" : "getUpdates"]: () => { throw apiError(code); } });
    const second = fakeApi({ getUpdates: (payload) => Number(payload.offset) === 0 ? [update(9)] : [] },
      { ...identity, id: 702, username: "SecondBot" });
    await adapter(first.api, { apiFactory: (token) => token.startsWith("701:") ? first.api : second.api })
      .start({ handle: async (ingress) => accepted(ingress) });
    await vi.waitFor(() => expect(store.inbox.offset("bot-two")).toBe(10));
    expect(store.inbox.offset("bot-one")).toBe(0);
    expect(store.inbox.queued()[0]?.scope.botId).toBe("bot-two");
  });
  it("validates actual getMe numeric identity and rejects duplicate bot identities", async () => {
    const fake = fakeApi({}, { ...identity, id: 900 });
    await adapter(fake.api).start({ handle: async () => undefined });
    expect(diagnostics.record).toHaveBeenCalledWith("TG_BOT_IDENTITY_MISMATCH", { botId: "bot-one" });
    expect(fake.calls.some((call) => call.method === "getUpdates")).toBe(false);
    expect(fake.calls.some((call) => call.method === "setMyCommands")).toBe(false);
    config.config.bots.push({ id: "bot-two", agentId: "second", tokenRef: "other" });
    const dup = fakeApi();
    await adapter(dup.api).start({ handle: async () => undefined });
    expect(dup.calls).toHaveLength(0);
    expect(diagnostics.record).toHaveBeenCalledWith("TG_BOT_IDENTITY_COLLISION", { botId: "bot-two" });
  });
  it("reports token errors, ACKs rejected callbacks and gives controlled unsupported-media feedback", async () => {
    const bad = fakeApi({ getMe: () => { throw apiError(401); } });
    await adapter(bad.api).start({ handle: async () => undefined });
    expect(diagnostics.record).toHaveBeenCalledWith("TG_TOKEN_INVALID", { botId: "bot-one" });
    let polled = false;
    const fake = fakeApi({ getUpdates: () => {
      if (polled) return [];
      polled = true;
      return [
        { update_id: 1, callback_query: { id: "foreign", from: { id: 102, is_bot: false }, message: message({ from: identity }), data: "opaque" } },
        update(2, { text: undefined, video: { file_id: "never", file_unique_id: "never" } }),
      ];
    } });
    const handle = vi.fn(async () => undefined);
    await adapter(fake.api).start({ handle });
    await vi.waitFor(() => expect(store.outbox.list(scope)[0]?.status).toBe("sent"));
    expect(handle).not.toHaveBeenCalled();
    expect(fake.calls.some((call) => call.method === "answerCallbackQuery" && call.payload.callback_query_id === "foreign")).toBe(true);
    expect(fake.calls.some((call) => call.method === "getFile")).toBe(false);
  });
  it("dispatches /stop after durable ordinary admission without waiting for a model turn", async () => {
    let polled = false;
    const fake = fakeApi({ getUpdates: () => {
      if (polled) return [];
      polled = true;
      return [update(1), update(2, { text: "/stop", entities: [{ type: "bot_command", offset: 0, length: 5 }] })];
    } });
    const seen: string[] = [];
    await adapter(fake.api).start({ handle: async (ingress) => {
      accepted(ingress);
      seen.push(ingress.kind === "message" ? ingress.command?.name ?? "message" : "callback");
    } });
    await vi.waitFor(() => expect(seen).toEqual(["message", "stop"]));
  });
  it("starts callback ACK immediately without holding control admission behind the network", async () => {
    let polled = false;
    let release: (() => void) | undefined;
    const ack = new Promise<void>((resolveAck) => { release = resolveAck; });
    const fake = fakeApi({
      getUpdates: () => {
        if (polled) return [];
        polled = true;
        return [{ update_id: 3, callback_query: {
          id: "owned", from: { id: 101, is_bot: false }, message: message({ from: identity }), data: "opaque",
        } }];
      },
      answerCallbackQuery: async () => { await ack; return true; },
    });
    const handle = vi.fn(async (ingress: NormalizedIngress) => {
      expect(fake.calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);
      accepted(ingress);
    });
    await adapter(fake.api).start({ handle });
    await vi.waitFor(() => expect(store.inbox.offset("bot-one")).toBe(4));
    release!();
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete shutdown so the caller retains SQLite and the process lock", async () => {
    let release!: () => void;
    let admitted!: () => void;
    const pending = new Promise<void>((resolveHandler) => { release = resolveHandler; });
    const acceptedUpdate = new Promise<void>((resolveAdmission) => { admitted = resolveAdmission; });
    const fake = fakeApi({ getUpdates: () => [update(7)] });
    const instance = adapter(fake.api);
    await instance.start({ handle: async (ingress) => {
      accepted(ingress);
      admitted();
      await pending;
    } });
    await acceptedUpdate;
    try {
      await expect(instance.stop()).rejects.toMatchObject({
        name: "TelegramError", code: "TG_SHUTDOWN_INCOMPLETE", message: "TG_SHUTDOWN_INCOMPLETE",
      });
      expect(diagnostics.record).toHaveBeenCalledWith("TG_SHUTDOWN_INCOMPLETE");
      expect(store.inbox.queued()).toHaveLength(1);
      expect(store.inbox.offset("bot-one")).toBe(0);
    } finally {
      release();
      await instance.stop();
    }
    expect(store.inbox.offset("bot-one")).toBe(0);
  }, 10_000);
});

describe("run-scoped typing indicators", () => {
  const actions = (fake: ReturnType<typeof fakeApi>) => fake.calls.filter((call) => call.method === "sendChatAction");
  it("starts before any answer delta and refreshes while preparing or running", async () => {
    const active = run();
    const times: number[] = [];
    const fake = fakeApi({ sendChatAction: () => { times.push(Date.now()); return true; } });
    const instance = adapter(fake.api);
    await instance.start({ handle: async () => undefined });
    await vi.waitFor(() => expect(times).toHaveLength(1));
    expect(actions(fake)[0]?.payload).toEqual({ chat_id: scope.chatId, action: "typing" });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
    store.runs.markRunning(active);
    await vi.waitFor(() => expect(times).toHaveLength(2), { timeout: 5000 });
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(4000);
    await instance.stop();
  }, 8000);

  it("pauses for a user answer, resumes work, and stops after completion", async () => {
    const active = run();
    store.runs.markWaiting(active);
    const fake = fakeApi();
    await adapter(fake.api).start({ handle: async () => undefined });
    await new Promise((done) => setTimeout(done, 1100));
    expect(actions(fake)).toHaveLength(0);
    store.runs.markRunning(active);
    await vi.waitFor(() => expect(actions(fake)).toHaveLength(1), { timeout: 1500 });
    store.runs.finish(active, "succeeded");
    await new Promise((done) => setTimeout(done, 4200));
    expect(actions(fake)).toHaveLength(1);
  }, 8000);

  it("sends only to the configured bot/chat/topic, never an idle or unbound scope", async () => {
    const forum: Scope = { ...scope, chatId: -202, topicId: 4 };
    const unbound: Scope = { ...scope, chatId: -202, topicId: 5 };
    for (const [index, target] of [forum, unbound].entries()) {
      store.inbox.admit({ ...incoming(200 + index), scope: target, chatKind: "forum" },
        { sessionId: session(target).id, reserveRun: true });
    }
    const fake = fakeApi();
    await adapter(fake.api).start({ handle: async () => undefined });
    await vi.waitFor(() => expect(actions(fake)).toHaveLength(1));
    expect(actions(fake)[0]?.payload).toEqual({ chat_id: -202, message_thread_id: 4, action: "typing" });
  });

  it("rechecks cancellation after a queued rate permit and does not send stale typing", async () => {
    const fake = fakeApi();
    const limiter = fastLimiter();
    await adapter(fake.api, { limiter }).start({ handle: async () => undefined });
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "setMyCommands")).toHaveLength(3));
    let release!: () => void;
    const queued = new Promise<void>((resolveWait) => { release = resolveWait; });
    const take = vi.spyOn(limiter, "takeChatAction").mockImplementationOnce(() => queued);
    const active = run();
    await vi.waitFor(() => expect(take).toHaveBeenCalled(), { timeout: 1500 });
    store.runs.cancel(active);
    release();
    await new Promise((done) => setTimeout(done, 100));
    expect(actions(fake)).toHaveLength(0);
  });

  it("aborts an in-flight typing request when the run is stopped", async () => {
    const active = run();
    let requestSignal: AbortSignal | undefined;
    const fake = fakeApi({ sendChatAction: (_payload, signal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }) });
    await adapter(fake.api).start({ handle: async () => undefined });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    store.runs.cancel(active);
    await vi.waitFor(() => expect(requestSignal!.aborted).toBe(true), { timeout: 1500 });
    expect(actions(fake)).toHaveLength(1);
  });

  it("honors typing rate-limit cooldowns without blocking polling", async () => {
    run();
    const limiter = fastLimiter();
    const block = vi.spyOn(limiter, "block");
    const fake = fakeApi({
      sendChatAction: () => { throw apiError(429, "Synthetic limit", 60); },
      getUpdates: (payload) => Number(payload.offset) === 0 ? [update(999)] : [],
    });
    const instance = adapter(fake.api, { limiter });
    await instance.start({ handle: async (ingress) => accepted(ingress) });
    await vi.waitFor(() => expect(block).toHaveBeenCalledWith("bot-one", 60000));
    expect(diagnostics.record).toHaveBeenCalledWith("TG_TYPING_UNAVAILABLE", { botId: "bot-one" });
    await vi.waitFor(() => expect(store.inbox.offset("bot-one")).toBe(1000));
    await instance.stop();
    expect(actions(fake)).toHaveLength(1);
  });

  it("aborts in-flight typing on service shutdown and does not overlap requests", async () => {
    run();
    let requestSignal: AbortSignal | undefined;
    const fake = fakeApi({ sendChatAction: (_payload, signal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }) });
    const instance = adapter(fake.api);
    await instance.start({ handle: async () => undefined });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await instance.stop();
    expect(requestSignal!.aborted).toBe(true);
    expect(actions(fake)).toHaveLength(1);
  });

  it("refreshes concurrent forum topics with production pacing despite group-message cooldown", async () => {
    config.config.bindings = [
      { botId: "bot-one", chatId: -202, kind: "forum", topicId: 4 },
      { botId: "bot-one", chatId: -202, kind: "forum", topicId: 5 },
    ];
    for (const topicId of [4, 5]) {
      const target: Scope = { ...scope, chatId: -202, topicId };
      store.inbox.admit({ ...incoming(300 + topicId), scope: target, chatKind: "forum" },
        { sessionId: session(target).id, reserveRun: true });
    }
    const times = new Map<number, number[]>();
    const fake = fakeApi({ sendChatAction: (payload) => {
      const topic = Number(payload.message_thread_id);
      const values = times.get(topic) ?? [];
      values.push(Date.now());
      times.set(topic, values);
      return true;
    } });
    const instance = adapter(fake.api, { limiter: new RateLimiter() });
    await instance.start({ handle: async () => undefined });
    await vi.waitFor(() => {
      expect(times.get(4)).toHaveLength(1);
      expect(times.get(5)).toHaveLength(1);
    }, { timeout: 1000 });
    await vi.waitFor(() => {
      expect(times.get(4)).toHaveLength(2);
      expect(times.get(5)).toHaveLength(2);
    }, { timeout: 5500 });
    for (const values of times.values()) {
      expect(values[1]! - values[0]!).toBeLessThan(4900);
    }
    await instance.stop();
  }, 8000);
});

describe("safe HTML formatting and scalar-safe splitting", () => {
  function decode(html: string) {
    return html.replace(/<\/?(?:b|i|s|pre|code)>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  }
  function balanced(html: string) {
    const stack: string[] = [];
    for (const match of html.matchAll(/<(\/?)(b|i|s|pre|code)>/g)) {
      if (match[1]) expect(stack.pop()).toBe(match[2]);
      else stack.push(match[2]!);
    }
    expect(stack).toEqual([]);
  }
  it("escapes arbitrary HTML and preserves plain identifiers, whitespace and unbroken text", () => {
    const text = ` <script>&" 😀 foo_bar_baz\n${"x".repeat(13_000)}\n`;
    const chunks = renderTelegramHtml(text);
    expect(chunks.map((chunk) => decode(chunk.html)).join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.text.length <= 4096 && chunk.html.includes("<script>") === false)).toBe(true);
    chunks.forEach((chunk) => balanced(chunk.html));
  });
  it("preserves full long code, emphasis and every emoji with valid independent chunk tags", () => {
    const code = `const n = "<&>"; 😀\n${"😀".repeat(9000)}\n`;
    const chunks = renderTelegramHtml(`**bold** *italics* ~~gone~~ \`a<b\`\n\`\`\`ts\n${code}\`\`\``);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(`bold italics gone a<b\n${code}`);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(4096);
      expect(Buffer.from(chunk.text, "utf8").toString("utf8")).toBe(chunk.text);
      expect(decode(chunk.html)).toBe(chunk.text);
      balanced(chunk.html);
    }
    expect(chunks[0]?.html).toContain("<b>bold</b>");
    expect(chunks.at(-1)?.html).toContain("</pre>");
  });
  it("does not nest code in emphasis and keeps unmatched delimiters literal", () => {
    expect(renderTelegramHtml("**a `b` c**")[0]?.html).toBe("<b>a </b><code>b</code><b> c</b>");
    expect(renderTelegramHtml("unmatched ** and `")[0]?.text).toBe("unmatched ** and `");
    expect(renderTelegramHtml("😀".repeat(500), 1024)[0]?.text.length).toBe(1000);
  });
  it.each([
    "2 * 3 * 4", "2 ** 3 ** 4", "* leading space*", "*trailing space *", "plain * unmatched",
    "foo_bar_baz", "слово_частина_слова", "literal \\*stars\\*", "a ~ b ~ c", "`unmatched``", "``unmatched`",
  ])("preserves literal unmatched/non-flanking delimiters: %s", (text) => {
    const chunks = renderTelegramHtml(text);
    expect(chunks.map((chunk) => decode(chunk.html)).join("")).toBe(text);
    chunks.forEach((chunk) => balanced(chunk.html));
  });
  it("matches complete equal-length backtick runs without losing interior ticks", () => {
    for (const [source, decoded] of [
      ["`a``b`", "a``b"], ["``a`b``", "a`b"], ["``a```b``", "a```b"],
      ["`a` plain ``b``", "a plain b"], ["`` a`b ``", " a`b "], ["`a\\`", "a\\"],
    ]) {
      const chunks = renderTelegramHtml(source!);
      expect(chunks.map((chunk) => decode(chunk.html)).join("")).toBe(decoded);
      chunks.forEach((chunk) => balanced(chunk.html));
    }
  });
  it("keeps valid Unicode-boundary, nested and triple emphasis", () => {
    for (const [source, decoded] of [
      ["(**bold**) [_italic_]", "(bold) [italic]"],
      ["*слово* **😀**", "слово 😀"], ["***both***", "both"],
      ["**bold *italic***", "bold italic"], ["*italic **bold***", "italic bold"],
      ["*a `x*y` z*", "a x*y z"], ["**a `x**y` z**", "a x**y z"],
    ]) {
      const chunks = renderTelegramHtml(source!);
      expect(chunks.map((chunk) => decode(chunk.html)).join("")).toBe(decoded);
      chunks.forEach((chunk) => balanced(chunk.html));
    }
  });
});

describe("outbox delivery outcomes, rate limiting and requests", () => {
  it("requires durable claim and ignores forged in-memory content", async () => {
    const fake = fakeApi();
    const item = enqueue();
    expect(await transport(fake.api).deliver(item)).toMatchObject({ status: "failed", errorCode: "TG_DELIVERY_NOT_CLAIMED" });
    expect(fake.calls).toHaveLength(0);
    const claimed = store.outbox.claim()!;
    expect(await transport(fake.api).deliver({ ...claimed, payload: { kind: "text", text: "forged" } })).toMatchObject({ status: "sent" });
    expect(fake.calls[0]?.payload.text).toBe("Hello");
  });
  it("rejects wrong-owner delivery and concurrent replay of the same sending attempt", async () => {
    const fake = fakeApi();
    enqueue("forbidden", { ...scope, ownerId: 102 });
    expect(await transport(fake.api).deliver(store.outbox.claim()!)).toMatchObject({ status: "failed", errorCode: "TG_DELIVERY_SCOPE_REJECTED" });
    expect(fake.calls).toHaveLength(0);
    enqueue();
    const claimed = store.outbox.claim()!;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveSend) => { release = resolveSend; });
    const slow = fakeApi({ sendMessage: async () => { await gate; return message({ message_id: 55 }); } });
    const delivery = transport(slow.api);
    const first = delivery.deliver(claimed);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    expect(await delivery.deliver(claimed)).toMatchObject({ status: "failed", errorCode: "TG_DELIVERY_IN_PROGRESS" });
    release!();
    expect(await first).toMatchObject({ status: "sent" });
  });
  it("retains original forum topic through exactly one missing-reply fallback", async () => {
    const target = { ...scope, chatId: -202, topicId: 4 };
    enqueue("Answer", target, 88);
    let calls = 0;
    const fake = fakeApi({ sendMessage: () => {
      if (++calls === 1) throw apiError(400, "Bad Request: message to be replied not found");
      return message({ message_id: 55 });
    } });
    expect(await transport(fake.api).deliver(store.outbox.claim()!)).toEqual({ status: "sent", remoteMessageIds: [55] });
    const sends = fake.calls.filter((call) => call.method === "sendMessage");
    expect(sends.map((call) => call.payload.message_thread_id)).toEqual([4, 4]);
    expect(sends[0]?.payload.reply_parameters).toEqual({ message_id: 88, allow_sending_without_reply: false });
    expect(sends[1]?.payload).not.toHaveProperty("reply_parameters");
  });
  it("converts 429 retry_after to absolute time and bounds attempts in SQLite", async () => {
    enqueue();
    const fake = fakeApi({ sendMessage: () => { throw apiError(429, "Too Many Requests", 3); } });
    const item = store.outbox.claim()!;
    const now = Date.now();
    const outcome = await transport(fake.api).deliver(item);
    expect(outcome).toMatchObject({ status: "failed", errorCode: "TG_RATE_LIMIT" });
    expect(outcome.retryAfter).toBeGreaterThanOrEqual(now + 3000);
    store.outbox.settle(item.id, item.attempts, outcome);
    expect(store.outbox.claim({ now: now + 2000 })).toBeNull();
    const retried = store.outbox.claim({ now: now + 4000 })!;
    expect(retried.attempts).toBe(2);
    store.outbox.settle(retried.id, retried.attempts, { status: "failed", retryAfter: now });
    expect(store.outbox.claim({ maxAttempts: 2 })).toBeNull();
    expect(store.outbox.get(scope, item.id)?.errorCode).toBe("RETRY_EXHAUSTED");
  });
  it("classifies real grammY HTTP JSON failures and fetch uncertainty without leaking token URLs", async () => {
    enqueue();
    const http = vi.fn(async () => new Response(JSON.stringify({
      ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 },
    })));
    const api = new Api("701:synthetic_token", { fetch: http as never, sensitiveLogs: false });
    expect(await transport(api.raw as unknown as TelegramApi).deliver(store.outbox.claim()!))
      .toMatchObject({ status: "failed", errorCode: "TG_RATE_LIMIT", retryAfter: expect.any(Number) });
    expect(http).toHaveBeenCalledTimes(1);
    enqueue();
    const broken = new Api("701:synthetic_token", { fetch: (async () => {
      throw new Error("https://api.telegram.org/bot701:synthetic_token/sendMessage");
    }) as never });
    expect(await transport(broken.raw as unknown as TelegramApi).deliver(store.outbox.claim()!))
      .toEqual({ status: "uncertain", errorCode: "TG_NETWORK_UNCERTAIN" });
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("synthetic_token");
  });
  it("records ambiguous network outcome without sent/retry and partial chunk IDs without automatic replay", async () => {
    const network = fakeApi({ sendMessage: () => { throw new Error("synthetic token must never be logged"); } });
    enqueue();
    const claimed = store.outbox.claim()!;
    const uncertain = await transport(network.api).deliver(claimed);
    expect(uncertain).toEqual({ status: "uncertain", errorCode: "TG_NETWORK_UNCERTAIN" });
    store.outbox.settle(claimed.id, claimed.attempts, uncertain);
    expect(store.outbox.claim()).toBeNull();
    expect(store.outbox.retry(scope, claimed.id)).toBe(false);
    enqueue("😀".repeat(5000));
    let sends = 0;
    const partial = fakeApi({ sendMessage: () => {
      if (++sends === 2) throw apiError(429, "Too Many Requests", 5);
      return message({ message_id: 501 });
    } });
    expect(await transport(partial.api).deliver(store.outbox.claim()!)).toEqual({
      status: "uncertain", errorCode: "TG_PARTIAL_DELIVERY", remoteMessageIds: [501],
    });
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("synthetic token");
  });
  it("does not fallback on unrelated 400 and retries known server errors only", async () => {
    enqueue("text", scope, 55);
    const bad = fakeApi({ sendMessage: () => { throw apiError(400, "Bad Request: message thread not found"); } });
    expect(await transport(bad.api).deliver(store.outbox.claim()!)).toEqual({ status: "failed", errorCode: "TG_BAD_REQUEST" });
    expect(bad.calls).toHaveLength(1);
    enqueue();
    const server = fakeApi({ sendMessage: () => { throw apiError(503); } });
    expect(await transport(server.api).deliver(store.outbox.claim()!)).toMatchObject({ status: "failed", errorCode: "TG_SERVER_RETRY", retryAfter: expect.any(Number) });
  });
  it("maps exact final request message ID and puts opaque buttons only on its last chunk", async () => {
    const active = run();
    const request = store.requests.create(active, { kind: "permission", action: "synthetic", parameters: {} }, { expiresAt: Date.now() + 60_000 });
    store.outbox.enqueue({
      scope, sessionId: active.sessionId, runId: active.runId, dedupKey: "request",
      payload: { kind: "request", requestId: request.id, text: "x".repeat(6000), buttons: [[{ text: "Allow", data: `p:${request.id}:yes` }]] },
    });
    const fake = fakeApi();
    const result = await transport(fake.api).deliver(store.outbox.claim()!);
    expect(result.status).toBe("sent");
    expect(store.requests.get(scope, request.id)?.promptMessageId).toBe(result.remoteMessageIds?.at(-1));
    expect(fake.calls[0]?.payload).not.toHaveProperty("reply_markup");
    expect(fake.calls[1]?.payload.reply_markup).toMatchObject({ inline_keyboard: [[{ callback_data: `p:${request.id}:yes` }]] });
  });
  it("delivers structural text menus without fabricating SDK requests", async () => {
    const menu = { kind: "text" as const, text: "x".repeat(6000), buttons: [[{ text: "Choose", data: "c:opaque" }]] };
    store.outbox.enqueue({ scope, sessionId: session().id, dedupKey: "menu", payload: menu });
    const setPrompt = vi.spyOn(store.requests, "setPrompt");
    const fake = fakeApi();
    expect(await transport(fake.api).deliver(store.outbox.claim()!)).toMatchObject({ status: "sent" });
    expect(store.requests.pending(scope)).toEqual([]);
    expect(setPrompt).not.toHaveBeenCalled();
    expect(fake.calls[0]?.payload).not.toHaveProperty("reply_markup");
    expect(fake.calls[1]?.payload.reply_markup).toMatchObject({ inline_keyboard: [[{ callback_data: "c:opaque" }]] });
  });
  it("does not remove an active preview when delivering a text menu with buttons", async () => {
    const active = run();
    const menu = { kind: "text" as const, text: "Controls", buttons: [[{ text: "Stop", data: "c:stop_opaque" }]] };
    const fake = fakeApi();
    const delivery = transport(fake.api);
    await delivery.preview(active, "Working");
    store.outbox.enqueue({ scope, sessionId: active.sessionId, runId: active.runId, dedupKey: "controls", payload: menu });
    expect(await delivery.deliver(store.outbox.claim()!)).toMatchObject({ status: "sent" });
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toEqual([]);
  });
  it("rejects stale requests and invalid callback bytes before sending", async () => {
    const active = run();
    const request = store.requests.create(active, { kind: "permission", action: "synthetic", parameters: {} }, { expiresAt: Date.now() + 60_000 });
    store.outbox.enqueue({
      scope, sessionId: active.sessionId, dedupKey: "invalid-request",
      payload: { kind: "request", requestId: request.id, text: "request", buttons: [[{ text: "allow", data: "a".repeat(65) }]] },
    });
    const fake = fakeApi();
    expect(await transport(fake.api).deliver(store.outbox.claim()!)).toMatchObject({ errorCode: "TG_BUTTON_INVALID" });
    store.outbox.enqueue({
      scope, sessionId: active.sessionId, dedupKey: "stale-request",
      payload: { kind: "request", requestId: request.id, text: "request", buttons: [] },
    });
    store.requests.cancel(scope, request.id);
    expect(await transport(fake.api).deliver(store.outbox.claim()!)).toMatchObject({ errorCode: "TG_REQUEST_STALE" });
    expect(fake.calls).toHaveLength(0);
  });
  it("throttles preview edits and suppresses stale generations", async () => {
    const active = run();
    const fake = fakeApi();
    const delivery = transport(fake.api);
    await delivery.preview(active, "First");
    await delivery.preview(active, "Second");
    expect(fake.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    store.runs.cancel(active);
    await delivery.preview(active, "stale");
    expect(fake.calls.filter((call) => call.method === "editMessageText")).toHaveLength(0);
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
  });
  it("sweeps a terminal preview without a later delta and evicts it from subsequent sweeps", async () => {
    const active = run();
    const fake = fakeApi();
    const delivery = transport(fake.api);
    await delivery.preview(active, "Completed preview");
    store.runs.cancel(active);
    store.runs.finish(active, "cancelled");
    await delivery.sweepPreviews();
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
    const isLive = vi.spyOn(store.runs, "isLive");
    await delivery.sweepPreviews();
    expect(isLive).not.toHaveBeenCalled();
  });
  it("invalidates only the exact preview identity and deletes an initial send that finishes late", async () => {
    const active = run();
    let release!: () => void;
    const gate = new Promise<void>((resolveSend) => { release = resolveSend; });
    const fake = fakeApi({ sendMessage: async () => { await gate; return message({ message_id: 901 }); } });
    const delivery = transport(fake.api);
    const pending = delivery.preview(active, "In-flight answer");
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1));
    await delivery.invalidatePreview({ ...active, scope: { ...scope, chatId: 102 } });
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
    store.runs.cancel(active);
    await delivery.invalidatePreview(active);
    release();
    await pending;
    expect(fake.calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload.message_id)).toEqual([901]);
    await delivery.preview(active, "Late delta");
    expect(fake.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });
  it("cancels a queued preview rate wait immediately without starting an API send", async () => {
    const active = run();
    const fake = fakeApi();
    const limiter = fastLimiter();
    vi.spyOn(limiter, "take").mockImplementation(async (_botId, _chatId, signal) => {
      await new Promise<void>((_resolveWait, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const delivery = createDeliveryTransport({ config, store, diagnostics, apiForBot: () => fake.api,
      signal: new AbortController().signal, limiter });
    const pending = delivery.preview(active, "Queued answer");
    await vi.waitFor(() => expect(limiter.take).toHaveBeenCalled());
    store.runs.cancel(active);
    await delivery.invalidatePreview(active);
    await pending;
    expect(fake.calls).toHaveLength(0);
  });
  it("clears a canceled preview during an in-flight edit without recreating it", async () => {
    const active = run();
    let release!: () => void;
    const gate = new Promise<void>((resolveEdit) => { release = resolveEdit; });
    const fake = fakeApi({ editMessageText: async () => { await gate; return message({ message_id: 501 }); } });
    const delivery = transport(fake.api);
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    await delivery.preview(active, "First");
    clock.mockReturnValue(12_000);
    const pending = delivery.preview(active, "Editing");
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "editMessageText")).toHaveLength(1));
    store.runs.cancel(active);
    await delivery.invalidatePreview(active);
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
    release();
    await pending;
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    clock.mockRestore();
  });
  it("automatically removes canceled previews even when the stop notice has no runId", async () => {
    const active = run();
    const fake = fakeApi();
    const instance = adapter(fake.api);
    await instance.start({ handle: async (ingress) => accepted(ingress) });
    await instance.transport.preview(active, "Working");
    store.runs.cancel(active);
    store.runs.finish(active, "cancelled");
    const notice = enqueue("Stopped");
    expect(notice.runId).toBeNull();
    await vi.waitFor(() => expect(store.outbox.get(scope, notice.id)?.status).toBe("sent"));
    await vi.waitFor(() => expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1), { timeout: 2000 });
  });
  it("evicts invalidated previews even when best-effort deletion fails", async () => {
    const active = run();
    const fake = fakeApi({ deleteMessage: () => { throw apiError(403); } });
    const delivery = transport(fake.api);
    await delivery.preview(active, "Working");
    store.runs.cancel(active);
    await delivery.invalidatePreview(active);
    const isLive = vi.spyOn(store.runs, "isLive");
    await delivery.sweepPreviews();
    expect(isLive).not.toHaveBeenCalled();
    expect(diagnostics.record).toHaveBeenCalledWith("TG_PREVIEW_DELETE_FAILED", { botId: scope.botId });
  });
  it("evicts preview state immediately before a pending remote delete completes", async () => {
    const active = run();
    let release!: () => void;
    const gate = new Promise<void>((resolveDelete) => { release = resolveDelete; });
    const fake = fakeApi({ deleteMessage: async () => { await gate; return true; } });
    const delivery = transport(fake.api);
    await delivery.preview(active, "Cached answer");
    store.runs.cancel(active);
    const pending = delivery.invalidatePreview(active);
    const isLive = vi.spyOn(store.runs, "isLive");
    await delivery.sweepPreviews();
    expect(isLive).not.toHaveBeenCalled();
    release();
    await pending;
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
  });
  it("does not invalidate a known preview from a foreign scope/session/generation", async () => {
    const active = run();
    const fake = fakeApi();
    const delivery = transport(fake.api);
    await delivery.preview(active, "Active");
    for (const foreign of [
      { ...active, scope: { ...scope, chatId: 102 } },
      { ...active, sessionId: "foreign-session" },
      { ...active, generation: active.generation + 1 },
    ]) await delivery.invalidatePreview(foreign);
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(0);
    store.runs.cancel(active);
    await delivery.invalidatePreview(active);
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
  });
  it("edits throttled previews, sends final durably and removes transient message", async () => {
    const active = run();
    const fake = fakeApi();
    const delivery = transport(fake.api);
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(10_000);
    await delivery.preview(active, "First");
    clock.mockReturnValue(12_000);
    await delivery.preview(active, "Second");
    const complete = store.runs.complete(active, [{ dedupKey: "complete", payload: { kind: "text", text: "Final" } }])!;
    expect(complete).toHaveLength(1);
    expect(await delivery.deliver(store.outbox.claim()!)).toMatchObject({ status: "sent" });
    expect(fake.calls.filter((call) => call.method === "editMessageText")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
    clock.mockRestore();
  });
  it("paces groups across topics and applies shared per-bot retry windows", async () => {
    const waits: number[] = [];
    let now = 1000;
    const limiter = new RateLimiter(async (ms) => { waits.push(ms); now += ms; }, () => now);
    const signal = new AbortController().signal;
    await limiter.take("one", -10, signal);
    await limiter.take("one", -10, signal);
    await limiter.take("one", 11, signal);
    limiter.block("one", 5000);
    await limiter.take("one", 12, signal);
    await limiter.take("two", 12, signal);
    expect(waits).toEqual([3100, 40, 5000]);
  });
  it("shares bot cooldowns with chat actions without consuming the group-message budget", async () => {
    const waits: number[] = [];
    let now = 0;
    const limiter = new RateLimiter(async (ms) => { waits.push(ms); now += ms; }, () => now);
    const signal = new AbortController().signal;
    await limiter.take("one", -10, signal);
    await limiter.takeChatAction("one", signal);
    await limiter.takeChatAction("one", signal);
    expect(waits).toEqual([40, 40]);
    await limiter.take("one", -10, signal);
    expect(now).toBe(3100);
    limiter.block("one", 5000);
    await limiter.takeChatAction("one", signal);
    expect(now).toBe(8100);
    await limiter.take("one", 11, signal);
    expect(now).toBe(8140);
  });
  it("rechecks extended bot cooldowns before releasing a chat action", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = clockLimiter();
    const signal = new AbortController().signal;
    limiter.block("one", 5000);
    const released = vi.fn();
    const action = limiter.takeChatAction("one", signal).then(released);
    await vi.advanceTimersByTimeAsync(4000);
    limiter.block("one", 6000);
    await vi.advanceTimersByTimeAsync(5999);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await action;
    expect(released).toHaveBeenCalledOnce();
  });
  it("keeps two concurrent reservations spaced when both previously converged on 5000", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = clockLimiter();
    const signal = new AbortController().signal;
    const releases: number[] = [];
    limiter.block("one", 5000);
    const first = limiter.take("one", 10, signal).then(() => { releases.push(Date.now()); });
    const second = limiter.take("one", 11, signal).then(() => { releases.push(Date.now()); });
    await limiter.take("two", 10, signal);
    await vi.advanceTimersByTimeAsync(4999);
    expect(releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(releases).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(39);
    expect(releases).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(releases).toEqual([5000, 5040]);
  });
  it("rechecks every sleep when successive 429s extend 5000 to 15000 then 24000", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = clockLimiter();
    const signal = new AbortController().signal;
    const releases: number[] = [];
    limiter.block("one", 5000);
    const first = limiter.take("one", 10, signal).then(() => { releases.push(Date.now()); });
    const second = limiter.take("one", 10, signal).then(() => { releases.push(Date.now()); });
    await vi.advanceTimersByTimeAsync(4000);
    limiter.block("one", 11_000);
    await vi.advanceTimersByTimeAsync(10_000);
    limiter.block("one", 10_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(8999);
    expect(releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(releases).toEqual([24_000]);
    await vi.advanceTimersByTimeAsync(1050);
    await Promise.all([first, second]);
    expect(releases).toEqual([24_000, 25_050]);
  });
  it("preserves group pacing after a shared cooldown and cannot bypass the head through cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = clockLimiter();
    const signal = new AbortController().signal;
    const canceled = new AbortController();
    const releases: number[] = [];
    limiter.block("one", 5000);
    const first = limiter.take("one", -10, signal).then(() => { releases.push(Date.now()); });
    const removed = limiter.take("one", 20, canceled.signal);
    const rejected = expect(removed).rejects.toThrow("CANCELED");
    const third = limiter.take("one", -10, signal).then(() => { releases.push(Date.now()); });
    canceled.abort(new Error("CANCELED"));
    await rejected;
    await vi.advanceTimersByTimeAsync(4999);
    expect(releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(releases).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(3100);
    await Promise.all([first, third]);
    expect(releases).toEqual([5000, 8100]);
  });
});

describe("scoped bounded download/upload IO", () => {
  function downloadOptions(fake = fakeApi(), extra: Partial<Parameters<typeof downloadTelegramFile>[0]> = {}) {
    return { api: fake.api, token: "701:synthetic_token", fileId: "synthetic", root,
      destination: join(root, "download.txt"), signal: new AbortController().signal, maxBytes: TELEGRAM_DOWNLOAD_LIMIT,
      fetch: vi.fn(async () => new Response("hello", { headers: { "content-length": "5" } })) as typeof fetch, ...extra };
  }
  it("downloads through HTTP into a private exclusively-created managed file", async () => {
    const options = downloadOptions();
    expect(await downloadTelegramFile(options)).toEqual({ sizeBytes: 5 });
    expect(readFileSync(options.destination, "utf8")).toBe("hello");
    expect(statSync(options.destination).mode & 0o777).toBe(0o600);
    await expect(downloadTelegramFile(options)).rejects.toThrow("TG_DESTINATION_REJECTED");
    expect(readFileSync(options.destination, "utf8")).toBe("hello");
    expect(options.fetch).toHaveBeenCalledWith(expect.stringContaining("/file/bot701:synthetic_token/documents/file_1.txt"),
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it("enforces metadata, declared and actual chunked download sizes at the fixed 20MB ceiling", async () => {
    const tooLarge = fakeApi({ getFile: () => ({ file_path: "file.txt", file_size: TELEGRAM_DOWNLOAD_LIMIT + 1 }) });
    const metadata = downloadOptions(tooLarge, { maxBytes: TELEGRAM_DOWNLOAD_LIMIT * 2 });
    await expect(downloadTelegramFile(metadata)).rejects.toThrow("TG_DOWNLOAD_TOO_LARGE");
    expect(metadata.fetch).not.toHaveBeenCalled();
    const declared = downloadOptions(fakeApi(), { fetch: vi.fn(async () => new Response("x", {
      headers: { "content-length": String(TELEGRAM_DOWNLOAD_LIMIT + 1) },
    })) as typeof fetch });
    await expect(downloadTelegramFile(declared)).rejects.toThrow("TG_DOWNLOAD_TOO_LARGE");
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); controller.close(); },
    });
    await expect(downloadTelegramFile(downloadOptions(fakeApi(), {
      maxBytes: 7, fetch: vi.fn(async () => new Response(chunks)) as typeof fetch,
    }))).rejects.toThrow("TG_DOWNLOAD_TOO_LARGE");
    expect(existsSync(join(root, "download.txt"))).toBe(false);
  });
  it("rejects destination traversal, remote traversal, symlinks and existing files without overwriting", async () => {
    const fake = fakeApi();
    await expect(downloadTelegramFile(downloadOptions(fake, { destination: `${root}/../escape` }))).rejects.toThrow("TG_FILE_PATH_REJECTED");
    expect(fake.calls).toHaveLength(0);
    const traversal = fakeApi({ getFile: () => ({ file_path: "../private.txt" }) });
    const options = downloadOptions(traversal);
    await expect(downloadTelegramFile(options)).rejects.toThrow("TG_REMOTE_PATH_REJECTED");
    expect(options.fetch).not.toHaveBeenCalled();
    writeFileSync(join(root, "safe.txt"), "safe");
    symlinkSync(join(root, "safe.txt"), join(root, "download.txt"));
    await expect(downloadTelegramFile(downloadOptions())).rejects.toThrow("TG_DESTINATION_REJECTED");
    expect(readFileSync(join(root, "safe.txt"), "utf8")).toBe("safe");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    await expect(downloadTelegramFile(downloadOptions(fakeApi(), { destination: join(root, "link", "file") }))).rejects.toThrow("TG_FILE_PATH_REJECTED");
  });
  it("aborts during streaming, removes only its partial file and detects a truncated body", async () => {
    const abort = new AbortController();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new TextEncoder().encode("part"));
        else { abort.abort(); controller.close(); }
      },
    });
    await expect(downloadTelegramFile(downloadOptions(fakeApi(), { signal: abort.signal,
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch,
    }))).rejects.toThrow("TG_DOWNLOAD_CANCELLED");
    expect(existsSync(join(root, "download.txt"))).toBe(false);
    await expect(downloadTelegramFile(downloadOptions(fakeApi(), {
      fetch: vi.fn(async () => new Response("abc", { headers: { "content-length": "9" } })) as typeof fetch,
    }))).rejects.toThrow("TG_DOWNLOAD_TRUNCATED");
    expect(existsSync(join(root, "download.txt"))).toBe(false);
  });
  it("supports media-owned exclusive empty files without replacing or truncating their inode", async () => {
    const options = downloadOptions();
    writeFileSync(options.destination, "", { flag: "wx", mode: 0o600 });
    const before = statSync(options.destination);
    expect(await downloadTelegramFile(options)).toEqual({ sizeBytes: 5 });
    expect(statSync(options.destination).ino).toBe(before.ino);
    expect(statSync(options.destination).dev).toBe(before.dev);
    expect(readFileSync(options.destination, "utf8")).toBe("hello");
  });
  it("rejects pre-created shared/nonprivate destinations and leaves media-owned cleanup to media", async () => {
    const options = downloadOptions();
    writeFileSync(options.destination, "", { flag: "wx", mode: 0o644 });
    await expect(downloadTelegramFile(options)).rejects.toThrow("TG_DESTINATION_REJECTED");
    expect(options.fetch).not.toHaveBeenCalled();
    unlinkSync(options.destination);
    writeFileSync(options.destination, "", { flag: "wx", mode: 0o600 });
    linkSync(options.destination, join(root, "second-link"));
    await expect(downloadTelegramFile(options)).rejects.toThrow("TG_DESTINATION_REJECTED");
    unlinkSync(join(root, "second-link"));
    const before = statSync(options.destination);
    await expect(downloadTelegramFile({ ...options, fetch: vi.fn(async () => new Response("hello", {
      headers: { "content-length": "10" },
    })) as typeof fetch })).rejects.toThrow("TG_DOWNLOAD_TRUNCATED");
    expect(existsSync(options.destination)).toBe(true);
    expect(statSync(options.destination).ino).toBe(before.ino);
  });
  it("cancels an indefinitely stalled response reader promptly", async () => {
    const abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); } });
    const running = downloadTelegramFile(downloadOptions(fakeApi(), { signal: abort.signal,
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch,
    }));
    await vi.waitFor(() => expect(existsSync(join(root, "download.txt"))).toBe(true));
    abort.abort();
    await expect(running).rejects.toThrow("TG_DOWNLOAD_CANCELLED");
    expect(existsSync(join(root, "download.txt"))).toBe(false);
  });
  it("never removes a replacement file during failed-download cleanup", async () => {
    const abort = new AbortController();
    const path = join(root, "download.txt");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); } });
    const running = downloadTelegramFile(downloadOptions(fakeApi(), { signal: abort.signal,
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch,
    }));
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    unlinkSync(path);
    writeFileSync(path, "replacement");
    abort.abort();
    await expect(running).rejects.toThrow("TG_DOWNLOAD_CANCELLED");
    expect(readFileSync(path, "utf8")).toBe("replacement");
  });
  it("adapter stop aborts and drains its active download without waiting for media/model work", async () => {
    const fake = fakeApi();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); } });
    const instance = adapter(fake.api, { fetch: vi.fn(async () => new Response(stream)) as typeof fetch });
    await instance.start({ handle: async (ingress) => accepted(ingress) });
    const path = join(root, "download.txt");
    const running = instance.downloadFile("bot-one", "file", path, new AbortController().signal, 20).catch((error: unknown) => error);
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    await instance.stop();
    expect(await running).toMatchObject({ code: "TG_DOWNLOAD_CANCELLED" });
    expect(existsSync(path)).toBe(false);
  });
  it("requires a scoped output record and safe resolver; never sends an arbitrary model path", async () => {
    const current = session();
    writeFileSync(join(root, "artifact.txt"), "synthetic file");
    const attachment = store.attachments.add({ scope, sessionId: current.id, runId: null, kind: "output",
      relativePath: "artifact.txt", fileName: "artifact.txt", mimeType: "text/plain", sizeBytes: 14 });
    store.outbox.enqueue({ scope, sessionId: current.id, dedupKey: "file", payload: { kind: "file", attachmentId: attachment.id } });
    let uploaded = "";
    const fake = fakeApi({ sendDocument: async (payload) => {
      expect(payload.document).toBeInstanceOf(InputFile);
      const bytes = await (payload.document as InputFile).toRaw();
      if (bytes instanceof Uint8Array) uploaded = Buffer.from(bytes).toString();
      else for await (const chunk of bytes) uploaded += Buffer.from(chunk).toString();
      return message({ message_id: 555 });
    } });
    const lookup = vi.fn(async (target: Scope, id: string) => {
      expect(target).toEqual(scope);
      expect(id).toBe(attachment.id);
      return { path: join(root, "artifact.txt"), fileName: "../../artifact.txt", mimeType: "text/plain" };
    });
    expect(await transport(fake.api, lookup).deliver(store.outbox.claim()!)).toEqual({ status: "sent", remoteMessageIds: [555] });
    expect(uploaded).toBe("synthetic file");
    const upload = fake.calls[0]?.payload.document as InputFile;
    expect(upload.filename).toBe("artifact.txt");
  });
  it("rejects uploads over 50MB, symlink paths and files changed after validation", async () => {
    const path = join(root, "large.txt");
    const handle = await open(path, "wx");
    await handle.truncate(TELEGRAM_UPLOAD_LIMIT + 1);
    await handle.close();
    await expect(openUpload(root, { path, fileName: "x", mimeType: "text/plain" })).rejects.toThrow("TG_UPLOAD_TOO_LARGE");
    await truncate(path, 3);
    symlinkSync(path, join(root, "link.txt"));
    await expect(openUpload(root, { path: join(root, "link.txt"), fileName: "x", mimeType: "text/plain" })).rejects.toThrow("TG_FILE_UNAVAILABLE");
    const upload = await openUpload(root, { path, fileName: "x", mimeType: "text/plain" });
    await truncate(path, 4);
    const bytes = await upload.file.toRaw();
    await expect((async () => { if (!(bytes instanceof Uint8Array)) for await (const chunk of bytes) void chunk; })()).rejects.toThrow("TG_UPLOAD_TOO_LARGE");
    await upload.close();
  });
});
