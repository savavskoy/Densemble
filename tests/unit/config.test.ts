import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeScope,
  botEngine,
  ConfigError,
  defaultProactivityGuardrails,
  defaultQuietHours,
  loadConfig,
  moduleEntries,
  secretResolver,
  type LoadedConfig,
  type ServiceConfig,
  workspacesFor,
} from "../../src/config/index.js";
import { SpeechGate } from "../../src/media/speech-gate.js";
import type { PrepareResult } from "../../src/modules/contract.js";
import { createModuleHost } from "../../src/modules/host.js";
import { createCoreOffer } from "../../src/modules/offer.js";
import { module } from "../../src/modules/recordings/index.js";
import { recordingSettings, type RecordingSettings, type RecordingsConfig } from "../../src/modules/recordings/settings.js";

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

/** Resolves the real recordings module without starting it; `settings` are the prepared module settings. */
async function recordingsModule(loaded: LoadedConfig): Promise<{
  state: string; code: string; settings?: RecordingsConfig; recordingSettings?: RecordingSettings;
}> {
  const core = createCoreOffer(loaded, new SpeechGate());
  const entries = moduleEntries(loaded.config);
  const host = createModuleHost({ entries, core, runtimeDataPath: loaded.config.runtimeDataPath, diagnostics: { record: () => undefined } });
  await host.resolve();
  const health = host.health("recordings")!;
  if (health.state !== "starting") return { state: health.state, code: health.code };
  const prepared = module.prepare!(module.settings.parse(entries[0]!.settings), core) as PrepareResult<RecordingsConfig>;
  if (!prepared.ok) throw new Error("unexpected");
  return { state: health.state, code: health.code, settings: prepared.settings,
    recordingSettings: recordingSettings(prepared.settings, core.audio) };
}

