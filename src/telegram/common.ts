import { GrammyError, type Api } from "grammy";
import { setTimeout as pause } from "node:timers/promises";

type Methods =
  "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage" | "sendDocument" | "editMessageText" |
  "answerCallbackQuery" | "getFile" | "sendChatAction" | "deleteMessage";
// grammY's Node declarations use the legacy abort-controller type. Node's native signal is runtime-compatible.
export type TelegramApi = { [M in Methods]: M extends "getMe" | "getWebhookInfo" ?
  (signal?: AbortSignal) => ReturnType<Api["raw"][M]> :
  (payload: Parameters<Api["raw"][M]>[0], signal?: AbortSignal) => ReturnType<Api["raw"][M]> };

export class TelegramError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "TelegramError"; this.code = code; }
}

export function apiFailure(error: unknown): { code: string; retryMs?: number; fatal?: boolean; missingReply?: boolean; known: boolean } {
  if (error instanceof TelegramError) return { code: error.code, known: true };
  if (!(error instanceof GrammyError)) return { code: "TG_NETWORK_UNCERTAIN", known: false };
  if (error.error_code === 429) {
    const seconds = error.parameters.retry_after;
    return { code: "TG_RATE_LIMIT", known: true, retryMs: Number.isSafeInteger(seconds) && seconds! > 0 ?
      Math.min(seconds! * 1000, Number.MAX_SAFE_INTEGER - Date.now()) : 1000 };
  }
  if (error.error_code === 401 || error.error_code === 404) return { code: "TG_TOKEN_INVALID", known: true, fatal: true };
  if (error.error_code === 409) return { code: "TG_POLLING_CONFLICT", known: true, fatal: true };
  if (error.error_code === 403) return { code: "TG_FORBIDDEN", known: true };
  if (error.error_code >= 500) return { code: "TG_SERVER_RETRY", known: true, retryMs: 2000 };
  if (error.error_code === 400) return {
    code: "TG_BAD_REQUEST", known: true,
    missingReply: /(?:message to be replied(?: to)? not found|reply message not found|replied message not found)/i.test(error.description),
  };
  return { code: "TG_API_REJECTED", known: true };
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    signal.throwIfAborted();
    const interval = Math.min(remaining, 60_000);
    await pause(interval, undefined, { signal });
    remaining -= interval;
  }
  signal.throwIfAborted();
}

export class RateLimiter {
  private botNext = new Map<string, number>();
  private chatNext = new Map<string, number>();
  private blockedUntil = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private readonly wait: typeof sleep;
  private readonly now: () => number;
  constructor(wait: typeof sleep = sleep, now: () => number = Date.now) { this.wait = wait; this.now = now; }

  block(botId: string, ms: number): void {
    this.blockedUntil.set(botId, Math.max(this.blockedUntil.get(botId) ?? 0, this.now() + ms));
  }
  async take(botId: string, chatId: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const previous = this.queues.get(botId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    // An aborted queued caller cannot release a later caller ahead of the current head.
    const tail = previous.then(() => turn);
    this.queues.set(botId, tail);
    const key = `${botId}:${chatId}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void previous.then(() => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(signal.reason);
          else resolve();
        });
      });
      for (;;) {
        signal.throwIfAborted();
        const now = this.now();
        const at = Math.max(now, this.botNext.get(botId) ?? 0, this.chatNext.get(key) ?? 0, this.blockedUntil.get(botId) ?? 0);
        if (at > now) {
          await this.wait(at - now, signal);
          continue;
        }
        // Reserve from the actual grant time, not a stale time before an extended cooldown.
        this.botNext.set(botId, now + 40);
        this.chatNext.set(key, now + (chatId < 0 ? 3100 : 1050));
        return;
      }
    } finally {
      release();
      void tail.then(() => { if (this.queues.get(botId) === tail) this.queues.delete(botId); });
    }
  }
}
