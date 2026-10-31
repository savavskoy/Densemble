import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleEntries } from "../../src/config/index.js";
import { createModuleHost } from "../../src/modules/host.js";
import { loadModule } from "../../src/modules/loader.js";
import { fakeCore } from "../fixtures/modules/index.js";
import { fixtureFolderLoader, fixtureInstructions } from "../fixtures/modules/folder-loader.js";

const root = resolve(import.meta.dirname, "../..");
const src = join(root, "src");
const modulesRoot = join(src, "modules");
const dependencies = Object.keys((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as
  { dependencies?: Record<string, string> }).dependencies ?? {});

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const sources = (directory: string) => files(directory).filter((path) => /\.(?:ts|mts|js|mjs)$/.test(path));

/** Every import/export specifier, including type-only and dynamic imports; a non-literal dynamic import is `<dynamic>`. */
function specifiers(path: string): string[] {
  const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)) found.push(match[1]!);
  for (const match of text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(match[1]!);
  for (const match of text.matchAll(/\bimport\(\s*([^)]*)\)/g)) {
    const literal = /^["']([^"']+)["']$/.exec(match[1]!.trim());
    found.push(literal ? literal[1]! : "<dynamic>");
  }
  return found;
}

/** `.js` in a specifier is the `.ts` source under vitest/tsc. */
function target(from: string, specifier: string): string {
  return resolve(dirname(from), specifier).replace(/\.js$/, ".ts");
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

const moduleIds = readdirSync(modulesRoot).filter((name) => statSync(join(modulesRoot, name)).isDirectory());
const rel = (path: string) => relative(root, path).split(sep).join("/");

describe("module import boundary (FR-012)", () => {
  it("finds the module folders", () => {
    expect(moduleIds).toContain("recordings");
  });

  it.each(moduleIds)("%s imports only built-ins, dependencies, its own folder, core-api and required APIs", async (id) => {
    const folder = join(modulesRoot, id);
    const definition = await loadModule(id);
    expect(definition, `src/modules/${id}/index.ts must export a valid \`module\``).toBeDefined();
    const requires = new Set(definition?.requires ?? []);
    const allowed = (from: string, specifier: string): boolean => {
      if (specifier.startsWith("node:")) return true;
      if (!specifier.startsWith(".")) return dependencies.includes(packageName(specifier));
      const path = target(from, specifier);
      if (path.startsWith(`${folder}${sep}`)) return true;
      if (path === join(modulesRoot, "core-api.ts")) return true;
      const api = /^([a-z][a-z0-9-]*)[/\\]api\.ts$/.exec(relative(modulesRoot, path));
      return api !== null && requires.has(api[1]!);
    };
    const violations = sources(folder).flatMap((file) =>
      specifiers(file).filter((specifier) => !allowed(file, specifier)).map((specifier) => `${rel(file)} → ${specifier}`));
    expect(violations).toEqual([]);
  });

  it.each(moduleIds)("%s has owner docs (README.md)", (id) => {
    expect(statSync(join(modulesRoot, id, "README.md")).isFile()).toBe(true);
  });

  /**
   * Core may reach a module only through its public `src/modules/<id>/api.ts` (e.g. `recordings-status`, the
   * spec 004 CLI, reads the snapshot with the module's own formatter); never through its internals.
   */
  it("keeps core code off module internals (only src/modules/<id>/api.ts)", () => {
    const moduleFolders = moduleIds.map((id) => join(modulesRoot, id));
    const core = sources(src).filter((file) => !moduleFolders.some((folder) => file.startsWith(`${folder}${sep}`)));
    const violations = core.flatMap((file) => specifiers(file)
      .filter((specifier) => {
        if (!specifier.startsWith(".")) return false;
        const path = target(file, specifier);
        return moduleFolders.some((folder) => path.startsWith(`${folder}${sep}`) && path !== join(folder, "api.ts"));
      })
      .map((specifier) => `${rel(file)} → ${specifier}`));
    expect(violations).toEqual([]);
  });

  it("recordings-status reads the snapshot through the recordings public API", () => {
    expect(specifiers(join(src, "main.ts"))).toContain("./modules/recordings/api.js");
  });
});

describe("a new module needs no core change (US8, SC-003)", () => {
  let runtime: string;
  beforeEach(() => { runtime = mkdtempSync(join(tmpdir(), "densemble-modules-boundary-")); });
  afterEach(() => { rmSync(runtime, { recursive: true, force: true }); });

  it("enables the greeter folder module from a config entry alone", async () => {
    // No source file names the fixture module: the folder plus `modules.greeter` is all there is.
    expect(sources(src).filter((file) => readFileSync(file, "utf8").includes("greeter")).map(rel)).toEqual([]);

    const entries = moduleEntries({ modules: { greeter: { agents: ["alfred"], settings: { greeting: "Привіт" } } } });
    const modules = createModuleHost({
      entries, loader: fixtureFolderLoader, core: fakeCore(), runtimeDataPath: runtime,
      diagnostics: { record: () => undefined }, readInstructions: fixtureInstructions,
    });
    await modules.start();
    expect(modules.report()).toEqual([expect.objectContaining({
      id: "greeter", version: "0.1.0", state: "ready", code: "MODULE_READY", agents: ["alfred"], status: "greeting: Привіт",
    })]);
    expect(modules.get("greeter")?.instructions).toContain("## greeter_greet");
    const greet = modules.abilities().find((ability) => ability.spec.name === "greeter_greet");
    expect(await greet?.invoke({ name: "Oleh" }, {
      scope: { ownerId: 1, botId: "bot", chatId: 1, topicId: null }, agentId: "alfred", userId: 1, owner: true,
      workspace: "/workspace", signal: new AbortController().signal,
    })).toEqual({ ok: true, message: "Привіт, Oleh!" });
    await modules.stop();

    const off = createModuleHost({
      entries: moduleEntries({ modules: { greeter: { enabled: false } } }), loader: fixtureFolderLoader, core: fakeCore(),
      runtimeDataPath: runtime, diagnostics: { record: () => undefined }, readInstructions: fixtureInstructions,
    });
    await off.start();
    expect(off.health("greeter")?.state).toBe("disabled");
  });

  it("uses the production folder convention: the loader finds a module by its folder name", async () => {
    expect((await loadModule("recordings"))?.id).toBe("recordings");
    expect((await fixtureFolderLoader("greeter"))?.id).toBe("greeter");
    expect(await fixtureFolderLoader("missing")).toBeUndefined();
  });
});
