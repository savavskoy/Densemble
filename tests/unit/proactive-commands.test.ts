import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";
import type { Scope, Session } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { handleProactiveCommand } from "../../src/application/proactive-commands.js";
import { openStore } from "../../src/storage/index.js";

let root: string;
let path: string;
let store: StateStore;
const scope: Scope = { ownerId: 101, botId: "bot-one", chatId: 101, topicId: null };

function config(timezone = "UTC"): LoadedConfig {
  return {
    config: {
      quietHours: { start: "01:00", end: "09:30", timezone },
    },
  } as LoadedConfig;
}

function session(target = scope, now = 1): Session {
  return store.sessions.create(target, {
    agentId: `agent-${target.botId}`,
    workspace: join(root, `${target.botId}-${target.chatId}`),
    model: "model-one",
    now,
  });
}

beforeEach(() => {
  root = resolve(".cache", `proactive-command-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "workspace"), { recursive: true });
  path = join(root, "state.sqlite");
  store = openStore({ path });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("handleProactiveCommand", () => {
  it("lists an empty scope with the agent pause header", () => {
    session(scope, 1);
    const result = handleProactiveCommand(store, config(), scope, "");
    expect(result.text).toBe("Проактивність агента: активна.\nПроактивних елементів немає.");
  });

  it("lists active and paused items and shows the paused-agent header", () => {
    session(scope, 1);
    const longPurpose = "Дуже довга мета нагадування, яку треба обрізати до компактного текстового рядка для команди перегляду";
    const active = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "oneoff",
      schedule: { type: "once", at: Date.UTC(2026, 9, 5, 10, 0, 0) },
      purpose: longPurpose,
      initiator: "oleh",
      nextDueAt: Date.UTC(2026, 9, 5, 10, 0, 0),
      now: 10,
    });
    const paused = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "silent",
      schedule: { type: "interval", everyMs: 3_600_000 },
      purpose: "Тихо перевірити дедлайни",
      initiator: "agent",
      nextDueAt: Date.UTC(2026, 9, 5, 11, 0, 0),
      now: 11,
    });
    store.proactivity.setStatus(scope, paused.id, "paused", 12);
    store.proactivity.setAgentPaused(scope, true, 13);

    const result = handleProactiveCommand(store, config("Europe/Kyiv"), scope, "list");

    expect(result.text).toContain("Проактивність агента: на паузі.");
    expect(result.text).toContain("ID | Тип | Мета | Ініціатор | Стан | Наступне спрацювання");
    expect(result.text).toContain(active.id);
    expect(result.text).toContain("одноразове");
    expect(result.text).toContain("Олег");
    expect(result.text).toContain("активне");
    expect(result.text).toContain("Дуже довга мета нагадування");
    expect(result.text).toContain("…");
    expect(result.text).toContain(paused.id);
    expect(result.text).toContain("тихе");
    expect(result.text).toContain("агент");
    expect(result.text).toContain("на паузі");
  });

  it("pauses, resumes, and cancels an item by id", () => {
    session(scope, 1);
    const item = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 3_600_000 },
      purpose: "Щотижневий огляд витрат",
      initiator: "agent",
      nextDueAt: Date.UTC(2026, 9, 5, 12, 0, 0),
      now: 10,
    });

    const paused = handleProactiveCommand(store, config(), scope, `pause ${item.id}`, 20);
    expect(paused.text).toBe("Елемент призупинено: Щотижневий огляд витрат");
    expect(store.proactivity.get(scope, item.id)?.status).toBe("paused");

    const resumed = handleProactiveCommand(store, config(), scope, `resume ${item.id}`, 30);
    expect(resumed.text).toContain("Елемент відновлено: Щотижневий огляд витрат");
    expect(resumed.text).toContain("Наступне спрацювання:");
    expect(store.proactivity.get(scope, item.id)?.status).toBe("active");

    const cancelled = handleProactiveCommand(store, config(), scope, `cancel ${item.id}`, 40);
    expect(cancelled.text).toBe("Елемент скасовано: Щотижневий огляд витрат");
    expect(store.proactivity.get(scope, item.id)?.status).toBe("cancelled");
  });

  it("reports a not-found error for item commands", () => {
    session(scope, 1);
    const result = handleProactiveCommand(store, config(), scope, "pause missing-id", 20);
    expect(result.text).toBe("Елемент не знайдено: missing-id");
  });

  it("resumes an overdue paused item onto its next future occurrence", () => {
    session(scope, 1);
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    const item = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 3_600_000 },
      purpose: "Перевірити чергу завдань",
      initiator: "agent",
      nextDueAt: now - 60_000,
      now: 10,
    });
    store.proactivity.setStatus(scope, item.id, "paused", 20);

    const result = handleProactiveCommand(store, config(), scope, `resume ${item.id}`, now);
    const updated = store.proactivity.get(scope, item.id);

    expect(result.text).toContain("Елемент відновлено: Перевірити чергу завдань");
    expect(updated?.status).toBe("active");
    expect(updated?.nextDueAt).toBeGreaterThan(now);
  });

  it("pauses and resumes the whole agent while dropping missed reminders instead of queueing them", () => {
    session(scope, 1);
    const pauseAt = Date.UTC(2026, 9, 5, 9, 0, 0);
    const resumeAt = Date.UTC(2026, 9, 5, 12, 0, 0);
    const overdue = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 3_600_000 },
      purpose: "Огляд інцидентів",
      initiator: "agent",
      nextDueAt: pauseAt + 60_000,
      now: 10,
    });
    const pausedItem = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 7_200_000 },
      purpose: "Призупинений окремий елемент",
      initiator: "oleh",
      nextDueAt: pauseAt + 120_000,
      now: 11,
    });
    store.proactivity.setStatus(scope, pausedItem.id, "paused", 12);

    const paused = handleProactiveCommand(store, config(), scope, "pause", pauseAt);
    expect(paused.text).toBe("Усю проактивність агента призупинено.");
    expect(store.proactivity.isAgentPaused(scope)).toBe(true);

    const resumed = handleProactiveCommand(store, config(), scope, "resume", resumeAt);
    const updatedOverdue = store.proactivity.get(scope, overdue.id);
    const updatedPausedItem = store.proactivity.get(scope, pausedItem.id);

    expect(resumed.text).toContain("Пропущені під час паузи нагадування пропущено");
    expect(store.proactivity.isAgentPaused(scope)).toBe(false);
    expect(updatedOverdue?.status).toBe("active");
    expect(updatedOverdue?.nextDueAt).toBeGreaterThan(resumeAt);
    expect(updatedPausedItem?.status).toBe("paused");
    expect(updatedPausedItem?.nextDueAt).toBe(pausedItem.nextDueAt);
  });

  it("returns a usage hint for unknown verbs", () => {
    session(scope, 1);
    const result = handleProactiveCommand(store, config(), scope, "dance");
    expect(result.text).toContain("Використання /proactive:");
    expect(result.text).toContain("pause [id]");
    expect(result.text).toContain("resume [id]");
    expect(result.text).toContain("cancel <id>");
  });
});
