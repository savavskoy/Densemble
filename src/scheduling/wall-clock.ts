const MINUTE_MS = 60_000;
const SEARCH_WINDOW_MS = 36 * 60 * 60 * 1_000;
const clockPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const weekdayIndex = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
} satisfies Record<string, number>);

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
}

export interface ZonedDateTimeParts extends LocalDateTimeParts {
  second: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

export function wallClockParts(timestamp: number, timezone: string): ZonedDateTimeParts {
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let hour: number | undefined;
  let minute: number | undefined;
  let second: number | undefined;
  let weekday: number | undefined;
  for (const part of formatter(timezone).formatToParts(new Date(timestamp))) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      case "weekday":
        weekday = weekdayIndex[part.value as keyof typeof weekdayIndex];
        break;
    }
  }
  if (year === undefined || month === undefined || day === undefined ||
      hour === undefined || minute === undefined || second === undefined || weekday === undefined) {
    throw new Error("WALL_CLOCK_PARTS_UNAVAILABLE");
  }
  return { year, month, day, hour, minute, second, weekday };
}

export function parseClockTime(value: string): { hour: number; minute: number } {
  const match = clockPattern.exec(value);
  if (!match) throw new Error("INVALID_CLOCK_TIME");
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function minutesOfDay(parts: { hour: number; minute: number }): number {
  return parts.hour * 60 + parts.minute;
}

export function weekdayForDate(parts: LocalDateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextDay(parts: LocalDateParts): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function findMatchingInstants(target: LocalDateTimeParts, timezone: string): number[] {
  const approximate = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, 0, 0);
  const matches: number[] = [];
  for (let timestamp = approximate - SEARCH_WINDOW_MS; timestamp <= approximate + SEARCH_WINDOW_MS; timestamp += MINUTE_MS) {
    const parts = wallClockParts(timestamp, timezone);
    if (parts.year === target.year && parts.month === target.month && parts.day === target.day &&
        parts.hour === target.hour && parts.minute === target.minute) {
      matches.push(timestamp);
    }
  }
  return matches;
}
