import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeScope, ConfigError, loadConfig, secretResolver, type ServiceConfig } from "../../src/config/index.js";

let root: string;
let source: string;
let code: string;
let configPath: string;
let config: ServiceConfig;
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function launcher(id: string): string { return join(source, ".github/agents", `${id}.agent.md`); }
function load() {
  write(configPath, JSON.stringify(config));
  return loadConfig(configPath, { codeRoot: code });
}
beforeEach(() => {
  root = resolve(".cache", `config-unit-${randomUUID()}`);
  source = join(root, "workspace");
  code = join(root, "code");
  configPath = join(code, "config.local.json");
  for (const directory of [source, code, join(code, "data"), join(code, "runtime/copilot"), join(root, "interactive"), join(source, "agent/skills")]) {
    mkdirSync(directory, { recursive: true });
  }
  write(join(source, "AGENTS.md"), "# Synthetic instructions");
  write(join(source, "agent/skills/example/SKILL.md"), "# Synthetic skill");
  for (const id of ["helper-one", "helper-two", "helper-three", "helper-four", "helper-five"]) {
    write(join(source, "agent/agents", id, "AGENT.md"), `---\nname: ${id}\ndescription: Synthetic persona\n---\n# Instructions\n[skill](../../skills/example/SKILL.md)`);
    write(launcher(id), `---\nname: ${id}\ndescription: Synthetic persona\nmodel: synthetic-model\n---\nRead and follow \`agent/agents/${id}/AGENT.md\` (after \`AGENTS.md\`).`);
  }
  write(join(source, "agent/subagents/worker.md"), "---\nname: worker\ndescription: Synthetic worker\n---\n# Worker");
  write(launcher("worker"), "---\nname: worker\ndescription: Synthetic worker\nmodel: synthetic-worker-model\nuser-invocable: false\n---\nRead and follow `agent/subagents/worker.md`.");
  write(join(source, "secrets.local.json"), JSON.stringify({
    telegram: { one: "1001:synthetic-one", two: "1002:synthetic-two" }, mcp: { key: "synthetic-secret-must-not-leak" },
  }));
  config = {
    workspacePath: source, agentDefinitionsPath: join(source, "agent/agents"),
    agentLaunchersPath: join(source, ".github/agents"), secretsPath: join(source, "secrets.local.json"),
    runtimeDataPath: "./data", runtimeHomePath: "./runtime/copilot", interactiveHomePath: join(root, "interactive"),
    ownerId: 101, skillDirectories: [join(source, "agent/skills")],
    bots: [
      { id: "bot-one", agentId: "helper-one", tokenRef: "telegram.one" },
      { id: "bot-two", agentId: "helper-two", tokenRef: "telegram.two" },
    ],
    bindings: [
      { botId: "bot-one", chatId: 101, topicId: null, kind: "private" },
      { botId: "bot-two", chatId: 101, topicId: null, kind: "private" },
      { botId: "bot-one", chatId: -201, topicId: null, kind: "group" },
      { botId: "bot-one", chatId: -202, topicId: 1, kind: "forum" },
      { botId: "bot-two", chatId: -202, topicId: 2, kind: "forum" },
    ],
    mcp: { mode: "none" },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("private configuration and discovery", () => {
  it("resolves optional audio paths without installing tools or requiring a model for text", () => {
    config.audio = { modelPath: "../models/ggml-small.bin", ffmpegPath: "ffmpeg",
      whisperPath: "./tools/whisper-cli", language: "uk", threads: 4 };
    expect(load().config.audio).toMatchObject({
      modelPath: join(root, "models/ggml-small.bin"), ffmpegPath: "ffmpeg",
      whisperPath: join(code, "tools/whisper-cli"), language: "uk", threads: 4,
    });
    config.audio.threads = 9;
    expect(load).toThrow("CONFIG_SCHEMA_INVALID");
  });
  it("discovers all personas and workers with references, launcher-only models and explicit skills", () => {
    const result = load();
    expect(result.agents).toHaveLength(6);
    expect(result.agents.filter((agent) => agent.userInvocable)).toHaveLength(5);
    expect(result.agents.find((agent) => agent.id === "worker")).toMatchObject({
      userInvocable: false, defaultModel: "synthetic-worker-model", canonicalPath: join(source, "agent/subagents/worker.md"),
    });
    expect(result.agents.find((agent) => agent.id === "worker")).not.toHaveProperty("infer");
    expect(result.config.runtimeHomePath).toBe(join(code, "runtime/copilot"));
    expect(result.tokenForBot("bot-one")).toBe("1001:synthetic-one");
    expect(JSON.stringify(result)).not.toContain("synthetic-one");
    expect(JSON.stringify(result.agents)).not.toContain("# Instructions");
  });
  it("parses YAML block scalars, quoted values, CRLF, and independent infer correctly", () => {
    write(launcher("worker"), '---\r\nname: worker\r\ndescription: >-\r\n  Synthetic: worker\r\n  description\r\nmodel: "synthetic:version"\r\nuser-invocable: false\r\ninfer: true\r\n---\r\nRead and follow `agent/subagents/worker.md`.');
    expect(load().agents.find((agent) => agent.id === "worker")).toMatchObject({
      description: "Synthetic: worker description", defaultModel: "synthetic:version", infer: true, userInvocable: false,
    });
  });
  it.each([
    ["duplicate YAML", "---\nname: helper-one\nname: helper-one\ndescription: Example\nmodel: test\n---"],
    ["missing model", "---\nname: helper-one\ndescription: Example\n---"],
    ["wrong scalar", "---\nname: helper-one\ndescription: Example\nmodel: test\nuser-invocable: nope\n---"],
    ["broken YAML", "---\nname: [broken\n---"],
    ["missing fence", "name: helper-one\nmodel: test"],
    ["unknown metadata", "---\nname: helper-one\ndescription: Example\nmodel: test\nhidden: fallback\n---"],
  ])("rejects %s without hidden fallback", (_label, text) => {
    write(launcher("helper-one"), text);
    expect(load).toThrow(ConfigError);
  });
  it("rejects missing canonical files and missing launchers", () => {
    rmSync(join(source, "agent/agents/helper-one/AGENT.md"));
    expect(load).toThrow("PATH_MISSING_OR_UNREADABLE");
    write(join(source, "agent/agents/helper-one/AGENT.md"), "# Restored");
    rmSync(launcher("helper-one"));
    expect(load).toThrow("CANONICAL_WITHOUT_LAUNCHER");
  });
  it("rejects escaping canonical references and links", () => {
    write(launcher("worker"), "---\nname: worker\ndescription: Example\nmodel: test\nuser-invocable: false\n---\nRead `agent/subagents/../../../outside.md`.");
    write(join(root, "outside.md"), "# Outside");
    expect(load).toThrow("SOURCE_OUTSIDE_WORKSPACE");
  });
  it("checks canonical Markdown links and rejects symlink source files", () => {
    write(join(source, "agent/agents/helper-one/AGENT.md"), "[missing](../../skills/missing/SKILL.md)");
    expect(load).toThrow("SOURCE_LINK_INVALID");
    rmSync(join(source, "agent/agents/helper-one/AGENT.md"));
    symlinkSync(join(source, "AGENTS.md"), join(source, "agent/agents/helper-one/AGENT.md"));
    expect(load).toThrow("SYMLINK_PATH_REJECTED");
  });
  it("rejects worker and unknown bot bindings but keeps workers registered", () => {
    config.bots[0]!.agentId = "worker";
    expect(load).toThrow("BOT_AGENT_NOT_INVOCABLE");
    config.bots[0]!.agentId = "missing";
    expect(load).toThrow("BOT_AGENT_NOT_INVOCABLE");
  });
  it("does not permit tokens, prototype references, or values into errors", () => {
    for (const reference of ["__proto__.token", "constructor.token", "telegram.__proto__", "missing.token"]) {
      config.bots[0]!.tokenRef = reference;
      try { load(); throw new Error("should fail"); }
      catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(String(error)).not.toContain(reference);
        expect(String(error)).not.toContain("synthetic-one");
      }
    }
    expect(() => secretResolver(Object.create({ secret: "synthetic-value" }))("secret")).toThrow("SECRET_REFERENCE_UNRESOLVED");
  });
  it("rejects duplicate resolved token identities even when references or suffixes differ", () => {
    config.bots[1]!.tokenRef = "telegram.one";
    expect(load).toThrow("DUPLICATE_BOT_TOKEN");
    config.bots[1]!.tokenRef = "telegram.two";
    write(join(source, "secrets.local.json"), '{"telegram":{"one":"1001:synthetic-one","two":"001001:rotated"}}');
    expect(load).toThrow("DUPLICATE_BOT_TOKEN");
  });
  it.each(["", "  ", "not-a-token", "1001:with spaces"])("rejects invalid resolved bot token %j safely", (token) => {
    write(join(source, "secrets.local.json"), JSON.stringify({ telegram: { one: token, two: "1002:synthetic-two" } }));
    expect(load).toThrow(ConfigError);
  });
  it("rejects unsafe ID values", () => {
    for (const owner of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      config.ownerId = owner;
      expect(load).toThrow("CONFIG_SCHEMA_INVALID");
    }
  });
  it("rejects overlapping managed roots, source code workspace and symlink managed paths", () => {
    config.runtimeDataPath = source;
    expect(load).toThrow("UNSAFE_PATH_OVERLAP");
    config.runtimeDataPath = join(root, "interactive");
    expect(load).toThrow("UNSAFE_PATH_OVERLAP");
    config.runtimeDataPath = config.runtimeHomePath;
    expect(load).toThrow("UNSAFE_PATH_OVERLAP");
    config.runtimeDataPath = "./data-link";
    symlinkSync(join(code, "data"), join(code, "data-link"));
    expect(load).toThrow("SYMLINK_PATH_REJECTED");
    config.workspacePath = code;
    expect(load).toThrow("UNSAFE_PATH_OVERLAP");
  });
  it("requires external canonical secrets and explicit agent skills", () => {
    const canonical = readFileSync(config.secretsPath, "utf8");
    config.secretsPath = join(code, "secrets.local.json");
    write(config.secretsPath, canonical);
    expect(load).toThrow("EXTERNAL_CANONICAL_SECRETS_REQUIRED");
    config.secretsPath = join(source, "secrets.local.json");
    config.skillDirectories = [source];
    expect(load).toThrow("SKILL_DIRECTORIES_INVALID");
  });
  it("supports explicit no-MCP or allowlisted stdio/http with secret references only", () => {
    config.mcp = { mode: "allowlist", servers: [
      { type: "stdio", name: "local", command: "node", args: ["worker.js", { secretRef: "mcp.key" }], env: { API_KEY: { secretRef: "mcp.key" } }, tools: ["read-record"] },
      { type: "http", name: "remote", url: "https://example.invalid/mcp", headers: { Authorization: { secretRef: "mcp.key" } }, tools: ["read-record"] },
    ] };
    const result = load();
    expect(result.resolveSecret("mcp.key")).toBe("synthetic-secret-must-not-leak");
    expect(JSON.stringify(result.config)).not.toContain("synthetic-secret-must-not-leak");
    config.mcp.servers[1] = { type: "http", name: "remote", url: "https://example.invalid/mcp?token=unsafe", headers: {}, tools: ["read-record"] };
    expect(load).toThrow("CONFIG_SCHEMA_INVALID");
  });
});

describe("explicit private/group/forum bindings", () => {
  it("keeps private bots separate and requires the exact owner/bot/chat/kind/topic", () => {
    const valid = load().config;
    const candidate = { ownerId: 101, botId: "bot-one", chatId: -202, topicId: 1, chatKind: "forum" as const, isBot: false };
    expect(authorizeScope(valid, candidate)).toEqual({ ownerId: 101, botId: "bot-one", chatId: -202, topicId: 1 });
    for (const change of [{ ownerId: 102 }, { botId: "bot-two" }, { topicId: 2 }, { topicId: null }, { chatId: -999 }, { isBot: true }, { chatKind: "group" as const }]) {
      expect(authorizeScope(valid, { ...candidate, ...change })).toBeNull();
    }
    expect(authorizeScope(valid, { ...candidate, botId: "bot-two", topicId: null, chatId: 101, chatKind: "private" })).not.toBeNull();
  });
  it("rejects two bots in one group/topic and group/forum ambiguity", () => {
    config.bindings.push({ botId: "bot-two", chatId: -201, topicId: null, kind: "group" });
    expect(load).toThrow("BINDING_CONFLICT");
    config.bindings.pop();
    config.bindings.push({ botId: "bot-two", chatId: -201, topicId: 9, kind: "forum" });
    expect(load).toThrow("BINDING_KIND_CONFLICT");
  });
  it("rejects missing topics, private topics, duplicate DM entries and unknown bots", () => {
    config.bindings[0]!.topicId = 1;
    expect(load).toThrow("BINDING_KIND_INVALID");
    config.bindings[0]!.topicId = null;
    config.bindings.push({ ...config.bindings[0]! });
    expect(load).toThrow("BINDING_CONFLICT");
    config.bindings.pop();
    config.bindings[0]!.botId = "unknown";
    expect(load).toThrow("BINDING_UNKNOWN_BOT");
  });
});
