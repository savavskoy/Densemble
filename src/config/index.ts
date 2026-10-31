import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { engineIds, type ChatKind, type EngineId, type Scope } from "../domain.js";
import { discoverAllAgents, type AgentDefinition } from "./agents.js";
import { assertDisjoint, checkedPath, ConfigError, isWithin, sourcePath } from "./paths.js";
import { canUseBot, resolveWorkspaces, userSchema, validateUsers, workspaceSchema } from "./workspaces.js";

const name = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const nonempty = z.string().trim().min(1);
const numericId = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((n) => n !== 0);
const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
const secretRef = z.string().regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .refine((ref) => !ref.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)));
const secretValue = z.object({ secretRef }).strict();
const mcpCommon = { name, tools: z.array(nonempty).min(1) };
const language = z.string().regex(/^(auto|[a-z]{2,3})$/);
const threads = z.number().int().min(1).max(8);
/** Recognition hints joined into one whisper prompt; bounded so they never crowd out speech context. */
const vocabulary = z.array(z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u)).max(100)
  .refine((terms) => terms.join(", ").length <= 800);
const vadThreshold = z.number().min(0.1).max(0.95);
const vadMs = z.number().int().min(0).max(10_000);
const maxContext = z.number().int().min(-1).max(224);
const recordingsSchema = z.object({
  path: nonempty,
  modelPath: nonempty,
  vadModelPath: nonempty,
  language: language.optional(),
  threads: threads.optional(),
  vocabulary: vocabulary.optional(),
  quietMinutes: z.number().int().min(1).max(60).optional(),
  pollIntervalMs: z.number().int().min(30_000).max(300_000).optional(),
  vad: z.object({
    threshold: vadThreshold.optional(), minSpeechMs: vadMs.optional(), minSilenceMs: vadMs.optional(), padMs: vadMs.optional(),
  }).strict().optional(),
  suppressNonSpeech: z.boolean().optional(),
  maxContext: maxContext.optional(),
  retry: z.object({
    modelPath: nonempty.optional(), vadThreshold: vadThreshold.optional(), vadMinSpeechMs: vadMs.optional(),
    suppressNonSpeech: z.boolean().optional(), maxContext: maxContext.optional(),
  }).strict().optional(),
  silence: z.object({
    thresholdDb: z.number().int().min(-120).max(-30).optional(), minSeconds: z.number().int().min(10).max(3_600).optional(),
  }).strict().optional(),
  notifications: z.boolean().optional(),
}).strict();
const mcpSchema = z.discriminatedUnion("type", [
  z.object({
    ...mcpCommon, type: z.literal("stdio"), command: nonempty, args: z.array(z.union([z.string(), secretValue])),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), secretValue), cwd: nonempty.optional(),
  }).strict(),
  z.object({
    ...mcpCommon, type: z.literal("http"), url: z.url().refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), secretValue),
  }).strict(),
]);
export const configSchema = z.object({
  workspacePath: nonempty,
  agentDefinitionsPath: nonempty,
  agentLaunchersPath: nonempty,
  secretsPath: nonempty,
  runtimeDataPath: nonempty,
  runtimeHomePath: nonempty,
  interactiveHomePath: nonempty.optional(),
  skillDirectories: z.array(nonempty).min(1),
  ownerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  users: z.array(userSchema).optional(),
  workspaces: z.array(workspaceSchema).optional(),
  permissionMode: z.enum(["manual", "autopilot"]).optional(),
  quietHours: z.object({
    start: z.string().regex(hhmm),
    end: z.string().regex(hhmm),
    timezone: nonempty,
  }).strict().optional(),
  proactivity: z.object({
    minIntervalMs: z.number().int().min(60_000).optional(),
    maxActiveItemsPerAgent: z.number().int().min(1).optional(),
  }).strict().optional(),
  claudeCode: z.object({ homePath: nonempty, defaultModel: nonempty }).strict().optional(),
  bots: z.array(z.object({
    id: name, agentId: name, tokenRef: secretRef,
    engine: z.enum(engineIds as [EngineId, ...EngineId[]]).optional(), model: nonempty.optional(),
  }).strict()).min(1),
  bindings: z.array(z.object({
    botId: name, chatId: numericId, kind: z.enum(["private", "group", "forum"]),
    topicId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict()).min(1),
  mcp: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }).strict(),
    z.object({ mode: z.literal("allowlist"), servers: z.array(mcpSchema).min(1) }).strict(),
  ]),
  audio: z.object({
    ffmpegPath: nonempty.optional(),
    ffprobePath: nonempty.optional(),
    whisperPath: nonempty.optional(),
    modelPath: nonempty.optional(),
    language: language.optional(),
    threads: threads.optional(),
    vocabulary: vocabulary.optional(),
    vadModelPath: nonempty.optional(),
    probeTimeoutMs: z.number().int().min(1).max(15_000).optional(),
    decodeTimeoutMs: z.number().int().min(1).max(120_000).optional(),
    asrTimeoutMs: z.number().int().min(1).max(900_000).optional(),
  }).strict().optional(),
  recordings: recordingsSchema.optional(),
}).strict();
export type ServiceConfig = z.infer<typeof configSchema>;
export type BotConfig = ServiceConfig["bots"][number];
export type ChatBinding = ServiceConfig["bindings"][number];
export type McpDeclaration = z.infer<typeof mcpSchema>;
export const defaultQuietHours = Object.freeze({
  start: "01:00",
  end: "09:30",
  timezone: "Europe/Kyiv",
});
export const defaultProactivityGuardrails = Object.freeze({
  minIntervalMs: 1_800_000,
  maxActiveItemsPerAgent: 20,
});

