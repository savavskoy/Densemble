import type { ProactiveSchedule } from "../domain.js";
import { daysInMonth, findMatchingInstants, nextDay, wallClockParts, weekdayForDate } from "./wall-clock.js";

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function nextWeeklyOccurrence(schedule: Extract<ProactiveSchedule, { type: "weekly" }>, after: number, timezone: string): number | null {
  const days = uniqueSorted(schedule.daysOfWeek);
  if (!days.length) return null;
  let cursor = wallClockParts(after, timezone);
  for (let remainingDays = 0; remainingDays < 14; remainingDays++) {
    const target = { year: cursor.year, month: cursor.month, day: cursor.day };
    if (days.includes(weekdayForDate(target))) {
      const match = findMatchingInstants({ ...target, hour: schedule.hour, minute: schedule.minute }, timezone)
        .find((timestamp) => timestamp > after);
      if (match !== undefined) return match;
    }
    cursor = { ...cursor, ...nextDay(target) };
  }
  return null;
}

function nextMonthlyOccurrence(schedule: Extract<ProactiveSchedule, { type: "monthly" }>, after: number, timezone: string): number | null {
  const days = uniqueSorted(schedule.daysOfMonth);
  if (!days.length) return null;
  const wallClock = wallClockParts(after, timezone);
  let year = wallClock.year;
  let month = wallClock.month;
  for (let remainingMonths = 0; remainingMonths < 24; remainingMonths++) {
    const lastDay = daysInMonth(year, month);
    for (const day of days) {
      if (day > lastDay) continue;
      const match = findMatchingInstants({ year, month, day, hour: schedule.hour, minute: schedule.minute }, timezone)
        .find((timestamp) => timestamp > after);
      if (match !== undefined) return match;
    }
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return null;
}

export function nextOccurrence(schedule: ProactiveSchedule, after: number, timezone: string): number | null {
  switch (schedule.type) {
    case "once":
      return schedule.at > after ? schedule.at : null;
    case "interval":
      // Phase 2 keeps intervals state-free: advance from the last successful scheduler tick.
      return after + schedule.everyMs;
    case "weekly":
      return nextWeeklyOccurrence(schedule, after, timezone);
    case "monthly":
      return nextMonthlyOccurrence(schedule, after, timezone);
  }
}
