import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleHealth, ModuleReason, ModuleState, ModuleStateReport } from "../../src/modules/contract.js";
import type { ModuleView } from "../../src/modules/host.js";
import { noticesPath, readNoticeLedger, startModuleNotices, type ModuleNotices } from "../../src/modules/notices.js";
import type { DiagnosticSink } from "../../src/ports.js";
import { entry, fakeModule } from "../fixtures/modules/index.js";

let runtime: string;
const diagnostics: DiagnosticSink = { record: () => undefined };
const quietHours = { start: "22:00", end: "08:00", timezone: "UTC" };
const day = Date.parse("2026-10-31T12:00:00Z");
const night = Date.parse("2026-10-31T23:00:00Z");
const morning = Date.parse("2026-11-01T08:05:00Z");
const running: ModuleNotices[] = [];

beforeEach(() => { runtime = mkdtempSync(join(tmpdir(), "densemble-notices-")); });
afterEach(async () => {
  for (const notices of running.splice(0)) await notices.stop();
  rmSync(runtime, { recursive: true, force: true });
});

/** A controllable host: one module whose state the test sets. */
function fakeHost(reasons: Record<string, ModuleReason> = {}) {
  let health: ModuleHealth = { state: "starting", code: "MODULE_STARTING", since: 1 };
  let enabled = true;
  const listeners = new Set<(id: string, health: ModuleHealth) => void>();
  const definition = fakeModule("watcher", { reasons });
  return {
    set(state: ModuleState, code: string, since: number) {
      health = { state, code, since };
      if (state === "disabled") enabled = false;
      for (const listener of listeners) listener("watcher", health);
    },
    report(): ModuleStateReport[] {
      const why = reasons[health.code];
      return [{ id: "watcher", enabled, state: health.state, code: health.code, requires: [], agents: [],
        ...(why ? { cause: why.cause, fix: why.fix } : {}) }];
    },
    health: () => health,
    get: (): ModuleView => ({ entry: entry("watcher"), definition, health }),
    onChange(listener: (id: string, health: ModuleHealth) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

function setup(host: ReturnType<typeof fakeHost>, clock: { now: number }, sent: { text: string; key: string }[], notify = true) {
  const notices = startModuleNotices({
    host, runtimeDataPath: runtime, quietHours, diagnostics, intervalMs: 3_600_000, now: () => clock.now,
    ...(notify ? { notify: (text: string, key: string) => { sent.push({ text, key }); return true; } } : {}),
  });
  running.push(notices);
  return notices;
}

const reasons = {
  FOLDER_GONE: { cause: "Папка недоступна.", fix: "Підключіть диск." },
  MODEL_GONE: { cause: "Немає моделі.", fix: "Завантажте модель." },
  DISK_FULL: { cause: "Диск заповнено.", fix: "Звільніть місце.", urgent: true },
};

describe("coordinator notices (SC-010)", () => {
  it("sends a failure once, does not repeat it after a restart, and sends recovery once", async () => {
    const host = fakeHost(reasons);
    const clock = { now: day };
    const sent: { text: string; key: string }[] = [];
    host.set("failed", "FOLDER_GONE", 100);
    const first = setup(host, clock, sent);
    await first.evaluate();
    await first.evaluate();
    expect(sent).toEqual([{ text: "Модуль «watcher» аварійно зупинився.\nПричина: Папка недоступна.\nЩо зробити: Підключіть диск.",
      key: "module:watcher:FOLDER_GONE:100" }]);
    expect(statSync(noticesPath(runtime)).mode & 0o777).toBe(0o600);
    await first.stop();

    // Restart: a new ledger instance, the same failure with a new `since`.
    host.set("failed", "FOLDER_GONE", 200);
    const second = setup(host, clock, sent);
    await second.evaluate();
    expect(sent).toHaveLength(1);

    host.set("unavailable", "MODEL_GONE", 300);
    await second.evaluate();
    expect(sent.at(-1)).toEqual({ text: expect.stringContaining("недоступний.\nПричина: Немає моделі."), key: "module:watcher:MODEL_GONE:300" });

    host.set("ready", "MODULE_READY", 400);
    await second.evaluate();
    await second.evaluate();
    expect(sent.slice(2)).toEqual([{ text: "Модуль «watcher» знову працює.", key: "module:watcher:ok:400" }]);
    expect((await readNoticeLedger(noticesPath(runtime))).modules.watcher).toEqual({ notified: "ok" });
  });

  it("stays silent for a module that starts ready, and for disabled or starting modules", async () => {
    const host = fakeHost(reasons);
    const sent: { text: string; key: string }[] = [];
    const notices = setup(host, { now: day }, sent);
    await notices.evaluate();
    host.set("ready", "MODULE_READY", 10);
    await notices.evaluate();
    host.set("disabled", "MODULE_DISABLED", 20);
    await notices.evaluate();
    expect(sent).toEqual([]);
  });

  it("defers a notice during quiet hours and sends it once after the window", async () => {
    const host = fakeHost(reasons);
    const clock = { now: night };
    const sent: { text: string; key: string }[] = [];
    host.set("failed", "FOLDER_GONE", 100);
    const notices = setup(host, clock, sent);
    await notices.evaluate();
    expect(sent).toEqual([]);
    expect((await readNoticeLedger(noticesPath(runtime))).modules.watcher)
      .toEqual({ notified: "ok", pending: { code: "FOLDER_GONE", at: night } });
    clock.now = morning;
    await notices.evaluate();
    await notices.evaluate();
    expect(sent.map((item) => item.key)).toEqual(["module:watcher:FOLDER_GONE:100"]);
    expect((await readNoticeLedger(noticesPath(runtime))).modules.watcher).toEqual({ notified: "FOLDER_GONE" });
  });

  it("drops a deferred failure that recovered before the window ended", async () => {
    const host = fakeHost(reasons);
    const clock = { now: night };
    const sent: { text: string; key: string }[] = [];
    host.set("ready", "MODULE_READY", 50);
    const notices = setup(host, clock, sent);
    await notices.evaluate();
    host.set("failed", "FOLDER_GONE", 100);
    await notices.evaluate();
    host.set("ready", "MODULE_READY", 150);
    await notices.evaluate();
    clock.now = morning;
    await notices.evaluate();
    expect(sent).toEqual([]);
  });

  it("sends an urgent reason during quiet hours", async () => {
    const host = fakeHost(reasons);
    const sent: { text: string; key: string }[] = [];
    host.set("failed", "DISK_FULL", 100);
    const notices = setup(host, { now: night }, sent);
    await notices.evaluate();
    expect(sent.map((item) => item.key)).toEqual(["module:watcher:DISK_FULL:100"]);
  });

  it("sends nothing and records nothing without a coordinator", async () => {
    const host = fakeHost(reasons);
    const sent: { text: string; key: string }[] = [];
    host.set("failed", "FOLDER_GONE", 100);
    const notices = setup(host, { now: day }, sent, false);
    await notices.evaluate();
    expect(sent).toEqual([]);
    expect((await readNoticeLedger(noticesPath(runtime))).modules).toEqual({});
  });

  it("re-evaluates on a host change", async () => {
    const host = fakeHost(reasons);
    const sent: { text: string; key: string }[] = [];
    const notices = setup(host, { now: day }, sent);
    await notices.evaluate();
    host.set("failed", "FOLDER_GONE", 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
  });
});
