import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProactiveSchedule, Scope, Session } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { handleProactivityRequest, type ProactivityGuardrails } from "../../src/application/proactive-tool.js";
import { nextOccurrence } from "../../src/scheduling/rrule.js";
import { openStore } from "../../src/storage/index.js";

let root: string;
let path: string;
let store: StateStore;
const scope: Scope = { ownerId: 101, botId: "bot-one", chatId: 101, topicId: null };
const guardrails: ProactivityGuardrails = { maxActiveItemsPerAgent: 2, minIntervalMs: 30_000, timezone: "Europe/Kyiv" };

function session(target = scope, now = 1): Session {
  return store.sessions.create(target, {
    agentId: `agent-${target.botId}`,
    workspace: join(root, `${target.botId}-${target.chatId}`),
    model: "model-one",
    now,
  });
}

beforeEach(() => {
  root = resolve(".cache", `proactive-tool-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "workspace"), { recursive: true });
  path = join(root, "state.sqlite");
  store = openStore({ path });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("handleProactivityRequest", () => {
  it("schedules a one-off proactive item and records it with agent initiator", () => {
    session(scope, 1);
    const now = 1_000;
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "oneoff",
      schedule: { type: "once", at: now + guardrails.minIntervalMs + 5_000 },
      purpose: "Check in about the deployment",
    }, now);
    expect(result).toMatchObject({ ok: true, action: "schedule" });
    if (!result.ok || result.action !== "schedule") throw new Error("Expected schedule success");
    const stored = store.proactivity.get(scope, result.item.id);
    expect(stored).toMatchObject({
      agentId: "agent-one",
      initiator: "agent",
      kind: "oneoff",
      purpose: "Check in about the deployment",
      nextDueAt: now + guardrails.minIntervalMs + 5_000,
    });
  });

  it("schedules weekly proactive items using recurrence math from Phase 2", () => {
    session(scope, 1);
    const now = Date.UTC(2026, 9, 5, 12, 0, 0); // 2026-10-05 15:00 Europe/Kyiv, Monday
    const schedule: ProactiveSchedule = { type: "weekly", daysOfWeek: [3], hour: 9, minute: 45 };
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "recurring",
      schedule,
      purpose: "Wednesday review",
    }, now);
    expect(result).toMatchObject({ ok: true, action: "schedule" });
    if (!result.ok || result.action !== "schedule") throw new Error("Expected weekly schedule success");
    expect(result.item.nextDueAt).toBe(nextOccurrence(schedule, now, guardrails.timezone));
  });

  it("schedules monthly proactive items using recurrence math from Phase 2", () => {
    session(scope, 1);
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    const schedule: ProactiveSchedule = { type: "monthly", daysOfMonth: [15], hour: 10, minute: 30 };
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "silent",
      schedule,
      purpose: "Mid-month check",
    }, now);
    expect(result).toMatchObject({ ok: true, action: "schedule" });
    if (!result.ok || result.action !== "schedule") throw new Error("Expected monthly schedule success");
    expect(result.item.nextDueAt).toBe(nextOccurrence(schedule, now, guardrails.timezone));
  });

  it("rejects scheduling once the active-item guardrail is reached", () => {
    session(scope, 1);
    for (let index = 0; index < guardrails.maxActiveItemsPerAgent; index++) {
      store.proactivity.create(scope, {
        agentId: "agent-one",
        kind: "oneoff",
        schedule: { type: "once", at: 100_000 + index * 60_000 },
        purpose: `Existing ${index}`,
        initiator: "agent",
        nextDueAt: 100_000 + index * 60_000,
        now: 10 + index,
      });
    }
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "oneoff",
      schedule: { type: "once", at: 500_000 },
      purpose: "Overflow reminder",
    }, 1_000);
    expect(result).toEqual({
      ok: false,
      action: "schedule",
      code: "PROACTIVITY_GUARDRAIL_MAX_ITEMS",
      message: `This agent already has the maximum ${guardrails.maxActiveItemsPerAgent} active proactive items in this scope.`,
    });
  });

  it("allows one-off items scheduled less than the recurring minimum interval ahead", () => {
    session(scope, 1);
    const now = 10_000;
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "oneoff",
      schedule: { type: "once", at: now + guardrails.minIntervalMs - 1 },
      purpose: "Immediate reminder",
    }, now);
    expect(result).toMatchObject({ ok: true, action: "schedule" });
  });

  it("allows one-off items near existing one-off items", () => {
    session(scope, 1);
    const now = 10_000;
    store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "oneoff",
      schedule: { type: "once", at: now + 90_000 },
      purpose: "Existing reminder",
      initiator: "agent",
      nextDueAt: now + 90_000,
      now: now + 1,
    });
    const nearExisting = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "oneoff",
      schedule: { type: "once", at: now + 105_000 },
      purpose: "Nearby reminder",
    }, now);
    expect(nearExisting).toMatchObject({ ok: true, action: "schedule" });
  });

  it("rejects recurring intervals shorter than the minimum guardrail", () => {
    session(scope, 1);
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "recurring",
      schedule: { type: "interval", everyMs: guardrails.minIntervalMs - 1 },
      purpose: "Too-frequent reminder",
    }, 10_000);
    expect(result).toMatchObject({ ok: false, code: "PROACTIVITY_GUARDRAIL_MIN_INTERVAL" });
  });

  it("rejects recurring items whose first occurrence is too soon", () => {
    session(scope, 1);
    const now = Date.UTC(2026, 9, 5, 11, 59, 31); // 14:59:31 Europe/Kyiv, 29s before 15:00
    const result = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "recurring",
      schedule: { type: "weekly", daysOfWeek: [1], hour: 15, minute: 0 },
      purpose: "Too-soon weekly reminder",
    }, now);
    expect(result).toMatchObject({ ok: false, code: "PROACTIVITY_GUARDRAIL_MIN_INTERVAL" });
  });

  it("rejects recurring items too close to existing recurring items", () => {
    session(scope, 1);
    const now = 10_000;
    store.proactivity.create(scope, {
      agentId: "agent-one",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 60_000 },
      purpose: "Existing recurring reminder",
      initiator: "agent",
      nextDueAt: now + 50_000,
      now: now + 1,
    });
    const nearExisting = handleProactivityRequest(store, guardrails, scope, "agent-one", {
      action: "schedule",
      kind: "silent",
      schedule: { type: "interval", everyMs: guardrails.minIntervalMs },
      purpose: "Conflicting recurring reminder",
    }, now);
    expect(nearExisting).toMatchObject({ ok: false, code: "PROACTIVITY_GUARDRAIL_NEAR_EXISTING" });
  });

  it("lists only the calling agent's proactive items within the same scope", () => {
    session(scope, 1);
    store.proactivity.create(scope, {
      agentId: "agent-a",
      kind: "oneoff",
      schedule: { type: "once", at: 100_000 },
      purpose: "Agent A",
      initiator: "agent",
      nextDueAt: 100_000,
      now: 10,
    });
    store.proactivity.create(scope, {
      agentId: "agent-b",
      kind: "recurring",
      schedule: { type: "interval", everyMs: 60_000 },
      purpose: "Agent B",
      initiator: "oleh",
      nextDueAt: 120_000,
      now: 11,
    });
    const result = handleProactivityRequest(store, guardrails, scope, "agent-a", { action: "list" }, 20);
    expect(result).toMatchObject({ ok: true, action: "list", paused: false });
    if (!result.ok || result.action !== "list") throw new Error("Expected list success");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: expect.any(String), purpose: "Agent A", initiator: "agent" });
  });

  it("refuses to cancel another agent's proactive item", () => {
    session(scope, 1);
    const item = store.proactivity.create(scope, {
      agentId: "agent-b",
      kind: "oneoff",
      schedule: { type: "once", at: 100_000 },
      purpose: "Protected reminder",
      initiator: "agent",
      nextDueAt: 100_000,
      now: 10,
    });
    const result = handleProactivityRequest(store, guardrails, scope, "agent-a", { action: "cancel", id: item.id }, 20);
    expect(result).toEqual({
      ok: false,
      action: "cancel",
      code: "PROACTIVITY_NOT_OWNED",
      message: "Agents may only cancel their own proactive items.",
    });
    expect(store.proactivity.get(scope, item.id)?.status).toBe("active");
  });

  it("pauses and resumes all proactive activity for the scope", () => {
    session(scope, 1);
    const paused = handleProactivityRequest(store, guardrails, scope, "agent-one", { action: "pause" }, 10);
    expect(paused).toEqual({
      ok: true,
      action: "pause",
      paused: true,
      changed: true,
      message: "Paused proactive activity for this scope.",
    });
    expect(store.proactivity.isAgentPaused(scope)).toBe(true);

    const resumed = handleProactivityRequest(store, guardrails, scope, "agent-one", { action: "resume" }, 20);
    expect(resumed).toEqual({
      ok: true,
      action: "resume",
      paused: false,
      changed: true,
      message: "Resumed proactive activity for this scope.",
    });
    expect(store.proactivity.isAgentPaused(scope)).toBe(false);
  });

  it("resume pushes items that became due while paused to their next occurrence instead of leaving them due (FR-020)", () => {
    session(scope, 1);
    const schedule: ProactiveSchedule = { type: "interval", everyMs: 3_600_000 };
    const overdueAt = 1_000;
    const item = store.proactivity.create(scope, {
      agentId: "agent-one", kind: "recurring", schedule, purpose: "check in", initiator: "agent",
      nextDueAt: overdueAt, now: 1,
    });
    handleProactivityRequest(store, guardrails, scope, "agent-one", { action: "pause" }, 10);

    const now = overdueAt + 10_000;
    handleProactivityRequest(store, guardrails, scope, "agent-one", { action: "resume" }, now);

    const reloaded = store.proactivity.get(scope, item.id)!;
    expect(reloaded.status).toBe("active");
    expect(reloaded.nextDueAt).toBe(nextOccurrence(schedule, now, guardrails.timezone));
    expect(reloaded.nextDueAt).toBeGreaterThan(now);
  });
});
