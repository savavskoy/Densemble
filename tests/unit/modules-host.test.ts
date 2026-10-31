import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModuleError, type AbilityCall, type ModuleEntry, type ModuleHealth } from "../../src/modules/contract.js";
import { createModuleHost, type ModuleHostOptions } from "../../src/modules/host.js";
import { loadModule, type ModuleLoader } from "../../src/modules/loader.js";
import type { DiagnosticSink } from "../../src/ports.js";
import { entry, fakeCore, fakeLoader, fakeModule } from "../fixtures/modules/index.js";

let runtime: string;
let codes: string[];
const diagnostics: DiagnosticSink = { record: (code) => { codes.push(code); } };

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "densemble-modules-"));
  codes = [];
});
afterEach(() => { rmSync(runtime, { recursive: true, force: true }); });

function host(entries: ModuleEntry[], loader: ModuleLoader, overrides: Partial<ModuleHostOptions> = {}) {
  return createModuleHost({
    entries, loader, core: fakeCore(), runtimeDataPath: runtime, diagnostics,
    readInstructions: async () => "# instructions", ...overrides,
  });
}
const state = (health: ModuleHealth | undefined) => health && { state: health.state, code: health.code, detail: health.detail };
const call: AbilityCall = {
  scope: { ownerId: 1, botId: "bot", chatId: 1, topicId: null }, agentId: "alfred", userId: 1, owner: true,
  workspace: "/workspace", signal: new AbortController().signal,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("module host", () => {
  it("never loads, prepares or starts a disabled module", async () => {
    let prepared = false;
    const loader = fakeLoader([fakeModule("off", { prepare: (settings) => { prepared = true; return { ok: true, settings }; } })]);
    const modules = host([entry("off", { enabled: false })], loader);
    await modules.start();
    expect(loader.loaded).toEqual([]);
    expect(prepared).toBe(false);
    expect(state(modules.health("off"))).toEqual({ state: "disabled", code: "MODULE_DISABLED", detail: undefined });
    expect(modules.report()[0]).toMatchObject({ id: "off", enabled: false, state: "disabled",
      cause: "Модуль вимкнено в config.local.json.", fix: "Увімкніть modules.off.enabled і виконайте make restart." });
  });

  it("marks an unknown id unavailable, also when the definition id does not match", async () => {
    const modules = host([entry("ghost"), entry("other")],
      async (id) => id === "other" ? fakeModule("renamed") : undefined);
    await modules.start();
    expect(modules.health("ghost")?.code).toBe("MODULE_UNKNOWN");
    expect(state(modules.health("other"))).toMatchObject({ state: "unavailable", code: "MODULE_UNKNOWN" });
  });

  it("isolates invalid settings or a prepare code to one module and keeps values out of diagnostics", async () => {
    const strict = fakeModule("strict", { settings: z.object({ token: z.string() }) });
    const paths = fakeModule("paths", { prepare: () => ({ ok: false, code: "PATHS_OUTSIDE_WORKSPACE" }),
      reasons: { PATHS_OUTSIDE_WORKSPACE: { cause: "Папка поза робочим простором.", fix: "Виправте шлях." } } });
    const throwing = fakeModule("throwing", { prepare: () => { throw Object.assign(new Error("secret /path"), { code: "UNSAFE_PATH_OVERLAP" }); } });
    const fine = fakeModule("fine");
    const modules = host([entry("strict", { settings: { token: 42 } }), entry("paths"), entry("throwing"), entry("fine")],
      fakeLoader([strict, paths, throwing, fine]));
    await modules.start();
    expect(state(modules.health("strict"))).toMatchObject({ state: "unavailable", code: "MODULE_SETTINGS_INVALID" });
    expect(modules.health("paths")?.code).toBe("PATHS_OUTSIDE_WORKSPACE");
    expect(modules.health("throwing")?.code).toBe("UNSAFE_PATH_OVERLAP");
    expect(modules.health("fine")?.state).toBe("ready");
    expect(modules.report().find((row) => row.id === "paths")).toMatchObject({ cause: "Папка поза робочим простором.", fix: "Виправте шлях." });
    expect(codes.join(" ")).not.toMatch(/42|secret|path/);
  });

  it("passes parsed, prepared settings and a private data folder to start", async () => {
    let seen: unknown;
    let dataPath = "";
    const typed = fakeModule("typed", {
      settings: z.object({ count: z.number().default(3) }),
      prepare: (settings) => ({ ok: true, settings: { count: settings.count * 2 } }),
      start: async (ctx) => { seen = ctx.settings; dataPath = ctx.dataPath; return { stop: async () => undefined }; },
    });
    const modules = host([entry("typed", { settings: {} })], fakeLoader([typed]));
    await modules.start();
    expect(seen).toEqual({ count: 6 });
    expect(dataPath).toBe(join(runtime, "modules", "typed"));
    expect(statSync(dataPath).mode & 0o777).toBe(0o700);
  });

  it("starts a dependency chain in order and offers the dependency's API through require()", async () => {
    const order: string[] = [];
    const a = fakeModule<unknown, { greet(): string }>("a", {
      start: async () => { order.push("a"); return { provides: { greet: () => "hi" }, stop: async () => undefined }; } });
    let greeting = "";
    const b = fakeModule("b", { requires: ["a"], start: async (ctx) => {
      order.push("b");
      greeting = ctx.require<{ greet(): string }>("a").greet();
      expect(() => ctx.require("c")).toThrow(ModuleError);
      return { stop: async () => undefined };
    } });
    const c = fakeModule("c", { requires: ["b"], start: async () => { order.push("c"); return { stop: async () => undefined }; } });
    const modules = host([entry("c"), entry("b"), entry("a")], fakeLoader([a, b, c]));
    await modules.start();
    expect(order).toEqual(["a", "b", "c"]);
    expect(greeting).toBe("hi");
    expect(modules.report().find((row) => row.id === "c")).toMatchObject({ state: "ready", requires: ["b"] });
  });

  it("keeps a module with a missing, disabled or failed dependency unavailable and names the dependency", async () => {
    const broken = fakeModule("broken", { start: async () => { throw new Error("boom"); } });
    const modules = host([entry("needs-missing"), entry("needs-off"), entry("off", { enabled: false }), entry("broken"), entry("needs-broken")],
      fakeLoader([fakeModule("needs-missing", { requires: ["missing"] }), fakeModule("needs-off", { requires: ["off"] }),
        fakeModule("off"), broken, fakeModule("needs-broken", { requires: ["broken"] })]));
    await modules.start();
    expect(state(modules.health("needs-missing"))).toEqual({ state: "unavailable", code: "MODULE_DEPENDENCY_UNAVAILABLE", detail: "missing" });
    expect(modules.health("needs-off")?.detail).toBe("off");
    expect(state(modules.health("broken"))).toMatchObject({ state: "failed", code: "MODULE_START_FAILED" });
    expect(state(modules.health("needs-broken"))).toEqual({ state: "unavailable", code: "MODULE_DEPENDENCY_UNAVAILABLE", detail: "broken" });
    expect(modules.report().find((row) => row.id === "needs-off")?.cause).toContain("«off»");
  });

  it("marks every module in a cycle unavailable and their dependents too", async () => {
    let started = false;
    const start = async () => { started = true; return { stop: async () => undefined }; };
    const modules = host([entry("x"), entry("y"), entry("z"), entry("self"), entry("after")], fakeLoader([
      fakeModule("x", { requires: ["y"], start }), fakeModule("y", { requires: ["z"], start }), fakeModule("z", { requires: ["x"], start }),
      fakeModule("self", { requires: ["self"], start }), fakeModule("after", { requires: ["x"], start })]));
    await modules.start();
    for (const id of ["x", "y", "z", "self"]) expect(modules.health(id)?.code).toBe("MODULE_DEPENDENCY_CYCLE");
    expect(state(modules.health("after"))).toEqual({ state: "unavailable", code: "MODULE_DEPENDENCY_UNAVAILABLE", detail: "x" });
    expect(started).toBe(false);
  });

  it("rejects duplicate and badly named abilities; declared names come from resolved modules only", async () => {
    const input = z.object({});
    const ability = (name: string) => ({ name, description: "d", input });
    const modules = host([entry("one"), entry("two"), entry("core"), entry("bad"), entry("good")], fakeLoader([
      fakeModule("one", { abilities: [ability("one_status")] }),
      fakeModule("two", { abilities: [ability("one_status")] }),
      fakeModule("core", { abilities: [ability("densemble_state")] }),
      fakeModule("bad", { abilities: [ability("status")] }),
      fakeModule("good", { abilities: [ability("good_status"), ability("good_list")] }),
    ]));
    await modules.resolve();
    expect(modules.health("one")?.code).toBe("MODULE_ABILITY_DUPLICATE");
    expect(modules.health("two")?.code).toBe("MODULE_ABILITY_DUPLICATE");
    expect(modules.health("core")?.code).toBe("MODULE_ABILITY_DUPLICATE");
    expect(modules.health("bad")?.code).toBe("MODULE_ABILITY_INVALID");
    expect(modules.declaredAbilityNames()).toEqual(["good_status", "good_list"]);
  });

  it("requires instructions for a module with abilities", async () => {
    const modules = host([entry("talky")], fakeLoader([fakeModule("talky",
      { abilities: [{ name: "talky_hello", description: "d", input: z.object({}) }] })]), { readInstructions: async () => undefined });
    await modules.start();
    expect(modules.health("talky")?.code).toBe("MODULE_INSTRUCTIONS_MISSING");
  });

  it("maps start errors to failed, or unavailable for a missing prerequisite", async () => {
    const modules = host([entry("coded"), entry("prereq"), entry("bad-instance")], fakeLoader([
      fakeModule("coded", { start: async () => { throw new ModuleError("CODED_START_FAILED"); } }),
      fakeModule("prereq", { start: async () => { throw new ModuleError("PREREQ_MODEL_MISSING", { unavailable: true }); } }),
      fakeModule("bad-instance", { start: async () => ({}) as never }),
    ]));
    await expect(modules.start()).resolves.toBeUndefined();
    expect(state(modules.health("coded"))).toMatchObject({ state: "failed", code: "CODED_START_FAILED" });
    expect(state(modules.health("prereq"))).toMatchObject({ state: "unavailable", code: "PREREQ_MODEL_MISSING" });
    expect(state(modules.health("bad-instance"))).toMatchObject({ state: "failed", code: "MODULE_START_FAILED" });
  });

  it("still reports a module whose definition lacks reasons (report() is used at every session open)", async () => {
    const modules = host([entry("no-reasons")], fakeLoader([
      fakeModule("no-reasons", { reasons: undefined as never, start: async () => { throw new ModuleError("NO_REASONS_BROKEN"); } }),
    ]));
    await modules.start();
    expect(modules.report()).toEqual([expect.objectContaining({ id: "no-reasons", state: "failed", code: "NO_REASONS_BROKEN",
      cause: expect.any(String), fix: expect.any(String) })]);
  });

  it("marks a module failed when ctx.run rejects while others stay ready, and takes dependents down", async () => {
    let reject!: (error: unknown) => void;
    const worker = fakeModule("worker", { start: async (ctx) => {
      ctx.run(() => new Promise((_resolve, fail) => { reject = fail; }));
      return { stop: async () => undefined };
    } });
    const modules = host([entry("worker"), entry("calm"), entry("child")],
      fakeLoader([worker, fakeModule("calm"), fakeModule("child", { requires: ["worker"] })]));
    await modules.start();
    expect(modules.health("worker")?.state).toBe("ready");
    expect(modules.health("child")?.state).toBe("ready");
    reject(new Error("crash"));
    await tick();
    expect(state(modules.health("worker"))).toMatchObject({ state: "failed", code: "MODULE_FAILED" });
    expect(modules.health("calm")?.state).toBe("ready");
    expect(state(modules.health("child"))).toEqual({ state: "unavailable", code: "MODULE_DEPENDENCY_UNAVAILABLE", detail: "worker" });
  });

  it("reports ctx.fail and ctx.recovered transitions to listeners and the status line", async () => {
    let fail!: (code: string) => void;
    let recovered!: () => void;
    const watcher = fakeModule("watcher", {
      reasons: { WATCHER_FOLDER_UNREADABLE: { cause: "Папка недоступна.", fix: "Перевірте права." } },
      start: async (ctx) => { fail = ctx.fail; recovered = ctx.recovered; return { status: () => " 3 у черзі ", stop: async () => undefined }; },
    });
    const modules = host([entry("watcher")], fakeLoader([watcher]));
    const seen: string[] = [];
    modules.onChange((id, health) => seen.push(`${id}:${health.state}:${health.code}`));
    await modules.start();
    fail("WATCHER_FOLDER_UNREADABLE");
    fail("WATCHER_FOLDER_UNREADABLE");
    expect(modules.report()[0]).toMatchObject({ state: "failed", cause: "Папка недоступна.", fix: "Перевірте права.", status: "3 у черзі" });
    recovered();
    fail("not a code");
    expect(seen).toEqual(["watcher:ready:MODULE_READY", "watcher:failed:WATCHER_FOLDER_UNREADABLE",
      "watcher:ready:MODULE_READY", "watcher:failed:MODULE_FAILED"]);
  });

  it("offers abilities of ready modules only and never lets an invoke error escape", async () => {
    const input = z.object({ name: z.string() });
    const echo = fakeModule("echo", {
      abilities: [{ name: "echo_say", description: "d", input, readOnly: true }, { name: "echo_crash", description: "d", input }],
      start: async () => ({
        invoke: async (name: string, args: unknown) => {
          if (name === "echo_crash") throw new Error("crash");
          return { ok: true as const, message: (args as { name: string }).name };
        },
        stop: async () => undefined,
      }),
    });
    const modules = host([entry("echo"), entry("off", { enabled: false })], fakeLoader([echo, fakeModule("off")]));
    await modules.start();
    const abilities = modules.abilities();
    expect(abilities.map((ability) => `${ability.moduleId}/${ability.spec.name}`)).toEqual(["echo/echo_say", "echo/echo_crash"]);
    expect(await abilities[0]!.invoke({ name: "Oleh" }, call)).toEqual({ ok: true, message: "Oleh" });
    expect(await abilities[0]!.invoke({ name: 1 }, call)).toMatchObject({ ok: false, code: "MODULE_INPUT_INVALID" });
    expect(await abilities[1]!.invoke({ name: "x" }, call)).toMatchObject({ ok: false, code: "MODULE_FAILED" });
    expect(modules.get("echo")?.instructions).toBe("# instructions");
  });

  it("stops in reverse start order, aborts signals and bounds a hanging stop", async () => {
    const order: string[] = [];
    const signals: AbortSignal[] = [];
    const make = (id: string, requires: string[], stop: () => Promise<void>) => fakeModule(id, { requires,
      start: async (ctx) => { signals.push(ctx.signal); return { stop: async () => { order.push(id); await stop(); } }; } });
    const modules = host([entry("top"), entry("mid"), entry("base")], fakeLoader([
      make("base", [], async () => undefined),
      make("mid", ["base"], () => new Promise<void>(() => undefined)),
      make("top", ["mid"], async () => { throw new Error("stop failed"); }),
    ]), { stopTimeoutMs: 20 });
    await modules.start();
    const result = await modules.stop();
    expect(order).toEqual(["top", "mid", "base"]);
    expect(result.incomplete).toEqual(["top", "mid"]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(codes).toEqual(expect.arrayContaining(["MODULE_STOP_FAILED", "MODULE_STOP_TIMEOUT"]));
    await expect(modules.stop()).resolves.toBe(result);
  });
});

describe("module loader", () => {
  it("returns nothing for an invalid or missing module folder", async () => {
    expect(await loadModule("../config")).toBeUndefined();
    expect(await loadModule("Bad")).toBeUndefined();
    expect(await loadModule("no-such-module")).toBeUndefined();
  });
});
