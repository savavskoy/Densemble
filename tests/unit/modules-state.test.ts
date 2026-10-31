import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModuleError, type ModuleStateReport } from "../../src/modules/contract.js";
import { createModuleHost } from "../../src/modules/host.js";
import {
  formatModulesSection, formatModulesStatus, modulesStatePath, movedSettingsText, readModulesState,
  startModulesStateWriter, writeModulesState,
} from "../../src/modules/state.js";
import type { DiagnosticSink } from "../../src/ports.js";
import { entry, fakeCore, fakeLoader, fakeModule } from "../fixtures/modules/index.js";
import { fixture, scope } from "./session-runtime-fixtures.js";

let runtime: string;
const diagnostics: DiagnosticSink = { record: () => undefined };
beforeEach(() => { runtime = mkdtempSync(join(tmpdir(), "densemble-modules-state-")); });
afterEach(() => { rmSync(runtime, { recursive: true, force: true }); });

async function reportHost() {
  const ready = fakeModule("ready", { start: async () => ({ status: () => "2 у черзі", stop: async () => undefined }) });
  const missing = fakeModule("missing", {
    reasons: { MODEL_MISSING: { cause: "Немає файлу моделі.", fix: "Завантажте модель і виконайте make restart." } },
    start: async () => { throw new ModuleError("MODEL_MISSING", { unavailable: true }); },
  });
  const dependent = fakeModule("dependent", { requires: ["off"] });
  const host = createModuleHost({
    entries: [entry("ready", { agents: ["alfred"] }), entry("off", { enabled: false }), entry("missing"), entry("dependent")],
    loader: fakeLoader([ready, missing, dependent, fakeModule("off")]), core: fakeCore(), runtimeDataPath: runtime,
    diagnostics, readInstructions: async () => "# instructions",
  });
  await host.start();
  return host;
}

describe("module state report (SC-005)", () => {
  it("gives every non-ready module a cause and a fix, and ready modules their status line", async () => {
    const host = await reportHost();
    const rows = host.report();
    expect(rows.map((row) => [row.id, row.state, row.code])).toEqual([
      ["ready", "ready", "MODULE_READY"], ["off", "disabled", "MODULE_DISABLED"],
      ["missing", "unavailable", "MODEL_MISSING"], ["dependent", "unavailable", "MODULE_DEPENDENCY_UNAVAILABLE"],
    ]);
    expect(rows[0]).toMatchObject({ status: "2 у черзі", agents: ["alfred"] });
    expect(rows[0]?.cause).toBeUndefined();
    for (const row of rows.slice(1)) {
      expect(row.cause?.length).toBeGreaterThan(0);
      expect(row.fix?.length).toBeGreaterThan(0);
    }
    expect(rows[2]).toMatchObject({ cause: "Немає файлу моделі.", fix: "Завантажте модель і виконайте make restart." });
    expect(rows[3]?.cause).toContain("«off»");
    await host.stop();
  });

  it("falls back to a generic cause and fix for an undeclared failure code", async () => {
    const odd = fakeModule("odd", { start: async () => { throw new ModuleError("ODD_THING_FAILED"); } });
    const host = createModuleHost({ entries: [entry("odd")], loader: fakeLoader([odd]), core: fakeCore(),
      runtimeDataPath: runtime, diagnostics, readInstructions: async () => "# instructions" });
    await host.start();
    expect(host.report()[0]).toMatchObject({ state: "failed", code: "ODD_THING_FAILED" });
    expect(host.report()[0]?.cause).toContain("ODD_THING_FAILED");
    expect(host.report()[0]?.fix).toContain("make restart");
  });
});

