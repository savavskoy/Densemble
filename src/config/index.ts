import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import type { ChatKind, Scope } from "../domain.js";
import { discoverAgents, type AgentDefinition } from "./agents.js";
import { assertDisjoint, checkedPath, ConfigError, isWithin, sourcePath } from "./paths.js";

const name = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const nonempty = z.string().trim().min(1);
const numericId = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((n) => n !== 0);
const secretRef = z.string().regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .refine((ref) => !ref.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)));
const secretValue = z.object({ secretRef }).strict();
const mcpCommon = { name, tools: z.array(nonempty).min(1) };
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
  permissionMode: z.enum(["manual", "autopilot"]).optional(),
  bots: z.array(z.object({ id: name, agentId: name, tokenRef: secretRef }).strict()).min(1),
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
    language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional(),
    threads: z.number().int().min(1).max(8).optional(),
    probeTimeoutMs: z.number().int().min(1).max(15_000).optional(),
    decodeTimeoutMs: z.number().int().min(1).max(120_000).optional(),
    asrTimeoutMs: z.number().int().min(1).max(900_000).optional(),
  }).strict().optional(),
}).strict();
export type ServiceConfig = z.infer<typeof configSchema>;
export type BotConfig = ServiceConfig["bots"][number];
export type ChatBinding = ServiceConfig["bindings"][number];
export type McpDeclaration = z.infer<typeof mcpSchema>;

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
  const fromConfig = (path: string) => resolve(dirname(file), path);
  if (config.audio) {
    if (config.audio.modelPath) config.audio.modelPath = fromConfig(config.audio.modelPath);
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
  config.skillDirectories = config.skillDirectories.map((path) => sourcePath(config.workspacePath, fromConfig(path), "directory"));
  if (!config.skillDirectories.includes(resolve(config.workspacePath, "agent", "skills")) ||
      new Set(config.skillDirectories).size !== config.skillDirectories.length) throw new ConfigError("SKILL_DIRECTORIES_INVALID");
  const agents = discoverAgents(config);
  const resolveSecret = secretResolver(readJson(config.secretsPath));
  const tokens = new Map<string, string>();
  const tokenIdentities = new Set<string>();
  const boundAgents = new Set<string>();
  for (const bot of config.bots) {
    if (tokens.has(bot.id) || boundAgents.has(bot.agentId)) throw new ConfigError("DUPLICATE_BOT");
    const agent = agents.find((candidate) => candidate.id === bot.agentId);
    if (!agent || !agent.userInvocable) throw new ConfigError("BOT_AGENT_NOT_INVOCABLE");
    const token = resolveSecret(bot.tokenRef);
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new ConfigError("BOT_TOKEN_INVALID");
    const identity = token.split(":")[0]!.replace(/^0+(?=\d)/, "");
    if (identity === "0" || tokenIdentities.has(identity)) throw new ConfigError("DUPLICATE_BOT_TOKEN");
    tokenIdentities.add(identity);
    tokens.set(bot.id, token);
    boundAgents.add(bot.agentId);
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

export function authorizeScope(config: ServiceConfig, candidate: {
  ownerId: number; botId: string; chatId: number; topicId: number | null; chatKind: ChatKind; isBot: boolean;
}): Scope | null {
  if (candidate.isBot || candidate.ownerId !== config.ownerId) return null;
  const binding = config.bindings.find((entry) => entry.botId === candidate.botId && entry.chatId === candidate.chatId &&
    entry.topicId === candidate.topicId && entry.kind === candidate.chatKind);
  return binding ? { ownerId: candidate.ownerId, botId: candidate.botId, chatId: candidate.chatId, topicId: candidate.topicId } : null;
}

export { discoverAgents, type AgentDefinition } from "./agents.js";
export { ConfigError } from "./paths.js";
