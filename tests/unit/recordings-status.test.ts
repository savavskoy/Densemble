import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateSeconds, formatStatus, isStale, readStatus, writeStatus, type RecordingStatus } from "../../src/recordings/status.js";

let root: string;
beforeEach(() => {
  root = resolve(".cache", `recordings-status-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
function status(overrides: Partial<RecordingStatus> = {}): RecordingStatus {
  return { version: 1, updatedAt: new Date(NOW).toISOString(), enabled: true, pollIntervalMs: 60_000, current: null,
    queue: [], waiting: [], conflicts: [], failed: [], recent: [], ...overrides };
}

describe("writeStatus / readStatus", () => {
  it("writes an owner-only file atomically and reads it back", async () => {
    const path = join(root, "status.json");
    const value = status({ queue: ["2026/10/29/a.mp4"] });
    await writeStatus(path, value);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
    expect(await readStatus(path)).toEqual(value);
    await writeStatus(path, status({ queue: [] }));
    expect((await readStatus(path))?.queue).toEqual([]);
    expect(readdirSync(root)).toEqual(["status.json"]);
  });

  it("replaces an existing file even if it had looser permissions", async () => {
    const path = join(root, "status.json");
    writeFileSync(path, "old", { mode: 0o644 });
    await writeStatus(path, status());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind when the rename fails", async () => {
    const path = join(root, "dir-in-the-way");
    mkdirSync(join(path, "child"), { recursive: true });
    await expect(writeStatus(path, status())).rejects.toBeDefined();
    expect(readdirSync(root)).toEqual(["dir-in-the-way"]);
  });

  it("returns undefined for missing, garbage or foreign JSON", async () => {
    expect(await readStatus(join(root, "missing.json"))).toBeUndefined();
    for (const [name, text] of [["garbage", "{not json"], ["null", "null"], ["v2", JSON.stringify({ ...status(), version: 2 })],
      ["no-date", JSON.stringify({ version: 1 })], ["array", "[]"]] as const) {
      writeFileSync(join(root, name), text);
      expect(await readStatus(join(root, name))).toBeUndefined();
    }
  });
});

describe("isStale", () => {
  it("is stale only after three poll intervals or with a bad date", () => {
    const value = status();
    expect(isStale(value, NOW)).toBe(false);
    expect(isStale(value, NOW + 180_000)).toBe(false);
    expect(isStale(value, NOW + 180_001)).toBe(true);
    expect(isStale(status({ updatedAt: "nonsense" }), NOW)).toBe(true);
  });
});

describe("estimateSeconds", () => {
  it("extrapolates running time linearly", () => {
    expect(estimateSeconds(60_000, 25)).toBe(180);
    expect(estimateSeconds(10_000, 50)).toBe(10);
    expect(estimateSeconds(1_000, 3)).toBe(32);
  });
  it("is unknown before progress and zero when done", () => {
    expect(estimateSeconds(60_000, 0)).toBeNull();
    expect(estimateSeconds(0, 40)).toBeNull();
    expect(estimateSeconds(60_000, 100)).toBe(0);
    expect(estimateSeconds(0, 100)).toBe(0);
  });
});

describe("formatStatus", () => {
  it("reports off when no folder is configured", () => {
    expect(formatStatus({ configured: false, status: status(), now: NOW })).toBe("Recording transcription is off (no recordings folder configured).\n");
  });
  it("reports not running for a missing or stale snapshot", () => {
    const text = "Recording transcription: service not running.\n";
    expect(formatStatus({ configured: true, status: undefined, now: NOW })).toBe(text);
    expect(formatStatus({ configured: true, status: status(), now: NOW + 180_001 })).toBe(text);
  });
  it("reports disabled models", () => {
    expect(formatStatus({ configured: true, status: status({ enabled: false }), now: NOW }))
      .toBe("Recording transcription is off (model or VAD model not ready; run make doctor).\n");
  });
  it("reports idle", () => {
    expect(formatStatus({ configured: true, status: status(), now: NOW })).toBe("Idle: nothing is being transcribed.\n");
  });
  it("reports progress, pause and every list", () => {
    const text = formatStatus({ configured: true, now: NOW, status: status({
      current: { file: "2026/10/29/a.mp4", mode: "retry", startedAt: new Date(NOW).toISOString(), percent: 42,
        etaSeconds: 3_900, paused: true },
      queue: ["2026/10/29/b.mp4"],
      waiting: ["c.mp4"],
      conflicts: [{ file: "d.mp4", reason: "TARGET_EXISTS" }],
      failed: [{ file: "2026/10/28/e.mp4", code: "ASR_FAILED", at: new Date(NOW).toISOString() }],
      recent: Array.from({ length: 7 }, (_, index) => ({ file: `f${index}.mp4`, transcript: `2026/10/27/t${index}.txt`,
        at: new Date(NOW).toISOString() })),
    }) });
    expect(text).toBe([
      "Transcribing: 2026/10/29/a.mp4 (retry)",
      "  42% done, about 1 h 5 min left — paused for a voice message",
      "Queued (1):", "  2026/10/29/b.mp4",
      "Waiting to finish recording (1):", "  c.mp4",
      "Conflicts (1):", "  d.mp4 — TARGET_EXISTS",
      "Failed (retried after a restart) (1):", "  2026/10/28/e.mp4 — ASR_FAILED",
      "Recently done (5):", "  2026/10/27/t0.txt", "  2026/10/27/t1.txt", "  2026/10/27/t2.txt", "  2026/10/27/t3.txt",
      "  2026/10/27/t4.txt",
      "",
    ].join("\n"));
  });
  it("names long digital silence for the current and recently done recordings", () => {
    const silences = [{ startSeconds: 810, durationSeconds: 4860 }];
    const text = formatStatus({ configured: true, now: NOW, status: status({
      current: { file: "2026/10/30/b.mp4", mode: "first", startedAt: new Date(NOW).toISOString(), percent: 0, etaSeconds: null,
        paused: false, silences },
      recent: [{ file: "2026/10/29/a.mp4", transcript: "2026/10/29/a.txt", at: new Date(NOW).toISOString(), silences },
        { file: "2026/10/29/c.mp4", transcript: "2026/10/29/c.txt", at: new Date(NOW).toISOString() }],
    }) });
    expect(text).toBe(["Transcribing: 2026/10/30/b.mp4", "  0% done", "  no audio signal from 13:30 for 81 min",
      "Recently done (2):", "  2026/10/29/a.txt — no audio signal from 13:30 for 81 min", "  2026/10/29/c.txt", ""].join("\n"));
  });
  it("formats first attempts without ETA, and minute/second durations", () => {
    const current = { file: "x.mp4", mode: "first" as const, startedAt: new Date(NOW).toISOString(), percent: 0, etaSeconds: null, paused: false };
    expect(formatStatus({ configured: true, now: NOW, status: status({ current }) }))
      .toBe("Transcribing: x.mp4\n  0% done\n");
    expect(formatStatus({ configured: true, now: NOW, status: status({ current: { ...current, percent: 10, etaSeconds: 125 } }) }))
      .toBe("Transcribing: x.mp4\n  10% done, about 2 min left\n");
    expect(formatStatus({ configured: true, now: NOW, status: status({ current: { ...current, percent: 99, etaSeconds: 7 } }) }))
      .toBe("Transcribing: x.mp4\n  99% done, about 7 s left\n");
  });
});
