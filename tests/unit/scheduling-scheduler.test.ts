import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProactiveItem, Scope } from "../../src/domain.js";
import { createProactiveScheduler } from "../../src/scheduling/scheduler.js";

const scope: Scope = { ownerId: 101, botId: "bot-one", chatId: 101, topicId: null };
const quietHours = { start: "01:00", end: "09:30", timezone: "UTC" };

function recurringItem(id: string, nextDueAt: number): ProactiveItem {
  return {
    id,
    scope,
    agentId: "agent-one",
    kind: "recurring",
    schedule: { type: "interval", everyMs: 60_000 },
    purpose: `Reminder ${id}`,
    initiator: "agent",
    status: "active",
    nextDueAt,
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("proactive scheduler", () => {
  it("fires due items and advances recurring schedules", async () => {
    const item = recurringItem("one", Date.parse("2026-01-05T11:59:00Z"));
    const logger = { error: vi.fn() };
    const proactivity = {
      listDue: vi.fn(() => [item]),
      isAgentPaused: vi.fn(() => false),
      reschedule: vi.fn(() => true),
      setStatus: vi.fn(() => true),
    };
    const onDue = vi.fn(async () => true);
    const scheduler = createProactiveScheduler({
      store: { proactivity } as never,
      quietHours,
      pollIntervalMs: 1_000,
      onDue,
      logger,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();

    expect(onDue).toHaveBeenCalledWith(item);
    expect(proactivity.reschedule).toHaveBeenCalledWith(
      item.scope,
      item.id,
      Date.parse("2026-01-05T12:01:01Z"),
      Date.parse("2026-01-05T12:00:01Z"),
    );
    expect(proactivity.setStatus).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("suppresses polling entirely during quiet hours", async () => {
    vi.setSystemTime(new Date("2026-01-05T02:00:00Z"));
    const logger = { error: vi.fn() };
    const proactivity = {
      listDue: vi.fn(() => [recurringItem("one", Date.parse("2026-01-05T01:59:00Z"))]),
      isAgentPaused: vi.fn(() => false),
      reschedule: vi.fn(() => true),
      setStatus: vi.fn(() => true),
    };
    const onDue = vi.fn(async () => true);
    const scheduler = createProactiveScheduler({
      store: { proactivity } as never,
      quietHours,
      pollIntervalMs: 1_000,
      onDue,
      logger,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();

    expect(proactivity.listDue).not.toHaveBeenCalled();
    expect(onDue).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("skips paused-scope items without advancing them", async () => {
    const item = recurringItem("paused", Date.parse("2026-01-05T11:59:00Z"));
    const proactivity = {
      listDue: vi.fn(() => [item]),
      isAgentPaused: vi.fn(() => true),
      reschedule: vi.fn(() => true),
      setStatus: vi.fn(() => true),
    };
    const onDue = vi.fn(async () => true);
    const scheduler = createProactiveScheduler({
      store: { proactivity } as never,
      quietHours,
      pollIntervalMs: 1_000,
      onDue,
      logger: { error: vi.fn() },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();

    expect(onDue).not.toHaveBeenCalled();
    expect(proactivity.reschedule).not.toHaveBeenCalled();
    expect(proactivity.setStatus).not.toHaveBeenCalled();
  });

  it("leaves due items untouched when admission is declined", async () => {
    const item = recurringItem("retry", Date.parse("2026-01-05T11:59:00Z"));
    const proactivity = {
      listDue: vi.fn(() => [item]),
      isAgentPaused: vi.fn(() => false),
      reschedule: vi.fn(() => true),
      setStatus: vi.fn(() => true),
    };
    const onDue = vi.fn(async () => false);
    const scheduler = createProactiveScheduler({
      store: { proactivity } as never,
      quietHours,
      pollIntervalMs: 1_000,
      onDue,
      logger: { error: vi.fn() },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();

    expect(onDue).toHaveBeenCalledWith(item);
    expect(proactivity.reschedule).not.toHaveBeenCalled();
    expect(proactivity.setStatus).not.toHaveBeenCalled();
  });

  it("keeps processing other due items when one callback throws", async () => {
    const failingItem = recurringItem("bad", Date.parse("2026-01-05T11:58:00Z"));
    const healthyItem = recurringItem("good", Date.parse("2026-01-05T11:59:00Z"));
    const logger = { error: vi.fn() };
    const proactivity = {
      listDue: vi.fn(() => [failingItem, healthyItem]),
      isAgentPaused: vi.fn(() => false),
      reschedule: vi.fn(() => true),
      setStatus: vi.fn(() => true),
    };
    const onDue = vi.fn(async (item: ProactiveItem) => {
      if (item.id === failingItem.id) throw new Error("SYNTHETIC_TRIGGER_FAILURE");
      return true;
    });
    const scheduler = createProactiveScheduler({
      store: { proactivity } as never,
      quietHours,
      pollIntervalMs: 1_000,
      onDue,
      logger,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();

    expect(onDue).toHaveBeenCalledTimes(2);
    expect(proactivity.reschedule).toHaveBeenCalledTimes(1);
    expect(proactivity.reschedule).toHaveBeenCalledWith(
      healthyItem.scope,
      healthyItem.id,
      Date.parse("2026-01-05T12:01:01Z"),
      Date.parse("2026-01-05T12:00:01Z"),
    );
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
