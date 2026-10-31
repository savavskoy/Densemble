import { describe, expect, it } from "vitest";
import { isQuietHours } from "../../src/scheduling/quiet-hours.js";

describe("scheduling quiet hours", () => {
  it("treats overnight windows as spanning midnight", () => {
    const quietHours = { start: "22:00", end: "06:00", timezone: "UTC" };
    expect(isQuietHours(Date.parse("2026-01-05T23:00:00Z"), quietHours)).toBe(true);
    expect(isQuietHours(Date.parse("2026-01-06T05:59:00Z"), quietHours)).toBe(true);
    expect(isQuietHours(Date.parse("2026-01-06T06:00:00Z"), quietHours)).toBe(false);
    expect(isQuietHours(Date.parse("2026-01-05T21:59:00Z"), quietHours)).toBe(false);
  });

  it("uses start-inclusive and end-exclusive boundaries", () => {
    const quietHours = { start: "01:00", end: "09:30", timezone: "UTC" };
    expect(isQuietHours(Date.parse("2026-01-05T01:00:00Z"), quietHours)).toBe(true);
    expect(isQuietHours(Date.parse("2026-01-05T09:29:00Z"), quietHours)).toBe(true);
    expect(isQuietHours(Date.parse("2026-01-05T09:30:00Z"), quietHours)).toBe(false);
  });

  it("handles ordinary daytime windows", () => {
    const quietHours = { start: "13:00", end: "14:00", timezone: "UTC" };
    expect(isQuietHours(Date.parse("2026-01-05T12:59:00Z"), quietHours)).toBe(false);
    expect(isQuietHours(Date.parse("2026-01-05T13:00:00Z"), quietHours)).toBe(true);
    expect(isQuietHours(Date.parse("2026-01-05T13:30:00Z"), quietHours)).toBe(true);
    expect(isQuietHours(Date.parse("2026-01-05T14:00:00Z"), quietHours)).toBe(false);
  });
});
