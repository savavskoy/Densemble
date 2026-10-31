import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AbilityCall, ModuleDefinition, ModuleEntry } from "../../src/modules/contract.js";
import { createModuleHost } from "../../src/modules/host.js";
import { entry, fakeCore, fakeLoader, fakeModule } from "../fixtures/modules/index.js";

/** What module "a" would publish in `src/modules/a/api.ts`: the only thing "b" knows about "a". */
interface CounterApi {
  greet(name: string): string;
  count(): number;
}

/** First implementation of "a": an array of names it has greeted. */
function counterV1(): ModuleDefinition<unknown, CounterApi> {
  return fakeModule<unknown, CounterApi>("a", {
    start: async () => {
      const seen: string[] = [];
      return {
        provides: { greet: (name) => { seen.push(name); return `Hello, ${name}`; }, count: () => seen.length },
        stop: async () => undefined,
      };
    },
  });
}

/** Rewritten internals of "a" behind the same API: a Map of counters, a template, its own version. */
function counterV2(): ModuleDefinition<unknown, CounterApi> {
  return fakeModule<unknown, CounterApi>("a", {
    version: "2.0.0",
    settings: z.object({ prefix: z.string().default("Hello") }),
    start: async (ctx) => {
      const counts = new Map<string, number>();
      const { prefix } = ctx.settings as { prefix: string };
      return {
        provides: {
          greet(name) { counts.set(name, (counts.get(name) ?? 0) + 1); return [prefix, name].join(", "); },
          count: () => [...counts.values()].reduce((total, value) => total + value, 0),
        },
        stop: async () => { counts.clear(); },
      };
    },
  });
}

/** "b" requires "a" and uses it only through `ctx.require<CounterApi>("a")`. */
function greeterB(): ModuleDefinition {
  return fakeModule("b", {
    requires: ["a"],
    abilities: [{ name: "b_welcome", description: "Welcome someone.", input: z.object({ name: z.string() }), readOnly: true }],
    start: async (ctx) => {
      const counter = ctx.require<CounterApi>("a");
      return {
        status: () => `${counter.count()} welcomed`,
        invoke: async (_name, args) => ({ ok: true, message: `${counter.greet((args as { name: string }).name)}!` }),
        stop: async () => undefined,
      };
    },
  });
}

let runtime: string;
beforeEach(() => { runtime = mkdtempSync(join(tmpdir(), "densemble-modules-deps-")); });
afterEach(() => { rmSync(runtime, { recursive: true, force: true }); });

const call: AbilityCall = {
  scope: { ownerId: 1, botId: "bot", chatId: 1, topicId: null }, agentId: "alfred", userId: 1, owner: true,
  workspace: "/workspace", signal: new AbortController().signal,
};

function host(entries: ModuleEntry[], definitions: ModuleDefinition[]) {
  return createModuleHost({
    entries, loader: fakeLoader(definitions), core: fakeCore(), runtimeDataPath: runtime,
    diagnostics: { record: () => undefined }, readInstructions: async () => "# instructions",
  });
}

async function welcome(modules: ReturnType<typeof host>, name: string) {
  const ability = modules.abilities().find((candidate) => candidate.spec.name === "b_welcome");
  if (!ability) throw new Error("ABILITY_MISSING");
  return ability.invoke({ name }, call);
}

describe("module dependencies (US5)", () => {
  it("lets b use a's API through ctx.require, whichever implementation a has", async () => {
    for (const a of [counterV1(), counterV2()]) {
      const modules = host([entry("b"), entry("a", { settings: {} })], [a, greeterB()]);
      await modules.start();
      expect(modules.health("a")?.state).toBe("ready");
      expect(modules.health("b")?.state).toBe("ready");
      expect(await welcome(modules, "Oleh")).toEqual({ ok: true, message: "Hello, Oleh!" });
      expect(await welcome(modules, "Alfred")).toEqual({ ok: true, message: "Hello, Alfred!" });
      expect(modules.report().find((row) => row.id === "b")).toMatchObject({ requires: ["a"], status: "2 welcomed" });
      expect(await modules.stop()).toEqual({ incomplete: [] });
    }
  });

  it("refuses ctx.require of a module that is not listed in requires", async () => {
    const sneaky = fakeModule("c", {
      start: async (ctx) => { ctx.require("a"); return { stop: async () => undefined }; },
    });
    const modules = host([entry("a"), entry("c")], [counterV1(), sneaky]);
    await modules.start();
    expect(modules.health("a")?.state).toBe("ready");
    expect(modules.health("c")).toMatchObject({ state: "failed", code: "MODULE_DEPENDENCY_UNAVAILABLE" });
  });

  it("keeps b unavailable with the reason when a is disabled or not configured", async () => {
    let started = false;
    const b = fakeModule("b", { requires: ["a"], start: async () => { started = true; return { stop: async () => undefined }; } });
    for (const entries of [[entry("a", { enabled: false }), entry("b")], [entry("b")]]) {
      const modules = host(entries, [counterV1(), b]);
      await modules.start();
      expect(modules.health("b")).toMatchObject({ state: "unavailable", code: "MODULE_DEPENDENCY_UNAVAILABLE", detail: "a" });
      const row = modules.report().find((candidate) => candidate.id === "b");
      expect(row).toMatchObject({ state: "unavailable", code: "MODULE_DEPENDENCY_UNAVAILABLE", detail: "a", requires: ["a"] });
      expect(row?.cause).toContain("«a»");
      expect(row?.fix).toContain("modules.a");
      expect(row?.fix).toContain("make restart");
      expect(modules.abilities()).toEqual([]);
      await modules.stop();
    }
    expect(started).toBe(false);
  });
});
