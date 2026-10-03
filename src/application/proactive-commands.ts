import { defaultQuietHours } from "../config/index.js";
import type { LoadedConfig } from "../config/index.js";
import type { ProactiveItem, Scope } from "../domain.js";
import type { StateStore } from "../ports.js";
import { nextOccurrence } from "../scheduling/rrule.js";
import { reconcileOverdueOnResume } from "./proactive-tool.js";

const kindLabels: Record<ProactiveItem["kind"], string> = {
  oneoff: "одноразове",
  recurring: "періодичне",
  silent: "тихе",
};

const initiatorLabels: Record<ProactiveItem["initiator"], string> = {
  oleh: "Олег",
  agent: "агент",
};

const statusLabels: Record<ProactiveItem["status"], string> = {
  active: "активне",
  paused: "на паузі",
  cancelled: "скасоване",
  done: "завершене",
};

function timezoneOf(config: LoadedConfig): string {
  return config.config.quietHours?.timezone ?? defaultQuietHours.timezone;
}

function formatDue(nextDueAt: number | null, timezone: string): string {
  if (nextDueAt === null) return "—";
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(nextDueAt));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function usage(): { text: string } {
  return {
    text: [
      "Використання /proactive:",
      "• list",
      "• pause [id]",
      "• resume [id]",
      "• cancel <id>",
    ].join("\n"),
  };
}

function listItems(store: StateStore, config: LoadedConfig, scope: Scope): { text: string } {
  const items = store.proactivity.listForScope(scope);
  const paused = store.proactivity.isAgentPaused(scope);
  const header = `Проактивність агента: ${paused ? "на паузі" : "активна"}.`;
  if (!items.length) return { text: `${header}\nПроактивних елементів немає.` };

  const timezone = timezoneOf(config);
  const lines = items.map((item) => [
    item.id,
    kindLabels[item.kind],
    truncate(item.purpose, 60),
    initiatorLabels[item.initiator],
    statusLabels[item.status],
    formatDue(item.nextDueAt, timezone),
  ].join(" | "));
  return {
    text: [
      header,
      "ID | Тип | Мета | Ініціатор | Стан | Наступне спрацювання",
      ...lines,
    ].join("\n"),
  };
}

function pauseItem(store: StateStore, scope: Scope, id: string, now: number): { text: string } {
  const item = store.proactivity.get(scope, id);
  if (!item) return { text: `Елемент не знайдено: ${id}` };
  if (item.status === "paused") return { text: `Елемент уже на паузі: ${item.purpose}` };
  store.proactivity.setStatus(scope, id, "paused", now);
  return { text: `Елемент призупинено: ${item.purpose}` };
}

function resumeItem(store: StateStore, config: LoadedConfig, scope: Scope, id: string, now: number): { text: string } {
  const item = store.proactivity.get(scope, id);
  if (!item) return { text: `Елемент не знайдено: ${id}` };
  if (item.status !== "paused") return { text: `Елемент не перебуває на паузі: ${item.id}` };

  const timezone = timezoneOf(config);
  let nextDueAt = item.nextDueAt;
  if (nextDueAt === null || nextDueAt <= now) {
    const next = nextOccurrence(item.schedule, now, timezone);
    if (next === null) {
      store.proactivity.setStatus(scope, id, "done", now);
      return { text: `Елемент більше не має майбутніх спрацювань і позначений як завершений: ${item.purpose}` };
    }
    store.proactivity.reschedule(scope, id, next, now);
    nextDueAt = next;
  }

  store.proactivity.setStatus(scope, id, "active", now);
  return {
    text: `Елемент відновлено: ${item.purpose}\nНаступне спрацювання: ${formatDue(nextDueAt, timezone)}`,
  };
}

function cancelItem(store: StateStore, scope: Scope, id: string, now: number): { text: string } {
  const item = store.proactivity.get(scope, id);
  if (!item) return { text: `Елемент не знайдено: ${id}` };
  store.proactivity.setStatus(scope, id, "cancelled", now);
  return { text: `Елемент скасовано: ${item.purpose}` };
}

function pauseAgent(store: StateStore, scope: Scope, now: number): { text: string } {
  const changed = store.proactivity.setAgentPaused(scope, true, now);
  return { text: changed ? "Усю проактивність агента призупинено." : "Уся проактивність агента вже на паузі." };
}

function resumeAgent(store: StateStore, config: LoadedConfig, scope: Scope, now: number): { text: string } {
  if (!store.proactivity.isAgentPaused(scope)) return { text: "Проактивність агента вже активна." };

  const timezone = timezoneOf(config);
  store.proactivity.setAgentPaused(scope, false, now);
  reconcileOverdueOnResume(store, store.proactivity.listForScope(scope), now, timezone);
  return { text: "Проактивність агента відновлено. Пропущені під час паузи нагадування пропущено, а не поставлено в чергу." };
}

export function handleProactiveCommand(
  store: StateStore,
  config: LoadedConfig,
  scope: Scope,
  argumentsText: string,
  now = Date.now(),
): { text: string } {
  const parts = argumentsText.trim().split(/\s+/).filter(Boolean);
  const [verbRaw, ...rest] = parts;
  const verb = verbRaw?.toLowerCase() ?? "list";
  const id = rest.join(" ").trim();

  if (!verbRaw || verb === "list") return listItems(store, config, scope);
  if (verb === "pause") return id ? pauseItem(store, scope, id, now) : pauseAgent(store, scope, now);
  if (verb === "resume") return id ? resumeItem(store, config, scope, id, now) : resumeAgent(store, config, scope, now);
  if (verb === "cancel" && id) return cancelItem(store, scope, id, now);
  return usage();
}
