import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProactiveSchedule, Scope, Session } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { openStore } from "../../src/storage/index.js";

let root: string;
let path: string;
let store: StateStore;
const scope: Scope = { ownerId: 101, botId: "bot-one", chatId: 101, topicId: null };
const otherScope: Scope = { ownerId: 101, botId: "bot-two", chatId: -201, topicId: 1 };

function session(target = scope, now = 1): Session {
  return store.sessions.create(target, {
    agentId: `agent-${target.botId}`,
    workspace: join(root, `${target.botId}-${target.chatId}`),
    model: "model-one",
    now,
  });
}

beforeEach(() => {
  root = resolve(".cache", `proactivity-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "workspace"), { recursive: true });
  path = join(root, "state.sqlite");
  store = openStore({ path });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("proactivity storage", () => {
  it("creates items, resolves scope ownership, and lists scope and global due items", () => {
    session(scope, 5);
    session(otherScope, 6);
    const weekly: ProactiveSchedule = { type: "weekly", daysOfWeek: [1, 5], hour: 19, minute: 30 };
    const monthly: ProactiveSchedule = { type: "monthly", daysOfMonth: [1, 15], hour: 10, minute: 0 };
    const active = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: weekly,
      purpose: "Weekly review",
      initiator: "agent",
      nextDueAt: 100,
      now: 10,
    });
    const paused = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "silent",
      schedule: monthly,
      purpose: "Silent oversight",
      initiator: "oleh",
      nextDueAt: 120,
      now: 11,
    });
    const other = store.proactivity.create(otherScope, {
      agentId: "agent-two",
      kind: "oneoff",
      schedule: { type: "once", at: 90 },
      purpose: "Other scope reminder",
      initiator: "oleh",
      nextDueAt: 90,
      now: 12,
    });
    expect(store.proactivity.setStatus(scope, paused.id, "paused", 20)).toBe(true);
    expect(store.proactivity.get(scope, active.id)).toEqual(active);
    expect(store.proactivity.get(otherScope, active.id)).toBeNull();
    expect(store.proactivity.listForScope(scope)).toEqual([
      active,
      { ...paused, status: "paused", updatedAt: 20 },
    ]);
    expect(store.proactivity.listDue(100)).toEqual([other, active]);
  });

  it("counts active items and supports status transitions and rescheduling", () => {
    session(scope, 1);
    const first = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "oneoff",
      schedule: { type: "once", at: 500 },
      purpose: "First reminder",
      initiator: "oleh",
      nextDueAt: 500,
      now: 10,
    });
    const second = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 3_600_000 },
      purpose: "Second reminder",
      initiator: "agent",
      nextDueAt: 600,
      now: 11,
    });
    expect(store.proactivity.countActive(scope)).toBe(2);
    expect(store.proactivity.setStatus(scope, first.id, "done", 20)).toBe(true);
    expect(store.proactivity.countActive(scope)).toBe(1);
    expect(store.proactivity.reschedule(scope, second.id, 900, 30)).toBe(true);
    expect(store.proactivity.get(scope, first.id)).toMatchObject({ status: "done", updatedAt: 20 });
    expect(store.proactivity.get(scope, second.id)).toMatchObject({ nextDueAt: 900, updatedAt: 30 });
  });

  it("tracks per-agent pause state separately from due-item queries", () => {
    session(scope, 1);
    const item = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 1_800_000 },
      purpose: "Heartbeat",
      initiator: "agent",
      nextDueAt: 100,
      now: 10,
    });
    expect(store.proactivity.isAgentPaused(scope)).toBe(false);
    expect(store.proactivity.listDue(100)).toEqual([item]);
    expect(store.proactivity.setAgentPaused(scope, true, 20)).toBe(true);
    expect(store.proactivity.isAgentPaused(scope)).toBe(true);
    expect(store.proactivity.listDue(100)).toEqual([item]);
    expect(store.proactivity.setAgentPaused(scope, false, 30)).toBe(true);
    expect(store.proactivity.isAgentPaused(scope)).toBe(false);
  });

  it("records occurrences, settles them once, and derives stable negative synthetic ids", () => {
    session(scope, 1);
    const item = store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "oneoff",
      schedule: { type: "once", at: 200 },
      purpose: "Reminder",
      initiator: "oleh",
      nextDueAt: 200,
      now: 10,
    });
    const first = store.proactivity.recordOccurrence(item.id, 200, false, 20);
    const second = store.proactivity.recordOccurrence(item.id, 400, true, 21);
    const firstSynthetic = store.proactivity.syntheticId(first.id);
    const secondSynthetic = store.proactivity.syntheticId(second.id);
    expect(first).toMatchObject({ itemId: item.id, dueAt: 200, outcome: "pending", late: false, settledAt: null, createdAt: 20 });
    expect(second).toMatchObject({ itemId: item.id, dueAt: 400, outcome: "pending", late: true, settledAt: null, createdAt: 21 });
    expect(firstSynthetic).toBeLessThan(0);
    expect(secondSynthetic).toBeLessThan(0);
    expect(secondSynthetic).not.toBe(firstSynthetic);
    expect(store.proactivity.syntheticId(first.id)).toBe(firstSynthetic);
    expect(store.proactivity.settleOccurrence(first.id, "sent", 30)).toBe(true);
    expect(store.proactivity.settleOccurrence(first.id, "failed", 31)).toBe(false);
  });
});
