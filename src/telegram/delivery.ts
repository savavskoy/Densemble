import type { Message, Opts } from "grammy/types";
import { authorizeScope, type LoadedConfig } from "../config/index.js";
import type { OutboxItem, RunIdentity, Scope } from "../domain.js";
import type { DeliveryOutcome, DeliveryTransport, DiagnosticSink, StateStore } from "../ports.js";
import { apiFailure, RateLimiter, TelegramError, type TelegramApi } from "./common.js";
import { openUpload, type AttachmentResolver } from "./files.js";
import { renderTelegramHtml } from "./format.js";

interface Preview {
  messageId?: number;
  lastAt: number;
  text: string;
  busy: boolean;
  disabled: boolean;
  identity: RunIdentity;
  waitAbort: AbortController;
  deletion?: Promise<void>;
}
export interface TelegramDeliveryTransport extends DeliveryTransport {
  invalidatePreview(identity: RunIdentity): Promise<void>;
}
export interface ManagedTelegramDeliveryTransport extends TelegramDeliveryTransport {
  sweepPreviews(): Promise<void>;
  clearPreviews(): Promise<void>;
}
export interface DeliveryOptions {
  config: LoadedConfig;
  store: StateStore;
  diagnostics: DiagnosticSink;
  apiForBot(botId: string): TelegramApi;
  signal: AbortSignal;
  limiter: RateLimiter;
  resolveAttachment?: AttachmentResolver;
}