describe("state.json and modules-status", () => {
  const row: ModuleStateReport = { id: "recordings", enabled: true, state: "unavailable", code: "MODEL_MISSING",
    cause: "Немає моделі.", fix: "Завантажте модель.", requires: [], agents: [],
    movedSettings: { from: "recordings", to: "modules.recordings.settings" } };

  it("writes atomically with mode 0600 and reads back; garbage reads as missing", async () => {
    const path = modulesStatePath(runtime);
    await writeModulesState(path, [row], Date.parse("2026-10-31T10:00:00Z"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readModulesState(path)).toEqual({ version: 1, updatedAt: "2026-10-31T10:00:00.000Z", modules: [row] });
    writeFileSync(path, "{ not json");
    expect(await readModulesState(path)).toBeUndefined();
    expect(await readModulesState(join(runtime, "absent.json"))).toBeUndefined();
  });

  it("formats rows with cause, fix and the moved-setting hint, and reports a stale snapshot as not running", () => {
    const now = Date.parse("2026-10-31T10:00:00Z");
    const fresh = { version: 1 as const, updatedAt: new Date(now - 60_000).toISOString(), modules: [row] };
    const text = formatModulesStatus({ state: fresh, now });
    expect(text).toContain("recordings — unavailable [MODEL_MISSING]");
    expect(text).toContain("Cause: Немає моделі.");
    expect(text).toContain("Fix: Завантажте модель.");
    expect(text).toContain("`recordings` moved to `modules.recordings.settings`; add `\"agents\": [\"alfred\"]` to `modules.recordings`");
    expect(formatModulesStatus({ state: { ...fresh, updatedAt: new Date(now - 4 * 60_000).toISOString() }, now }))
      .toContain("service not running");
    expect(formatModulesStatus({ state: undefined, now })).toContain("service not running");
    expect(formatModulesStatus({ state: { ...fresh, modules: [] }, now })).toBe("No modules configured.\n");
    expect(movedSettingsText({ ...row, agents: ["alfred"] })).toBe("`recordings` moved to `modules.recordings.settings`.");
    expect(movedSettingsText({ id: "x", agents: [] })).toBeUndefined();
  });

  it("writes on start and on every host change, and stops writing after stop()", async () => {
    let fail!: (code: string) => void;
    const flaky = fakeModule("flaky", { reasons: { FLAKY_DOWN: { cause: "Збій.", fix: "Перезапустіть." } },
      start: async (ctx) => { fail = ctx.fail; return { stop: async () => undefined }; } });
    const host = createModuleHost({ entries: [entry("flaky")], loader: fakeLoader([flaky]), core: fakeCore(),
      runtimeDataPath: runtime, diagnostics, readInstructions: async () => "# instructions" });
    await host.resolve();
    const writer = startModulesStateWriter({ host, runtimeDataPath: runtime, diagnostics, intervalMs: 3_600_000 });
    await writer.flush();
    const path = modulesStatePath(runtime);
    expect((await readModulesState(path))?.modules[0]?.state).toBe("starting");
    await host.start();
    await writer.flush();
    expect((await readModulesState(path))?.modules[0]?.state).toBe("ready");
    fail("FLAKY_DOWN");
    await writer.flush();
    expect((await readModulesState(path))?.modules[0]).toMatchObject({ state: "failed", cause: "Збій." });
    await writer.stop();
    rmSync(path);
    await writer.flush();
    expect(await readModulesState(path)).toBeUndefined();
    await host.stop();
  });
});

describe("/status «Модулі» section", () => {
  const rows: ModuleStateReport[] = [
    { id: "recordings", enabled: true, state: "ready", code: "MODULE_READY", requires: [], agents: [], status: "2 у черзі" },
    { id: "reels", enabled: true, state: "unavailable", code: "REELS_TOKEN_MISSING", cause: "Немає токена.",
      fix: "Додайте токен.", requires: [], agents: [] },
    { id: "off", enabled: false, state: "disabled", code: "MODULE_DISABLED", cause: "Вимкнено.", fix: "Увімкніть.",
      requires: [], agents: [] },
  ];

  it("formats one Ukrainian line per module", () => {
    expect(formatModulesSection(rows)).toBe("Модулі:\nrecordings — працює: 2 у черзі\n" +
      "reels — недоступний. Немає токена. Що зробити: Додайте токен.\noff — вимкнено. Вимкнено. Що зробити: Увімкніть.");
    expect(formatModulesSection([])).toBe("");
  });

  it("appears in the owner's /status and not in a non-owner's", async () => {
    const f = fixture({ modules: { report: () => rows } });
    try {
      await f.app.handle(f.command("status"));
      await f.app.drain();
      const owner = f.delivered.map((item) => item.payload.kind === "text" ? item.payload.text : "").join("\n");
      expect(owner).toContain("Агент: synthetic-agent");
      expect(owner).toContain("\n\nМодулі:\nrecordings — працює: 2 у черзі");

      const guest = { ownerId: 202, botId: scope.botId, chatId: 202, topicId: null };
      f.config.config.users = [{ telegramUserId: 202, allowedBotIds: [scope.botId] }];
      f.config.config.bindings.push({ botId: scope.botId, chatId: 202, topicId: null, kind: "private" });
      f.delivered.length = 0;
      await f.app.handle(f.command("status", guest));
      await f.app.drain();
      const text = f.delivered.map((item) => item.payload.kind === "text" ? item.payload.text : "").join("\n");
      expect(text).toContain("Агент: synthetic-agent");
      expect(text).not.toContain("Модулі");
    } finally { await f.close(); }
  });

  it("keeps /status unchanged without a module provider", async () => {
    const f = fixture();
    try {
      await f.app.handle(f.command("status"));
      await f.app.drain();
      expect(f.delivered.map((item) => item.payload.kind === "text" ? item.payload.text : "").join("\n")).not.toContain("Модулі");
    } finally { await f.close(); }
  });
});

describe("Application.notifyCoordinator", () => {
  it("enqueues plain text once per dedup key into the coordinator's private chat", async () => {
    const f = fixture();
    try {
      expect(f.app.notifyCoordinator("Модуль «x» недоступний.", "module:x:CODE:1")).toBe(false);
      f.config.config.coordinatorAgentId = "synthetic-agent";
      expect(f.app.notifyCoordinator("Модуль «x» недоступний.", "module:x:CODE:1")).toBe(true);
      expect(f.app.notifyCoordinator("Модуль «x» недоступний.", "module:x:CODE:1")).toBe(true);
      expect(f.app.notifyCoordinator("Модуль «x» знову працює.", "module:x:ok:2")).toBe(true);
      const items = f.store.outbox.list(scope).filter((item) => item.dedupKey.startsWith("module:"));
      expect(items.map((item) => item.payload)).toEqual([
        { kind: "text", text: "Модуль «x» недоступний." }, { kind: "text", text: "Модуль «x» знову працює." },
      ]);
    } finally { await f.close(); }
  });
});
