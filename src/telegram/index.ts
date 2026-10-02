import { Api } from "grammy";
import type { BotCommand, BotCommandScope, UserFromGetMe } from "grammy/types";
import type { LoadedConfig } from "../config/index.js";
import { scopeKey, type RunIdentity } from "../domain.js";
import type { DiagnosticSink, IngressHandler, StateStore } from "../ports.js";
import { apiFailure, RateLimiter, sleep, TelegramError, type TelegramApi } from "./common.js";
import { createDeliveryTransport, type TelegramDeliveryTransport } from "./delivery.js";
import { downloadTelegramFile, type AttachmentResolver, type DownloadFile } from "./files.js";
import { normalizeUpdate } from "./normalize.js";

export type { TelegramApi } from "./common.js";
export type { TelegramDeliveryTransport } from "./delivery.js";
export { TelegramError } from "./common.js";
export type { AttachmentResolver, DownloadFile, ResolvedAttachment } from "./files.js";
export { TELEGRAM_DOWNLOAD_LIMIT, TELEGRAM_UPLOAD_LIMIT } from "./files.js";
export { renderTelegramHtml, escapeHtml } from "./format.js";
export { normalizeUpdate } from "./normalize.js";

export interface TelegramAdapterOptions {
  config: LoadedConfig;
  store: StateStore;
  diagnostics: DiagnosticSink;
  resolveAttachment?: AttachmentResolver;
  /** Test seams only; production always uses the standard remote Bot API. */
  apiFactory?: (token: string) => TelegramApi;
  fetch?: typeof fetch;
  limiter?: RateLimiter;
}
export interface TelegramAdapter {
  transport: TelegramDeliveryTransport;
  start(handler: IngressHandler): Promise<void>;
  stop(): Promise<void>;
  downloadFile: DownloadFile;
}

interface ManagedBot {
  id: string;
  api: TelegramApi;
  token: string;
  controller: AbortController;
  identity: UserFromGetMe | null;
  fatal: boolean;
  retryAt: number;
}
interface TypingState {
  run: RunIdentity;
  controller: AbortController;
  nextAt: number;
  busy: boolean;
}

const commands: BotCommand[] = [
  { command: "start", description: "Інформація про агента та початок роботи" },
  { command: "help", description: "Довідка про доступні команди" },
  { command: "status", description: "Стан виконання, модель і доставки" },
  { command: "model", description: "Переглянути та змінити модель" },
  { command: "new", description: "Створити нову сесію зі збереженням попередньої" },
  { command: "sessions", description: "Переглянути та керувати сесіями цієї розмови" },
  { command: "stop", description: "Зупинити виконання в цій розмові" },
];

