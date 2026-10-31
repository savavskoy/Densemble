import { minutesOfDay, parseClockTime, wallClockParts } from "./wall-clock.js";

export interface QuietHoursConfig {
  start: string;
  end: string;
  timezone: string;
}

export function isQuietHours(now: number, quietHours: QuietHoursConfig): boolean {
  const currentMinutes = minutesOfDay(wallClockParts(now, quietHours.timezone));
  const startMinutes = minutesOfDay(parseClockTime(quietHours.start));
  const endMinutes = minutesOfDay(parseClockTime(quietHours.end));
  // Quiet hours are start-inclusive and end-exclusive.
  if (startMinutes <= endMinutes) return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