describe("private configuration and discovery", () => {
  it("defaults to autopilot and accepts explicit manual/autopilot permissions", () => {
    expect(load().config.permissionMode).toBe("autopilot");
    for (const mode of ["manual", "autopilot"] as const) {
      config.permissionMode = mode;
      expect(load().config.permissionMode).toBe(mode);
    }
    write(configPath, JSON.stringify({ ...config, permissionMode: "allow-everything" }));
    expect(() => loadConfig(configPath, { codeRoot: code })).toThrow("CONFIG_SCHEMA_INVALID");
  });
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
  it("bounds vocabulary hints and resolves the optional voice VAD model", () => {
    config.audio = { vocabulary: ["НБУВ", "бібліотекознавство"], vadModelPath: "./models/vad.bin" };
    expect(load().config.audio).toMatchObject({ vocabulary: ["НБУВ", "бібліотекознавство"], vadModelPath: join(code, "models/vad.bin") });
    for (const vocabulary of [[""], ["x".repeat(61)], ["bad\u0007term"], Array.from({ length: 101 }, () => "a"),
      Array.from({ length: 20 }, () => "y".repeat(45))]) {
      config.audio = { vocabulary };
      expect(load).toThrow("CONFIG_SCHEMA_INVALID");
    }
  });
  it("accepts a recordings folder inside an owner workspace with strict, bounded settings", async () => {
    mkdirSync(join(source, "raw/recordings"), { recursive: true });
    const recordings = { path: join(source, "raw/recordings"), modelPath: "./models/large.bin", vadModelPath: "./models/vad.bin",
      vocabulary: ["НБУВ"], quietMinutes: 2, pollIntervalMs: 60_000, vad: { threshold: 0.5, minSpeechMs: 250 },
      suppressNonSpeech: false, maxContext: 0, silence: { thresholdDb: -80, minSeconds: 60 },
      retry: { modelPath: "./models/large-v3.bin", vadThreshold: 0.6, suppressNonSpeech: true, maxContext: 0 }, notifications: false };
    config.recordings = recordings;
    expect(await recordingsModule(load())).toMatchObject({ state: "starting", settings: {
      path: join(source, "raw/recordings"), modelPath: join(code, "models/large.bin"), vadModelPath: join(code, "models/vad.bin"),
      retry: { modelPath: join(code, "models/large-v3.bin") },
    } });
    for (const invalid of [{ pollIntervalMs: 1_000 }, { quietMinutes: 0 }, { vad: { threshold: 1 } },
      { retry: { maxContext: 300 } }, { retry: { modelPath: "" } }, { maxContext: 300 }, { suppressNonSpeech: "yes" },
      { silence: { thresholdDb: -10 } }, { silence: { minSeconds: 1 } }, { silence: { extra: 1 } },
      { unknown: true }, { language: "Ukrainian" }]) {
      // Invalid module settings no longer stop the service: only the module is unavailable.
      config.recordings = { ...recordings, ...invalid };
      expect(await recordingsModule(load())).toEqual({ state: "unavailable", code: "MODULE_SETTINGS_INVALID" });
    }
    const { modelPath: _model, ...withoutModel } = recordings;
    config.recordings = withoutModel;
    expect(await recordingsModule(load())).toEqual({ state: "unavailable", code: "MODULE_SETTINGS_INVALID" });
  });
  it("makes recordings unavailable, not the service, for folders outside owner workspaces, missing, symlinked or overlapping protected paths", async () => {
    const recordings = (path: string) => ({ path, modelPath: "./m.bin", vadModelPath: "./v.bin" });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    const unavailable = async (path: string) => {
      config.recordings = recordings(path);
      return (await recordingsModule(load())).code;
    };
    expect(await unavailable(join(root, "elsewhere"))).toBe("RECORDINGS_PATH_OUTSIDE_WORKSPACE");
    expect(await unavailable(join(source, "missing"))).toBe("PATH_MISSING_OR_UNREADABLE");
    symlinkSync(join(root, "elsewhere"), join(source, "linked"));
    expect(await unavailable(join(source, "linked"))).toBe("SYMLINK_PATH_REJECTED");
    // The workspace root holds the secrets file, so recordings must live in a subfolder.
    expect(await unavailable(source)).toBe("UNSAFE_PATH_OVERLAP");
  });
  it("keeps recordings off when the section is absent", () => {
    expect(load().config.recordings).toBeUndefined();
    expect(moduleEntries(load().config)).toEqual([]);
  });
  it("maps the legacy top-level recordings to modules.recordings with identical recording settings", async () => {
    mkdirSync(join(source, "raw/recordings"), { recursive: true });
    const recordings = { path: "../workspace/raw/recordings", modelPath: "./models/turbo.bin", vadModelPath: "./models/vad.bin",
      retry: { modelPath: "./models/large.bin", vadThreshold: 0.6 }, vad: { padMs: 300 } };
    config.audio = { vocabulary: ["НБУВ"], ffmpegPath: "/opt/ffmpeg" };
    config.recordings = recordings;
    const legacy = load();
    expect(moduleEntries(legacy.config)).toEqual([{ id: "recordings", enabled: true, agents: [], settings: recordings,
      movedSettings: { from: "recordings", to: "modules.recordings.settings" } }]);
    const fromLegacy = await recordingsModule(legacy);
    delete config.recordings;
    config.modules = { recordings: { agents: ["helper-one"], settings: recordings } };
    const modern = load();
    expect(moduleEntries(modern.config)).toEqual([{ id: "recordings", enabled: true, agents: ["helper-one"], settings: recordings }]);
    const fromModules = await recordingsModule(modern);
    expect(fromModules.state).toBe("starting");
    expect(fromModules.recordingSettings).toEqual(fromLegacy.recordingSettings);
    expect(fromModules.recordingSettings).toMatchObject({ path: join(source, "raw/recordings"), ffmpegPath: "/opt/ffmpeg",
      vocabulary: ["НБУВ"], modelPath: join(code, "models/turbo.bin"), retry: { modelPath: join(code, "models/large.bin") } });
    config.recordings = recordings;
    expect(load).toThrow("MODULE_SETTINGS_DUPLICATED");
  });
  it("validates module entries strictly with defaults and known personas", () => {
    config.modules = { "voice-notes": {}, recordings: { enabled: false, settings: { anything: true } } };
    expect(moduleEntries(load().config)).toEqual([
      { id: "voice-notes", enabled: true, agents: [], settings: undefined },
      { id: "recordings", enabled: false, agents: [], settings: { anything: true } },
    ]);
    for (const id of ["Recordings", "1st", "a".repeat(33), "with_underscore"]) {
      config.modules = { [id]: {} };
      expect(load).toThrow("MODULE_ID_INVALID");
    }
    config.modules = { recordings: { enabled: true, extra: 1 } } as unknown as ServiceConfig["modules"];
    expect(load).toThrow("CONFIG_SCHEMA_INVALID");
    config.modules = { recordings: { agents: ["helper-one", "missing"] } };
    expect(load).toThrow("MODULE_AGENT_UNKNOWN");
    // Workers have no chat of their own, so they cannot use module abilities.
    config.modules = { recordings: { agents: ["worker"] } };
    expect(load).toThrow("MODULE_AGENT_UNKNOWN");
  });
  it("requires the coordinator to be a persona with an owner private binding", () => {
    config.coordinatorAgentId = "helper-one";
    expect(load().config.coordinatorAgentId).toBe("helper-one");
    for (const agentId of ["helper-three", "missing", "worker"]) {
      config.coordinatorAgentId = agentId;
      expect(load).toThrow("COORDINATOR_BINDING_MISSING");
    }
    config.coordinatorAgentId = "helper-one";
    config.bindings = config.bindings.filter((binding) => !(binding.botId === "bot-one" && binding.kind === "private"));
    expect(load).toThrow("COORDINATOR_BINDING_MISSING");
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
  it("authorizes configured users only in explicitly bound private chats and permitted bots", () => {
    config.users = [{ telegramUserId: 202, displayName: "Sonya", allowedBotIds: ["bot-one"] }];
    config.bindings.push({ botId: "bot-one", chatId: 202, topicId: null, kind: "private" });
    const loaded = load().config;
    expect(authorizeScope(loaded, {
      ownerId: 202, botId: "bot-one", chatId: 202, topicId: null, chatKind: "private", isBot: false,
    })).toEqual({ ownerId: 202, botId: "bot-one", chatId: 202, topicId: null });
    for (const candidate of [
      { ownerId: 202, botId: "bot-two", chatId: 202, topicId: null, chatKind: "private" as const, isBot: false },
      { ownerId: 203, botId: "bot-one", chatId: 203, topicId: null, chatKind: "private" as const, isBot: false },
      { ownerId: 202, botId: "bot-one", chatId: -201, topicId: null, chatKind: "group" as const, isBot: false },
    ]) expect(authorizeScope(loaded, candidate)).toBeNull();
  });
  it("validates workspace membership, private ownership, permitted agents and safe paths", () => {
    const shared = join(root, "knowledge-shared");
    const personal = join(root, "knowledge-personal");
    for (const path of [shared, personal]) mkdirSync(path);
    config.users = [{ telegramUserId: 202, displayName: "Sonya", allowedBotIds: ["bot-one"] }];
    config.workspaces = [
      { id: "team", name: "Team", access: "shared", ownerUserId: 101, memberUserIds: [202],
        path: shared, agentIds: ["helper-one"] },
      { id: "sonya-private", name: "Sonya private", access: "private", ownerUserId: 202,
        path: personal, agentIds: ["helper-one"] },
    ];
    const loaded = load();
    expect(loaded.config.workspaces?.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "team", path: shared }, { id: "sonya-private", path: personal },
    ]);
    expect(workspacesFor(loaded.config, 202, "bot-one").map((workspace) => workspace.id))
      .toEqual(["team", "sonya-private"]);
    expect(workspacesFor(loaded.config, 101, "bot-one").map((workspace) => workspace.id)).toEqual(["team"]);

    config.workspaces![1] = { ...config.workspaces![1]!, memberUserIds: [101] };
    expect(load).toThrow(ConfigError);
    config.workspaces![1] = { ...config.workspaces![1]!, memberUserIds: undefined, path: source };
    expect(load).toThrow(ConfigError);
    config.workspaces![1] = { ...config.workspaces![1]!, path: personal, agentIds: ["worker"] };
    expect(load).toThrow(ConfigError);
  });
  it("allows a workspace to share its exact root with agent sources but not an ancestor or descendant", () => {
    const externalSecrets = join(root, "secrets.local.json");
    copyFileSync(join(source, "secrets.local.json"), externalSecrets);
    config.secretsPath = externalSecrets;
    config.users = [{ telegramUserId: 202, displayName: "Sonya", allowedBotIds: ["bot-one"] }];
    config.workspaces = [
      { id: "team", name: "Team", access: "shared", ownerUserId: 101, memberUserIds: [202],
        path: source, agentIds: ["helper-one"] },
    ];
    expect(load().config.workspaces?.map(({ id, path }) => ({ id, path }))).toEqual([{ id: "team", path: source }]);
    config.workspaces[0]!.path = join(source, "agent");
    expect(load).toThrow("UNSAFE_PATH_OVERLAP");
    config.workspaces[0]!.path = root;
    expect(load).toThrow("UNSAFE_PATH_OVERLAP");
  });
  it("discovers agents defined inside a workspace flagged agentSource without hiding global agents", () => {
    const knowledge = join(root, "knowledge-agents");
    write(join(knowledge, "AGENTS.md"), "# Local rules");
    write(join(knowledge, "agent/agents/local-pm/AGENT.md"), "---\nname: local-pm\ndescription: Local\n---\n# Local PM");
    write(join(knowledge, ".github/agents/local-pm.agent.md"),
      "---\nname: local-pm\ndescription: Local\nmodel: synthetic-model\n---\nRead and follow `agent/agents/local-pm/AGENT.md`.");
    config.users = [{ telegramUserId: 202, displayName: "Sonya", allowedBotIds: ["bot-one"] }];
    config.workspaces = [{ id: "kb", name: "KB", access: "shared", ownerUserId: 101, memberUserIds: [202],
      path: knowledge, agentIds: ["local-pm"], agentSource: true }];
    const ids = load().agents.map((agent) => agent.id);
    expect(ids).toContain("local-pm");
    expect(ids).toContain("helper-one");
    config.workspaces[0]!.agentSource = false;
    expect(load).toThrow("WORKSPACE_AGENT_INVALID");
    config.workspaces[0]!.agentSource = true;
    write(join(knowledge, "agent/agents/helper-one/AGENT.md"), "# Clash");
    write(join(knowledge, ".github/agents/helper-one.agent.md"),
      "---\nname: helper-one\ndescription: Clash\nmodel: synthetic-model\n---\nRead and follow `agent/agents/helper-one/AGENT.md`.");
    expect(load).toThrow("AGENT_DUPLICATE");
  });
  it("rejects duplicate configured users and unknown bot grants", () => {
    config.users = [
      { telegramUserId: 202, allowedBotIds: ["bot-one"] },
      { telegramUserId: 202, allowedBotIds: ["bot-one"] },
    ];
    expect(load).toThrow("USER_DUPLICATE");
    config.users = [{ telegramUserId: 202, allowedBotIds: ["unknown"] }];
    expect(load).toThrow("USER_BOT_INVALID");
  });
});

