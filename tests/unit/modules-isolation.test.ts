import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModuleError, type AbilityCall, type ModuleDefinition } from "../../src/modules/contract.js";
import { createModuleHost } from "../../src/modules/host.js";
import { createProactiveScheduler } from "../../src/scheduling/scheduler.js";
import { entry, fakeCore, fakeLoader, fakeModule } from "../fixtures/modules/index.js";
import { fixture, scope, until } from "./session-runtime-fixtures.js";

let runtime: string;
let codes: string[];
beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "densemble-modules-isolation-"));
  codes = [];
});
afterEach(() => { rmSync(runtime, { recursive: true, force: true }); });

const call: AbilityCall = {
  scope: { ownerId: 1, botId: "bot", chatId: 1, topicId: null }, agentId: "alfred", userId: 1, owner: true,
  workspace: "/workspace", signal: new AbortController().signal,
};

/** Its background work rejects once `crash()` is called, as a real worker hitting an unexpected error would. */
function crashingModule(): ModuleDefinition & { crash(): void } {
  let crash!: () => void;
  const crashed = new Promise<void>((resolve) => { crash = resolve; });
  const definition = fakeModule("crashy", {
    abilities: [{ name: "crashy_ping", description: "Ping.", input: z.object({}), readOnly: true }],
    start: async (ctx) => {
      ctx.run(async () => {
        await crashed;
        throw new ModuleError("CRASHY_WORKER_CRASHED");
      });
      return { invoke: async () => ({ ok: true, message: "pong" }), stop: async () => undefined };
    },
  });
  return Object.assign(definition, { crash: () => { crash(); } });
}

function steadyModule(): ModuleDefinition {
  return fakeModule("steady", {
    abilities: [{ name: "steady_ping", description: "Ping.", input: z.object({}), readOnly: true }],
    start: async () => ({ status: () => "idle", invoke: async () => ({ ok: true, message: "pong" }), stop: async () => undefined }),
  });
}

function host(definitions: ModuleDefinition[]) {
  return createModuleHost({
    entries: definitions.map((definition) => entry(definition.id)), loader: fakeLoader(definitions), core: fakeCore(),
    runtimeDataPath: runtime, diagnostics: { record: (code) => { codes.push(code); } },
    readInstructions: async () => "# instructions",
  });
}

describe("module failure isolation (US7, SC-004)", () => {
  it("marks only the crashed module failed; the other module and the host keep working", async () => {
    const crashy = crashingModule();
    const modules = host([crashy, steadyModule()]);
    await modules.start();
    expect(modules.health("crashy")?.state).toBe("ready");
    crashy.crash();
    await until(() => modules.health("crashy")?.state === "failed");

    expect(modules.health("crashy")).toMatchObject({ state: "failed", code: "CRASHY_WORKER_CRASHED" });
    expect(modules.health("steady")).toMatchObject({ state: "ready", code: "MODULE_READY" });
    expect(modules.abilities().map((ability) => ability.spec.name)).toEqual(["steady_ping"]);
    expect(await modules.abilities()[0]?.invoke({}, call)).toEqual({ ok: true, message: "pong" });
    expect(modules.report()).toEqual([
      expect.objectContaining({ id: "crashy", state: "failed", code: "CRASHY_WORKER_CRASHED" }),
      expect.objectContaining({ id: "steady", state: "ready", status: "idle" }),
    ]);
    expect(codes).toContain("CRASHY_WORKER_CRASHED");
    expect(await modules.stop()).toEqual({ incomplete: [] });
  });

  it("keeps the application replying and the proactive scheduler firing while a module is failed", async () => {
    // The service composes these three side by side (src/service.ts); here they share one process the same way.
    const crashy = crashingModule();
    const modules = host([crashy, steadyModule()]);
    await modules.start();
    crashy.crash();
    await until(() => modules.health("crashy")?.state === "failed");

    const f = fixture();
    const scheduler = createProactiveScheduler({
      store: f.store,
      quietHours: { start: "00:00", end: "00:00", timezone: "UTC" },
      onDue: (item) => f.app.triggerProactive(item),
      pollIntervalMs: 10,
    });
    try {
      await f.app.start(f.store.recover());
      await f.app.handle(f.message("Як справи?"));
      await until(() => f.commands.some((command) => command.kind === "send"));
      const reply = f.commands.find((command) => command.kind === "send");
      if (!reply || reply.kind !== "send") throw new Error("EXPECTED_SEND_COMMAND");
      f.emit({ ...reply.identity, kind: "completed", text: "Усе добре." });
      await f.app.drain();
      expect(f.delivered.map((item) => item.payload)).toContainEqual({ kind: "text", text: "Усе добре." });

      const now = Date.now();
      const item = f.store.proactivity.create(scope, {
        agentId: "synthetic-agent", kind: "oneoff", schedule: { type: "once", at: now },
        purpose: "Нагадати про синтетичну задачу", initiator: "oleh", nextDueAt: now, now,
      });
      scheduler.start();
      await until(() => f.commands.filter((command) => command.kind === "send").length === 2);
      const proactive = f.commands.filter((command) => command.kind === "send").at(-1);
      if (!proactive || proactive.kind !== "send") throw new Error("EXPECTED_PROACTIVE_SEND");
      expect(proactive.input.text).toContain("Нагадати про синтетичну задачу");
      f.emit({ ...proactive.identity, kind: "completed", text: "Нагадую про задачу." });
      await f.app.drain();
      expect(f.delivered.map((entry) => entry.payload)).toContainEqual({ kind: "text", text: "Нагадую про задачу." });
      expect(f.store.proactivity.get(scope, item.id)?.status).toBe("done");

      expect(modules.health("crashy")?.state).toBe("failed");
      expect(modules.health("steady")?.state).toBe("ready");
    } finally {
      scheduler.stop();
      await f.close();
      await modules.stop();
    }
  });
});