export function createTelegramAdapter(options: TelegramAdapterOptions): TelegramAdapter {
  const master = new AbortController();
  const bots = new Map<string, ManagedBot>();
  const loops = new Set<Promise<void>>();
  const downloads = new Set<Promise<{ sizeBytes: number }>>();
  let started = false;
  let stopped = false;
  const { config, store, diagnostics } = options;
  const limiter = options.limiter ?? new RateLimiter();
  function botFor(id: string): ManagedBot {
    const bot = bots.get(id);
    if (!bot || !bot.identity || bot.fatal) throw new TelegramError("TG_BOT_UNAVAILABLE");
    return bot;
  }
  const transport = createDeliveryTransport({
    config, store, diagnostics, signal: master.signal, limiter,
    apiForBot: (id) => botFor(id).api,
    ...(options.resolveAttachment ? { resolveAttachment: options.resolveAttachment } : {}),
  });

  function launch(work: Promise<void>, bot?: ManagedBot) {
    const tracked = work.catch(() => {
      if (!master.signal.aborted && !bot?.controller.signal.aborted) {
        diagnostics.record(bot ? "TG_BOT_LOOP_FAILED" : "TG_PREVIEW_SWEEP_FAILED", bot ? { botId: bot.id } : undefined);
      }
    }).finally(() => loops.delete(tracked));
    loops.add(tracked);
  }
  function fatal(bot: ManagedBot, code: string) {
    bot.fatal = true;
    bot.controller.abort();
    diagnostics.record(code, { botId: bot.id });
  }
  async function initialize(bot: ManagedBot): Promise<boolean> {
    const signal = AbortSignal.any([master.signal, bot.controller.signal, AbortSignal.timeout(10_000)]);
    try {
      const [identity, webhook] = await Promise.all([bot.api.getMe(signal), bot.api.getWebhookInfo(signal)]);
      if (webhook.url) { fatal(bot, "TG_WEBHOOK_CONFLICT"); return false; }
      if (!Number.isSafeInteger(identity.id) || identity.id < 1 || identity.is_bot !== true || !identity.username ||
          !/^[A-Za-z0-9_]{5,32}$/.test(identity.username) || identity.id !== Number(bot.token.split(":")[0])) {
        fatal(bot, "TG_BOT_IDENTITY_MISMATCH");
        return false;
      }
      for (const other of bots.values()) {
        if (other !== bot && other.identity?.id === identity.id) {
          fatal(other, "TG_BOT_IDENTITY_COLLISION");
          fatal(bot, "TG_BOT_IDENTITY_COLLISION");
          return false;
        }
      }
      bot.identity = identity;
      diagnostics.record("TG_BOT_READY", { botId: bot.id });
      return true;
    } catch (error) {
      if (master.signal.aborted || bot.controller.signal.aborted) return false;
      const failure = apiFailure(error);
      if (failure.fatal) fatal(bot, failure.code);
      else diagnostics.record(failure.known ? failure.code : "TG_INITIALIZATION_RETRY", {
        botId: bot.id, retryAfter: Date.now() + (failure.retryMs ?? 500),
      });
      if (failure.retryMs !== undefined) {
        limiter.block(bot.id, failure.retryMs);
      }
      bot.retryAt = Date.now() + (failure.retryMs ?? 500);
      return false;
    }
  }

  async function polling(bot: ManagedBot, handler: IngressHandler) {
    const signal = AbortSignal.any([master.signal, bot.controller.signal]);
    let retry = 500;
    while (!signal.aborted) {
      if (!bot.identity) {
        await sleep(Math.max(0, bot.retryAt - Date.now()), signal);
        if (!await initialize(bot)) {
          if (signal.aborted) return;
          diagnostics.record("TG_RECONNECT_WAIT", { botId: bot.id, retryAfter: Date.now() + retry });
          await sleep(retry, signal);
          retry = Math.min(30_000, retry * 2);
          continue;
        }
      }
      try {
        const updates = await bot.api.getUpdates({
          offset: store.inbox.offset(bot.id), limit: 100, timeout: 25,
          allowed_updates: ["message", "callback_query"],
        }, signal);
        for (const update of updates) {
          signal.throwIfAborted();
          if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id === Number.MAX_SAFE_INTEGER) {
            throw new TelegramError("TG_UPDATE_ID_INVALID");
          }
          if (update.update_id < store.inbox.offset(bot.id)) continue;
          const normalized = normalizeUpdate(config.config, bot.id, bot.identity!, update);
          if (normalized.kind === "ingress") {
            if (normalized.ingress.kind === "callback") {
              void transport.acknowledgeCallback(bot.id, normalized.ingress.callbackId);
            }
            // The handler resolves after durable admission/control dispatch, never after model or media work.
            await handler.handle(normalized.ingress);
            signal.throwIfAborted();
          } else if (normalized.kind === "unsupported") {
            const botConfig = config.config.bots.find((entry) => entry.id === bot.id)!;
            const agent = config.agents.find((entry) => entry.id === botConfig.agentId)!;
            const session = store.sessions.current(normalized.scope) ?? store.sessions.create(normalized.scope, {
              agentId: agent.id, workspace: config.config.workspacePath, model: agent.defaultModel,
            });
            // Enqueue before the receipt: a crash between the two operations safely repeats only this dedup key.
            store.outbox.enqueue({
              scope: normalized.scope, sessionId: session.id, dedupKey: `unsupported:${update.update_id}`,
              replyToMessageId: normalized.messageId,
              payload: { kind: "text", text: "Цей тип повідомлення не підтримується у v1. Надішліть текст, фото, PDF, DOCX, TXT, Markdown, CSV або голосове до 10 хвилин." },
            });
            store.inbox.recordIgnored(bot.id, update.update_id);
          } else {
            store.inbox.recordIgnored(bot.id, update.update_id);
            if (normalized.callbackId) void transport.acknowledgeCallback(bot.id, normalized.callbackId, "Ця кнопка недоступна.");
            diagnostics.record(normalized.code, { botId: bot.id });
          }
          store.inbox.acknowledge(bot.id, update.update_id);
        }
        retry = 500;
        if (!updates.length) await sleep(100, signal);
      } catch (error) {
        if (signal.aborted) return;
        const failure = apiFailure(error);
        if (failure.fatal) { fatal(bot, failure.code); return; }
        const delay = failure.retryMs ?? retry;
        diagnostics.record(failure.known ? failure.code : "TG_POLL_OR_ADMISSION_RETRY", { botId: bot.id, retryAfter: Date.now() + delay });
        await sleep(delay, signal);
        retry = Math.min(30_000, retry * 2);
      }
    }
  }

  async function registerCommands(bot: ManagedBot) {
    const signal = AbortSignal.any([master.signal, bot.controller.signal]);
    while (!bot.identity) await sleep(250, signal);
    const chats = new Set<number>();
    for (const binding of config.config.bindings) {
      if (binding.botId !== bot.id || chats.has(binding.chatId)) continue;
      chats.add(binding.chatId);
      // Telegram command scopes cannot target individual forum topics.
      const scope: BotCommandScope = binding.kind === "private"
        ? { type: "chat", chat_id: binding.chatId }
        : { type: "chat_member", chat_id: binding.chatId, user_id: config.config.ownerId };
      let retry = 500;
      for (;;) {
        try {
          await limiter.take(bot.id, binding.chatId, signal);
          await bot.api.setMyCommands({ commands, scope },
            AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
          break;
        } catch (error) {
          if (signal.aborted) return;
          const failure = apiFailure(error);
          if (failure.fatal) { fatal(bot, failure.code); return; }
          if (failure.known && failure.retryMs === undefined) {
            diagnostics.record("TG_COMMANDS_REGISTRATION_FAILED", { botId: bot.id });
            break;
          }
          const delay = failure.retryMs ?? retry;
          diagnostics.record("TG_COMMANDS_REGISTRATION_RETRY", { botId: bot.id, retryAfter: Date.now() + delay });
          if (failure.retryMs !== undefined) limiter.block(bot.id, failure.retryMs);
          await sleep(delay, signal);
          retry = Math.min(30_000, retry * 2);
        }
      }
    }
  }

  async function delivery(bot: ManagedBot) {
    const signal = AbortSignal.any([master.signal, bot.controller.signal]);
    while (!signal.aborted) {
      if (!bot.identity) { await sleep(250, signal); continue; }
      const item = store.outbox.claim({ botId: bot.id, maxAttempts: 5 });
      if (!item) { await sleep(100, signal); continue; }
      const outcome = await transport.deliver(item, signal);
      store.outbox.settle(item.id, item.attempts, outcome);
      if (outcome.errorCode === "TG_TOKEN_INVALID") { fatal(bot, outcome.errorCode); return; }
    }
  }
  function isThinking(identity: RunIdentity): boolean {
    const run = store.runs.get(identity.scope, identity.runId);
    return !!run && store.runs.isLive(identity) && (run.status === "preparing" || run.status === "running");
  }
  async function sendTyping(bot: ManagedBot, state: TypingState, signal: AbortSignal): Promise<void> {
    const { run } = state;
    try {
      const current = AbortSignal.any([signal, state.controller.signal]);
      await limiter.takeChatAction(bot.id, current);
      current.throwIfAborted();
      if (!isThinking(run)) return;
      state.nextAt = Date.now() + 4000;
      await bot.api.sendChatAction({
        chat_id: run.scope.chatId, action: "typing",
        ...(run.scope.topicId === null ? {} : { message_thread_id: run.scope.topicId }),
      }, AbortSignal.any([current, AbortSignal.timeout(3000)]));
    } catch (error) {
      if (signal.aborted || state.controller.signal.aborted || !isThinking(run)) return;
      const failure = apiFailure(error);
      diagnostics.record("TG_TYPING_UNAVAILABLE", { botId: bot.id });
      if (failure.fatal) { fatal(bot, failure.code); return; }
      if (failure.retryMs !== undefined) limiter.block(bot.id, failure.retryMs);
      state.nextAt = failure.known && failure.retryMs === undefined
        ? Infinity : Date.now() + Math.max(4000, failure.retryMs ?? 0);
    } finally { state.busy = false; }
  }
  async function maintainTyping(bot: ManagedBot): Promise<void> {
    const signal = AbortSignal.any([master.signal, bot.controller.signal]);
    const states = new Map<string, TypingState>();
    const scopes = config.config.bindings.filter((binding) => binding.botId === bot.id).map((binding) => ({
      ownerId: config.config.ownerId, botId: bot.id, chatId: binding.chatId, topicId: binding.topicId,
    }));
    try {
      while (!signal.aborted) {
        if (bot.identity) for (const scope of scopes) {
          const key = scopeKey(scope);
          const run = store.runs.active(scope);
          let state = states.get(key);
          if (state && (!run || state.run.runId !== run.runId || !isThinking(state.run))) {
            state.controller.abort();
            states.delete(key);
            state = undefined;
          }
          if (!run || !isThinking(run)) continue;
          if (!state) {
            state = { run, controller: new AbortController(), nextAt: 0, busy: false };
            states.set(key, state);
          }
          if (!state.busy && Date.now() >= state.nextAt) {
            state.busy = true;
            state.nextAt = Date.now() + 4000;
            launch(sendTyping(bot, state, signal), bot);
          }
        }
        await sleep(500, signal);
      }
    } finally {
      for (const state of states.values()) state.controller.abort();
    }
  }
  async function maintainPreviews() {
    while (!master.signal.aborted) {
      launch(transport.sweepPreviews());
      await sleep(1000, master.signal);
    }
  }

  return {
    transport,
    async start(handler) {
      if (started || stopped) throw new TelegramError("TG_ALREADY_STARTED_OR_STOPPED");
      started = true;
      const identities = new Map<number, ManagedBot>();
      for (const configured of config.config.bots) {
        try {
          const token = config.tokenForBot(configured.id);
          const bot: ManagedBot = {
            id: configured.id, token,
            api: options.apiFactory?.(token) ?? new Api(token, { timeoutSeconds: 40, sensitiveLogs: false }).raw as unknown as TelegramApi,
            controller: new AbortController(), identity: null, fatal: false, retryAt: 0,
          };
          bots.set(bot.id, bot);
          const id = Number(token.split(":")[0]);
          const previous = identities.get(id);
          if (previous) {
            fatal(previous, "TG_BOT_IDENTITY_COLLISION");
            fatal(bot, "TG_BOT_IDENTITY_COLLISION");
          } else identities.set(id, bot);
        } catch { diagnostics.record("TG_BOT_CONFIGURATION_FAILED", { botId: configured.id }); }
      }
      await Promise.all([...bots.values()].filter((bot) => !bot.fatal).map(initialize));
      for (const bot of bots.values()) {
        if (bot.fatal || master.signal.aborted) continue;
        launch(registerCommands(bot), bot);
        launch(polling(bot, handler), bot);
        launch(delivery(bot), bot);
        launch(maintainTyping(bot), bot);
      }
      if (!master.signal.aborted) launch(maintainPreviews());
    },
    async stop() {
      stopped = true;
      let previewsDone = false;
      const previews = transport.clearPreviews().finally(() => { previewsDone = true; });
      master.abort();
      for (const bot of bots.values()) bot.controller.abort();
      // Admission handlers are contractually prompt; a broken handler must not hold shutdown indefinitely.
      const deadline = new AbortController();
      await Promise.race([
        Promise.allSettled([...loops, ...downloads, previews]),
        sleep(5000, deadline.signal).catch(() => undefined),
      ]);
      deadline.abort();
      if (loops.size || downloads.size || !previewsDone) {
        diagnostics.record("TG_SHUTDOWN_INCOMPLETE");
        throw new TelegramError("TG_SHUTDOWN_INCOMPLETE");
      }
    },
    async downloadFile(botId, fileId, destination, signal, maxBytes) {
      const bot = botFor(botId);
      const download = downloadTelegramFile({
        api: bot.api, token: bot.token, fileId, destination, signal: AbortSignal.any([signal, master.signal, bot.controller.signal]),
        root: config.config.runtimeDataPath, maxBytes, ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      downloads.add(download);
      try { return await download; }
      finally { downloads.delete(download); }
    },
  };
}