describe("proactivity configuration defaults and validation", () => {
  it("applies quiet-hours and proactivity defaults when absent or partial", () => {
    expect(load().config.quietHours).toEqual(defaultQuietHours);
    expect(load().config.proactivity).toEqual(defaultProactivityGuardrails);
    config.proactivity = { maxActiveItemsPerAgent: 7 };
    expect(load().config.proactivity).toEqual({
      minIntervalMs: defaultProactivityGuardrails.minIntervalMs,
      maxActiveItemsPerAgent: 7,
    });
  });
  it.each([
    { start: "9:30", end: "10:00", timezone: "Europe/Kyiv" },
    { start: "09:30", end: "24:00", timezone: "Europe/Kyiv" },
  ])("rejects malformed quiet-hours values", (quietHours) => {
    config.quietHours = quietHours;
    expect(load).toThrow("CONFIG_SCHEMA_INVALID");
  });
  it("rejects too-small proactive intervals", () => {
    config.proactivity = { minIntervalMs: 59_999 };
    expect(load).toThrow("CONFIG_SCHEMA_INVALID");
  });
});
describe("per-bot engine selection", () => {
  it("keeps every bot on Copilot when no engine settings are present", () => {
    const loaded = load();
    expect(loaded.config.claudeCode).toBeUndefined();
    expect(loaded.config.bots.map((bot) => botEngine(loaded.config, bot.id))).toEqual(["copilot", "copilot"]);
  });
  it("requires a claudeCode block for a Claude Code bot", () => {
    config.bots[1] = { ...config.bots[1]!, engine: "claude-code" };
    expect(load).toThrow("CLAUDE_CODE_CONFIG_REQUIRED");
  });
  it("accepts a separate service-owned Claude home and an optional bot model", () => {
    mkdirSync(join(code, "runtime/claude"), { recursive: true });
    config.claudeCode = { homePath: "./runtime/claude", defaultModel: "claude-sonnet-5-5" };
    config.bots[1] = { ...config.bots[1]!, engine: "claude-code", model: "claude-opus-5-5" };
    const loaded = load();
    expect(loaded.config.claudeCode?.homePath).toBe(join(code, "runtime/claude"));
    expect(botEngine(loaded.config, "bot-two")).toBe("claude-code");
  });
  it("rejects a Claude home overlapping Copilot, data, workspace or code paths", () => {
    for (const homePath of ["./runtime/copilot", "./data", source, code]) {
      config.claudeCode = { homePath, defaultModel: "claude-sonnet-5-5" };
      expect(load, homePath).toThrow("UNSAFE_PATH_OVERLAP");
    }
  });
  it("lets one persona serve two bots only on different engines", () => {
    mkdirSync(join(code, "runtime/claude"), { recursive: true });
    config.claudeCode = { homePath: "./runtime/claude", defaultModel: "claude-sonnet-5-5" };
    config.bots[1] = { ...config.bots[1]!, agentId: "helper-one" };
    expect(load).toThrow("DUPLICATE_BOT");
    config.bots[1] = { ...config.bots[1]!, engine: "claude-code" };
    expect(load().config.bots.map((bot) => bot.agentId)).toEqual(["helper-one", "helper-one"]);
  });
  it("rejects unknown engines", () => {
    (config.bots[1] as { engine?: string }).engine = "gemini";
    expect(load).toThrow("CONFIG_SCHEMA_INVALID");
  });
});
