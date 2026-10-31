import { describe, expect, it } from "vitest";
import type { ProactiveSchedule } from "../../src/domain.js";
import { nextOccurrence } from "../../src/scheduling/rrule.js";

describe("scheduling rrule", () => {
  it("returns future one-off timestamps and null for past ones", () => {
    expect(nextOccurrence({ type: "once", at: 5_000 }, 4_999, "UTC")).toBe(5_000);
    expect(nextOccurrence({ type: "once", at: 5_000 }, 5_000, "UTC")).toBeNull();
  });

  it("advances interval schedules from the last successful fire time", () => {
    expect(nextOccurrence({ type: "interval", everyMs: 90_000 }, 1_000, "UTC")).toBe(91_000);
  });

  it("finds the next weekly wall-clock occurrence strictly after the cursor", () => {
    const schedule = { type: "weekly", daysOfWeek: [1, 3], hour: 9, minute: 15 } satisfies ProactiveSchedule;
    expect(nextOccurrence(schedule, Date.parse("2026-01-05T09:14:00Z"), "UTC"))
      .toBe(Date.parse("2026-01-05T09:15:00Z"));
    expect(nextOccurrence(schedule, Date.parse("2026-01-05T09:15:00Z"), "UTC"))
      .toBe(Date.parse("2026-01-07T09:15:00Z"));
  });

  it("finds the next monthly occurrence and skips impossible month days", () => {
    const schedule = { type: "monthly", daysOfMonth: [1, 31], hour: 10, minute: 0 } satisfies ProactiveSchedule;
    expect(nextOccurrence(schedule, Date.parse("2025-01-31T10:00:00Z"), "UTC"))
      .toBe(Date.parse("2025-02-01T10:00:00Z"));
    expect(nextOccurrence({ ...schedule, daysOfMonth: [31] }, Date.parse("2025-01-31T10:00:00Z"), "UTC"))
      .toBe(Date.parse("2025-03-31T10:00:00Z"));
  });

  it("uses the next matching repeated local time across a DST fall-back boundary", () => {
    const schedule = { type: "weekly", daysOfWeek: [0], hour: 1, minute: 30 } satisfies ProactiveSchedule;
    expect(nextOccurrence(schedule, Date.parse("2025-11-02T05:45:00Z"), "America/New_York"))
      .toBe(Date.parse("2025-11-02T06:30:00Z"));
  });

  it("skips a missing local time across a DST spring-forward boundary", () => {
    const schedule = { type: "weekly", daysOfWeek: [0], hour: 2, minute: 30 } satisfies ProactiveSchedule;
    expect(nextOccurrence(schedule, Date.parse("2025-03-08T12:00:00Z"), "America/New_York"))
      .toBe(Date.parse("2025-03-16T06:30:00Z"));
  });
});