export function createDeliveryTransport(options: DeliveryOptions): ManagedTelegramDeliveryTransport {
  const previews = new Map<string, Preview>();
  const previewOperations = new Set<Promise<void>>();
  const previewDeletions = new Set<Promise<void>>();
  const sending = new Set<string>();
  const { store, limiter } = options;
  function assertRoute(scope: Scope): void {
    const binding = options.config.config.bindings.find((entry) => entry.botId === scope.botId &&
      entry.chatId === scope.chatId && entry.topicId === scope.topicId);
    if (!binding || !authorizeScope(options.config.config, { ...scope, chatKind: binding.kind, isBot: false })) {
      throw new TelegramError("TG_DELIVERY_SCOPE_REJECTED");
    }
  }
  function requestLive(item: OutboxItem): boolean {
    if (item.payload.kind !== "request") return true;
    const request = store.requests.get(item.scope, item.payload.requestId);
    return !!request && request.status === "pending" && request.expiresAt > Date.now() && store.runs.isLive(request);
  }
  function removePreviewMessage(entry: Preview): Promise<void> {
    const messageId = entry.messageId;
    if (!messageId) return Promise.resolve();
    if (entry.deletion) return entry.deletion;
    const deletion = (async () => {
      try {
        await options.apiForBot(entry.identity.scope.botId).deleteMessage({
          chat_id: entry.identity.scope.chatId, message_id: messageId,
        }, AbortSignal.timeout(3000));
      } catch { options.diagnostics.record("TG_PREVIEW_DELETE_FAILED", { botId: entry.identity.scope.botId }); }
    })();
    entry.deletion = deletion;
    previewDeletions.add(deletion);
    void deletion.finally(() => previewDeletions.delete(deletion));
    return deletion;
  }
  function invalidateEntry(entry: Preview): Promise<void> {
    entry.disabled = true;
    entry.text = "";
    entry.waitAbort.abort();
    if (previews.get(entry.identity.runId) === entry) previews.delete(entry.identity.runId);
    // A pending initial send retains the entry, not the text, and deletes its ID when the API returns.
    return removePreviewMessage(entry);
  }
  function sameIdentity(left: RunIdentity, right: RunIdentity): boolean {
    return left.runId === right.runId && left.sessionId === right.sessionId && left.generation === right.generation &&
      left.scope.ownerId === right.scope.ownerId && left.scope.botId === right.scope.botId &&
      left.scope.chatId === right.scope.chatId && left.scope.topicId === right.scope.topicId;
  }
  function invalidatePreview(identity: RunIdentity): Promise<void> {
    const entry = previews.get(identity.runId);
    return entry && sameIdentity(entry.identity, identity) ? invalidateEntry(entry) : Promise.resolve();
  }
  async function clearPreview(item: OutboxItem) {
    if (!item.runId || "buttons" in item.payload || (item.payload.kind !== "text" && item.payload.kind !== "file")) return;
    const preview = previews.get(item.runId);
    if (preview) await invalidateEntry(preview);
  }
  async function showPreview(entry: Preview): Promise<void> {
    const { identity } = entry;
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
    try {
      assertRoute(identity.scope);
      await limiter.take(identity.scope.botId, identity.scope.chatId, AbortSignal.any([signal, entry.waitAbort.signal]));
      if (entry.disabled || !store.runs.isLive(identity)) { await invalidateEntry(entry); return; }
      const api = options.apiForBot(identity.scope.botId);
      const first = renderTelegramHtml(`⏳ ${entry.text}`, 4000)[0]!;
      if (entry.messageId) await api.editMessageText({
        chat_id: identity.scope.chatId, message_id: entry.messageId, text: first.html, parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }, signal);
      else {
        const message = await api.sendMessage({
          chat_id: identity.scope.chatId, text: first.html, parse_mode: "HTML",
          ...(identity.scope.topicId === null ? {} : { message_thread_id: identity.scope.topicId }),
          link_preview_options: { is_disabled: true },
        }, signal);
        entry.messageId = message.message_id;
      }
      if (entry.disabled || !store.runs.isLive(identity)) await invalidateEntry(entry);
    } catch (error) {
      if (entry.disabled || options.signal.aborted || !store.runs.isLive(identity)) {
        await invalidateEntry(entry);
        return;
      }
      const failure = apiFailure(error);
      if (failure.retryMs !== undefined) limiter.block(identity.scope.botId, failure.retryMs);
      // Never create a second preview after an ambiguous initial send.
      if (!entry.messageId && !failure.known) entry.disabled = true;
      entry.text = "";
      options.diagnostics.record("TG_PREVIEW_UNAVAILABLE", { botId: identity.scope.botId });
    } finally {
      entry.busy = false;
    }
  }
  return {
    invalidatePreview,
    async sweepPreviews() {
      const pending: Promise<void>[] = [];
      for (const entry of previews.values()) {
        if (!store.runs.isLive(entry.identity)) pending.push(invalidateEntry(entry));
      }
      await Promise.allSettled(pending);
    },
    async clearPreviews() {
      const pending = [...previews.values()].map(invalidateEntry);
      await Promise.allSettled([...pending, ...previewOperations, ...previewDeletions]);
    },
    async deliver(candidate, requestedSignal) {
      const signal = AbortSignal.any([options.signal, ...(requestedSignal ? [requestedSignal] : [])]);
      const ids: number[] = [];
      let attempted = false;
      let item: OutboxItem | null = null;
      let acquired = false;
      let upload: Awaited<ReturnType<typeof openUpload>> | undefined;
      try {
        item = store.outbox.get(candidate.scope, candidate.id);
        if (!item || item.status !== "sending" || item.attempts !== candidate.attempts) throw new TelegramError("TG_DELIVERY_NOT_CLAIMED");
        if (sending.has(item.id)) throw new TelegramError("TG_DELIVERY_IN_PROGRESS");
        sending.add(item.id);
        acquired = true;
        assertRoute(item.scope);
        if (!requestLive(item)) throw new TelegramError("TG_REQUEST_STALE");
        const api = options.apiForBot(item.scope.botId);
        const route = {
          chat_id: item.scope.chatId,
          ...(item.scope.topicId === null ? {} : { message_thread_id: item.scope.topicId }),
        };
        let replyId = item.replyToMessageId;
        let buttons: Opts<"sendMessage">["reply_markup"];
        if ("buttons" in item.payload) {
          if (item.payload.buttons.length > 100 || item.payload.buttons.some((row) => row.length > 8 || row.some((button) =>
            !button.text.trim() || button.text.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(button.data) || Buffer.byteLength(button.data) > 64))) {
            throw new TelegramError("TG_BUTTON_INVALID");
          }
          buttons = { inline_keyboard: item.payload.buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) };
        }
        if (item.payload.kind === "file") {
          if (!options.resolveAttachment) throw new TelegramError("TG_FILE_RESOLVER_MISSING");
          const attachment = store.attachments.get(item.scope, item.payload.attachmentId);
          if (!attachment || attachment.sessionId !== item.sessionId || attachment.kind !== "output") throw new TelegramError("TG_FILE_SCOPE_REJECTED");
          upload = await openUpload(options.config.config.runtimeDataPath, await options.resolveAttachment(item.scope, item.payload.attachmentId));
        }
        const payload = item.payload;
        const chunks = renderTelegramHtml(payload.kind === "file" ? (payload.caption ?? "") : payload.text,
          payload.kind === "file" ? 1024 : 4096);
        if (payload.kind !== "file" && !chunks.length) throw new TelegramError("TG_EMPTY_TEXT");
        const total = Math.max(1, chunks.length);
        for (let index = 0; index < total; index++) {
          await limiter.take(item.scope.botId, item.scope.chatId, signal);
          signal.throwIfAborted();
          if (!requestLive(item)) throw new TelegramError("TG_REQUEST_STALE");
          const call = async (): Promise<Message> => {
            attempted = true;
            const reply = replyId === null ? {} : { reply_parameters: { message_id: replyId, allow_sending_without_reply: false } };
            if (payload.kind === "file" && index === 0) {
              return api.sendDocument({
                ...route, ...reply, document: upload!.file,
                ...(chunks[0] ? { caption: chunks[0].html, parse_mode: "HTML" } : {}),
              }, signal);
            }
            return api.sendMessage({
              ...route, ...reply, text: chunks[index]!.html, parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              ...(buttons && index === total - 1 ? { reply_markup: buttons } : {}),
            }, signal);
          };
          let sent: Message;
          try { sent = await call(); }
          catch (error) {
            if (!apiFailure(error).missingReply || replyId === null) throw error;
            // Only this documented 400 can safely retry without a reply; the topic never changes.
            replyId = null;
            options.diagnostics.record("TG_REPLY_MISSING_FALLBACK", { botId: item.scope.botId });
            if (payload.kind === "file" && index === 0) {
              await upload!.close();
              upload = await openUpload(options.config.config.runtimeDataPath, await options.resolveAttachment!(item.scope, payload.attachmentId));
            }
            await limiter.take(item.scope.botId, item.scope.chatId, signal);
            sent = await call();
          }
          if (!Number.isSafeInteger(sent.message_id) || sent.message_id < 1) throw new Error("INVALID_API_RESULT");
          ids.push(sent.message_id);
          if (payload.kind === "request" && index === total - 1 &&
              !store.requests.setPrompt(item.scope, payload.requestId, sent.message_id)) {
            throw new TelegramError("TG_PROMPT_MAPPING_FAILED");
          }
        }
        await clearPreview(item);
        return { status: "sent", remoteMessageIds: ids };
      } catch (error) {
        const failure = apiFailure(error);
        if (item && failure.retryMs !== undefined) limiter.block(item.scope.botId, failure.retryMs);
        const outcome: DeliveryOutcome = ids.length ? { status: "uncertain", remoteMessageIds: ids, errorCode: "TG_PARTIAL_DELIVERY" } :
          attempted && !failure.known ? { status: "uncertain", errorCode: "TG_NETWORK_UNCERTAIN" } :
            { status: "failed", errorCode: signal.aborted && !attempted ? "TG_DELIVERY_CANCELLED" : failure.code,
              ...(failure.retryMs === undefined ? {} : { retryAfter: Date.now() + failure.retryMs }) };
        options.diagnostics.record(outcome.errorCode!, {
          botId: candidate.scope.botId,
          ...(item ? { attempt: item.attempts } : {}),
          ...(outcome.retryAfter === undefined ? {} : { retryAfter: outcome.retryAfter }),
        });
        return outcome;
      } finally {
        if (acquired) sending.delete(candidate.id);
        await upload?.close().catch(() => undefined);
      }
    },
    async preview(identity, text) {
      if (options.signal.aborted || !store.runs.isLive(identity)) { await invalidatePreview(identity); return; }
      if (!text) return;
      let preview = previews.get(identity.runId);
      if (!preview) {
        preview = { lastAt: 0, text: "", busy: false, disabled: false, identity, waitAbort: new AbortController() };
        previews.set(identity.runId, preview);
      }
      if (preview.disabled || preview.busy || preview.text === text || Date.now() - preview.lastAt < 1500) return;
      const entry = preview;
      entry.busy = true;
      entry.lastAt = Date.now();
      entry.text = text;
      text = "";
      const operation = showPreview(entry);
      previewOperations.add(operation);
      try { await operation; }
      finally { previewOperations.delete(operation); }
    },
    async acknowledgeCallback(botId, callbackId, text) {
      try {
        await options.apiForBot(botId).answerCallbackQuery({
          callback_query_id: callbackId, ...(text ? { text: text.slice(0, 180) } : {}),
        }, AbortSignal.any([options.signal, AbortSignal.timeout(3000)]));
      } catch { options.diagnostics.record("TG_CALLBACK_ACK_FAILED", { botId }); }
    },
  };
}
