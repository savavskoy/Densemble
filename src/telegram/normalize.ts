import type { Update, Message, UserFromGetMe } from "grammy/types";
import { authorizeScope, type ServiceConfig } from "../config/index.js";
import type { ChatKind, IncomingAttachment, IncomingMessage, NormalizedIngress, Scope } from "../domain.js";

export type Normalization =
  | { kind: "ingress"; ingress: NormalizedIngress }
  | { kind: "ignored"; code: string; callbackId?: string }
  | { kind: "unsupported"; scope: Scope; messageId: number };

function integer(value: unknown, positive = true): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    (positive ? value > 0 : value !== 0);
}

function route(config: ServiceConfig, botId: string, message: Message, sender: { id: number; is_bot: boolean } | undefined) {
  if (!sender || !integer(sender.id) || sender.is_bot !== false || !integer(message.chat.id, false) ||
      message.sender_chat || !integer(message.message_id)) return null;
  const kind: ChatKind | null = message.chat.type === "private" ? "private" :
    message.chat.type === "group" ? "group" :
      message.chat.type === "supergroup" ? (message.chat.is_forum ? "forum" : "group") : null;
  if (!kind) return null;
  const topic = message.message_thread_id ?? null;
  if (topic !== null && !integer(topic)) return null;
  const scope = authorizeScope(config, {
    ownerId: sender.id, isBot: sender.is_bot, botId, chatId: message.chat.id, topicId: topic, chatKind: kind,
  });
  return scope ? { scope, kind } : null;
}

/** Sender/binding checks precede every command, callback and media interpretation. */
export function normalizeUpdate(config: ServiceConfig, botId: string, bot: UserFromGetMe, update: Update, now = Date.now()): Normalization {
  try { return normalize(config, botId, bot, update, now); }
  catch { return { kind: "ignored", code: "TG_UPDATE_MALFORMED" }; }
}

function normalize(config: ServiceConfig, botId: string, bot: UserFromGetMe, update: Update, now: number): Normalization {
  if (update.callback_query) {
    const callback = update.callback_query;
    const ignored: Normalization = { kind: "ignored", code: "TG_CALLBACK_REJECTED", callbackId: callback.id };
    if (!callback.message || callback.message.date === 0 || !("from" in callback.message)) return ignored;
    const message = callback.message;
    // Inline/foreign messages are not service-owned prompts. The application checks the opaque request and generation.
    if (message.from?.id !== bot.id || message.from.is_bot !== true) return ignored;
    const binding = route(config, botId, message, callback.from);
    if (!binding || !callback.data || Buffer.byteLength(callback.data) > 64 ||
        !/^[A-Za-z0-9:_-]+$/.test(callback.data)) return ignored;
    return { kind: "ingress", ingress: {
      kind: "callback", scope: binding.scope, chatKind: binding.kind, updateId: update.update_id,
      messageId: message.message_id, receivedAt: now, callbackId: callback.id, data: callback.data,
    } };
  }
  if (!update.message) return { kind: "ignored", code: "TG_UPDATE_UNSUPPORTED" };
  const message = update.message;
  const binding = route(config, botId, message, message.from);
  if (!binding) return { kind: "ignored", code: "TG_SENDER_REJECTED" };
  const text = message.text ?? message.caption ?? "";
  const ingress: IncomingMessage = {
    kind: "message", scope: binding.scope, chatKind: binding.kind, updateId: update.update_id,
    messageId: message.message_id, receivedAt: now, text, attachments: [],
  };
  const command = (message.entities ?? message.caption_entities ?? []).find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (command && integer(command.length) && command.length <= text.length) {
    const value = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(text.slice(0, command.length));
    if (value) {
      if (value[2] && value[2].toLowerCase() !== bot.username.toLowerCase()) return { kind: "ignored", code: "TG_OTHER_BOT_COMMAND" };
      ingress.command = {
        name: value[1]!.toLowerCase(), arguments: text.slice(command.length).trim(),
        ...(value[2] ? { targetBotUsername: value[2] } : {}),
      };
    }
  }
  if (message.reply_to_message?.from?.id === bot.id && message.reply_to_message.from.is_bot === true &&
      message.reply_to_message.chat.id === message.chat.id &&
      (message.reply_to_message.message_thread_id ?? null) === binding.scope.topicId) {
    ingress.replyToMessageId = message.reply_to_message.message_id;
  }
  if (message.media_group_id) ingress.mediaGroupId = message.media_group_id;
  const photo = message.photo?.length ? message.photo.reduce((largest, candidate) =>
    candidate.width * candidate.height > largest.width * largest.height ? candidate : largest) : undefined;
  const source = photo ?? message.document ?? message.voice;
  if (source) {
    const attachment: IncomingAttachment = {
      kind: photo ? "photo" : message.document ? "document" : "voice",
      fileId: source.file_id, fileUniqueId: source.file_unique_id,
      ...(source.file_size !== undefined ? { sizeBytes: source.file_size } : {}),
    };
    if (message.document?.file_name) attachment.fileName = safeFileName(message.document.file_name);
    if (message.document?.mime_type) attachment.mimeType = message.document.mime_type;
    if (message.voice) {
      attachment.durationSeconds = message.voice.duration;
      if (message.voice.mime_type) attachment.mimeType = message.voice.mime_type;
    }
    if (photo) attachment.mimeType = "image/jpeg";
    ingress.attachments.push(attachment);
  }
  const unsupported = ["animation", "audio", "video", "video_note", "sticker", "contact", "location", "venue", "poll", "dice", "paid_media"];
  if (!ingress.command && (unsupported.some((key) => key in message) || (!text && !source))) {
    return { kind: "unsupported", scope: binding.scope, messageId: message.message_id };
  }
  return { kind: "ingress", ingress };
}

export function safeFileName(name: string): string {
  const leaf = name.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const safe = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return safe && safe !== "." && safe !== ".." ? [...safe].slice(0, 160).join("") : "attachment";
}
