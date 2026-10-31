import type { ProactiveItem } from "../domain.js";
import type { StateStore } from "../ports.js";
import { isQuietHours, type QuietHoursConfig } from "./quiet-hours.js";
import { nextOccurrence } from "./rrule.js";

export interface ProactiveSchedulerOptions {
  store: Pick<StateStore, "proactivity">;
  quietHours: QuietHoursConfig;
  onDue: (item: ProactiveItem) => Promise<boolean>;
  pollIntervalMs?: number;
  now?: () => number;
  logger?: Pick<Console, "error">;
}

export function createProactiveScheduler(options: ProactiveSchedulerOptions): { start(): void; stop(): void } {
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? console;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  async function tick(): Promise<void> {
    const timestamp = now();
    if (isQuietHours(timestamp, options.quietHours)) return;
    for (const item of options.store.proactivity.listDue(timestamp)) {
      try {
        if (options.store.proactivity.isAgentPaused(item.scope)) continue;
        const admitted = await options.onDue(item);
        if (!admitted) continue;
        if (item.schedule.type === "once") {
          options.store.proactivity.setStatus(item.scope, item.id, "done", timestamp);
          continue;
        }
        const nextDueAt = nextOccurrence(item.schedule, timestamp, options.quietHours.timezone);
        if (nextDueAt === null) {
          options.store.proactivity.setStatus(item.scope, item.id, "done", timestamp);
        } else {
          options.store.proactivity.reschedule(item.scope, item.id, nextDueAt, timestamp);
        }
      } catch (error) {
        logger.error("[proactive-scheduler] failed processing due item", { itemId: item.id, error });
      }
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = tick()
          .catch((error) => {
            logger.error("[proactive-scheduler] polling tick failed", error);
          })
          .finally(() => { running = undefined; });
      }, pollIntervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