export interface LoadedConfig {
  config: ServiceConfig;
  agents: AgentDefinition[];
  tokenForBot(botId: string): string;
  resolveSecret(reference: string): string;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new ConfigError("CONFIG_JSON_UNREADABLE"); }
}

export function secretResolver(secrets: unknown): (reference: string) => string {
  return (reference) => {
    if (!secretRef.safeParse(reference).success) throw new ConfigError("SECRET_REFERENCE_INVALID");
    let value: unknown = secrets;
    for (const key of reference.split(".")) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) {
        throw new ConfigError("SECRET_REFERENCE_UNRESOLVED");
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
      throw new ConfigError("SECRET_VALUE_INVALID");
    }
    return value;
  };
}

export function loadConfig(configPath: string, options: { codeRoot?: string } = {}): LoadedConfig {
  const file = checkedPath(configPath, "file");
  const parsed = configSchema.safeParse(readJson(file));
  if (!parsed.success) throw new ConfigError("CONFIG_SCHEMA_INVALID");
  const config = parsed.data;
  config.permissionMode ??= "autopilot";
  config.quietHours ??= { ...defaultQuietHours };
  config.proactivity = { ...defaultProactivityGuardrails, ...config.proactivity };
  const fromConfig = (path: string) => resolve(dirname(file), path);
  if (config.audio) {
    if (config.audio.modelPath) config.audio.modelPath = fromConfig(config.audio.modelPath);
    if (config.audio.vadModelPath) config.audio.vadModelPath = fromConfig(config.audio.vadModelPath);
    for (const key of ["ffmpegPath", "ffprobePath", "whisperPath"] as const) {
      const command = config.audio[key];
      if (command?.includes("/")) config.audio[key] = fromConfig(command);
    }
  }
  const code = checkedPath(options.codeRoot ?? process.cwd(), "directory");
  config.workspacePath = checkedPath(fromConfig(config.workspacePath), "directory");
  assertDisjoint(code, config.workspacePath);
  config.agentDefinitionsPath = sourcePath(config.workspacePath, fromConfig(config.agentDefinitionsPath), "directory");
  config.agentLaunchersPath = sourcePath(config.workspacePath, fromConfig(config.agentLaunchersPath), "directory");
  config.secretsPath = checkedPath(fromConfig(config.secretsPath), "file");
  if (basename(config.secretsPath) !== "secrets.local.json" || isWithin(code, config.secretsPath)) {
    throw new ConfigError("EXTERNAL_CANONICAL_SECRETS_REQUIRED");
  }
  config.runtimeDataPath = checkedPath(fromConfig(config.runtimeDataPath), "directory");
  config.runtimeHomePath = checkedPath(fromConfig(config.runtimeHomePath), "directory");
  const interactive = fromConfig(config.interactiveHomePath ?? resolve(homedir(), ".copilot"));
  // The interactive home need not exist, but an existing symlink ancestor is never accepted.
  let existing = interactive;
  for (;;) {
    try { checkedPath(existing, "directory"); break; }
    catch (error) {
      if (error instanceof ConfigError && error.code === "PATH_MISSING_OR_UNREADABLE" && dirname(existing) !== existing) {
        existing = dirname(existing);
      } else { throw error; }
    }
  }
  config.interactiveHomePath = interactive;
  for (const managed of [config.runtimeDataPath, config.runtimeHomePath]) {
    assertDisjoint(managed, config.workspacePath);
    assertDisjoint(managed, interactive);
    if (isWithin(managed, code) || isWithin(managed, file) || isWithin(managed, config.secretsPath)) {
      throw new ConfigError("UNSAFE_PATH_OVERLAP");
    }
  }
  assertDisjoint(config.runtimeDataPath, config.runtimeHomePath);
  if (config.claudeCode) {
    // A separate, service-owned CLAUDE_CONFIG_DIR: never the interactive ~/.claude, never shared with Copilot state.
    const claudeHome = checkedPath(fromConfig(config.claudeCode.homePath), "directory");
    for (const other of [config.workspacePath, interactive, resolve(homedir(), ".claude"), config.runtimeDataPath, config.runtimeHomePath]) {
      assertDisjoint(claudeHome, other);
    }
    if (isWithin(claudeHome, code) || isWithin(claudeHome, file) || isWithin(claudeHome, config.secretsPath)) {
      throw new ConfigError("UNSAFE_PATH_OVERLAP");
    }
    config.claudeCode.homePath = claudeHome;
  } else if (config.bots.some((bot) => bot.engine === "claude-code")) {
    throw new ConfigError("CLAUDE_CODE_CONFIG_REQUIRED");
  }
  config.skillDirectories = config.skillDirectories.map((path) => sourcePath(config.workspacePath, fromConfig(path), "directory"));
  if (!config.skillDirectories.includes(resolve(config.workspacePath, "agent", "skills")) ||
      new Set(config.skillDirectories).size !== config.skillDirectories.length) throw new ConfigError("SKILL_DIRECTORIES_INVALID");
  const agents = discoverAllAgents({
    ...config,
    workspaces: (config.workspaces ?? []).map((workspace) => ({
      path: checkedPath(fromConfig(workspace.path), "directory"), agentSource: workspace.agentSource,
    })),
  });
  const resolveSecret = secretResolver(readJson(config.secretsPath));
  const tokens = new Map<string, string>();
  const tokenIdentities = new Set<string>();
  const boundAgents = new Set<string>();
  for (const bot of config.bots) {
    // One persona may be served once per engine, e.g. a Copilot bot and a Claude Code bot side by side.
    const binding = `${bot.agentId}:${botEngine(config, bot.id)}`;
    if (tokens.has(bot.id) || boundAgents.has(binding)) throw new ConfigError("DUPLICATE_BOT");
    const agent = agents.find((candidate) => candidate.id === bot.agentId);
    if (!agent || !agent.userInvocable) throw new ConfigError("BOT_AGENT_NOT_INVOCABLE");
    const token = resolveSecret(bot.tokenRef);
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new ConfigError("BOT_TOKEN_INVALID");
    const identity = token.split(":")[0]!.replace(/^0+(?=\d)/, "");
    if (identity === "0" || tokenIdentities.has(identity)) throw new ConfigError("DUPLICATE_BOT_TOKEN");
    tokenIdentities.add(identity);
    tokens.set(bot.id, token);
    boundAgents.add(binding);
  }
  const bindings = new Set<string>();
  const chatKinds = new Map<number, ChatKind>();
  for (const binding of config.bindings) {
    if (!tokens.has(binding.botId)) throw new ConfigError("BINDING_UNKNOWN_BOT");
    if ((binding.kind === "forum") !== (binding.topicId !== null) ||
        (binding.kind === "private" ? binding.chatId <= 0 : binding.chatId >= 0)) throw new ConfigError("BINDING_KIND_INVALID");
    const previousKind = chatKinds.get(binding.chatId);
    if (previousKind && previousKind !== binding.kind) throw new ConfigError("BINDING_KIND_CONFLICT");
    chatKinds.set(binding.chatId, binding.kind);
    const key = JSON.stringify([binding.kind === "private" ? binding.botId : null, binding.chatId, binding.topicId]);
    if (bindings.has(key)) throw new ConfigError("BINDING_CONFLICT");
    bindings.add(key);
  }
  validateUsers(config);
  if (config.workspaces?.length) {
    if (config.claudeCode) {
      for (const workspace of config.workspaces) assertDisjoint(config.claudeCode.homePath, checkedPath(fromConfig(workspace.path), "directory"));
    }
    config.workspaces = resolveWorkspaces(config, agents, {
      code, configFile: file, secretsPath: config.secretsPath, serviceWorkspace: config.workspacePath,
      runtimeDataPath: config.runtimeDataPath, runtimeHomePath: config.runtimeHomePath, interactiveHomePath: interactive,
    }, fromConfig);
  }
  if (config.recordings) {
    // Model files are checked at service start: a bad model disables recordings, not the service.
    config.recordings.modelPath = fromConfig(config.recordings.modelPath);
    config.recordings.vadModelPath = fromConfig(config.recordings.vadModelPath);
    if (config.recordings.retry?.modelPath) config.recordings.retry.modelPath = fromConfig(config.recordings.retry.modelPath);
    const folder = checkedPath(fromConfig(config.recordings.path), "directory");
    const ownerRoots = [config.workspacePath, ...(config.workspaces ?? [])
      .filter((workspace) => workspace.ownerUserId === config.ownerId).map((workspace) => workspace.path)];
    if (!ownerRoots.some((root) => isWithin(root, folder))) throw new ConfigError("RECORDINGS_PATH_OUTSIDE_WORKSPACE");
    for (const managed of [code, config.runtimeDataPath, config.runtimeHomePath, interactive,
      ...(config.claudeCode ? [config.claudeCode.homePath] : [])]) assertDisjoint(managed, folder);
    if (isWithin(folder, file) || isWithin(folder, config.secretsPath)) throw new ConfigError("UNSAFE_PATH_OVERLAP");
    config.recordings.path = folder;
  }
  if (config.mcp.mode === "allowlist") {
    const names = new Set<string>();
    for (const server of config.mcp.servers) {
      if (names.has(server.name)) throw new ConfigError("DUPLICATE_MCP");
      names.add(server.name);
      if (server.type === "stdio") {
        if (server.cwd) server.cwd = sourcePath(config.workspacePath, fromConfig(server.cwd), "directory");
        for (const arg of server.args) if (typeof arg !== "string") resolveSecret(arg.secretRef);
        for (const value of Object.values(server.env)) resolveSecret(value.secretRef);
      } else {
        for (const value of Object.values(server.headers)) resolveSecret(value.secretRef);
      }
    }
  }
  return {
    config, agents, resolveSecret,
    tokenForBot(botId) {
      const token = tokens.get(botId);
      if (!token) throw new ConfigError("UNKNOWN_BOT");
      return token;
    },
  };
}

/** The engine a bot runs; bots without an explicit engine stay on Copilot. */
export function botEngine(config: Pick<ServiceConfig, "bots">, botId: string): EngineId {
  return config.bots.find((bot) => bot.id === botId)?.engine ?? "copilot";
}

export function authorizeScope(config: ServiceConfig, candidate: {
  ownerId: number; botId: string; chatId: number; topicId: number | null; chatKind: ChatKind; isBot: boolean;
}): Scope | null {
  if (candidate.isBot) return null;
  if (candidate.ownerId !== config.ownerId &&
      (candidate.chatKind !== "private" || candidate.topicId !== null || candidate.chatId !== candidate.ownerId ||
       !canUseBot(config, candidate.ownerId, candidate.botId))) return null;
  const binding = config.bindings.find((entry) => entry.botId === candidate.botId && entry.chatId === candidate.chatId &&
    entry.topicId === candidate.topicId && entry.kind === candidate.chatKind);
  return binding ? { ownerId: candidate.ownerId, botId: candidate.botId, chatId: candidate.chatId, topicId: candidate.topicId } : null;
}

export { discoverAgents, discoverAllAgents, type AgentDefinition } from "./agents.js";
export { ConfigError } from "./paths.js";
export * from "./workspaces.js";
