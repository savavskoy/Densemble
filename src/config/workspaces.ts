import { z } from "zod";
import type { AgentDefinition } from "./agents.js";
import { assertDisjoint, checkedPath, ConfigError, isWithin } from "./paths.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const nonempty = z.string().trim().min(1);
const userId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const userSchema = z.object({
  telegramUserId: userId,
  displayName: nonempty.optional(),
  allowedBotIds: z.array(id).min(1),
}).strict();
export const workspaceSchema = z.object({
  id,
  name: nonempty,
  access: z.enum(["private", "shared"]),
  ownerUserId: userId,
  memberUserIds: z.array(userId).optional(),
  path: nonempty,
  agentIds: z.array(id).min(1),
  agentSource: z.boolean().optional(),
}).strict();

export type ConfiguredUser = z.infer<typeof userSchema>;
export type WorkspaceDefinition = z.infer<typeof workspaceSchema>;
export interface WorkspaceConfig {
  ownerId: number;
  bots: { id: string; agentId: string }[];
  users?: ConfiguredUser[] | undefined;
  workspaces?: WorkspaceDefinition[] | undefined;
}

/** Reserved selector for the owner's service workspace (the pre-multi-user default). */
export const DEFAULT_WORKSPACE_ID = "default";

export function isAuthorizedUser(config: Pick<WorkspaceConfig, "ownerId" | "users">, userId: number): boolean {
  return userId === config.ownerId || (config.users ?? []).some((user) => user.telegramUserId === userId);
}

export function canUseBot(config: Pick<WorkspaceConfig, "ownerId" | "users">, userId: number, botId: string): boolean {
  if (userId === config.ownerId) return true;
  return (config.users ?? []).some((user) => user.telegramUserId === userId && user.allowedBotIds.includes(botId));
}

export function members(workspace: WorkspaceDefinition): number[] {
  return [...new Set([workspace.ownerUserId, ...(workspace.memberUserIds ?? [])])];
}

/** Workspaces `userId` may use through `botId`; the bot's agent must be permitted by the workspace. */
export function workspacesFor(config: WorkspaceConfig, userId: number, botId: string): WorkspaceDefinition[] {
  const bot = config.bots.find((entry) => entry.id === botId);
  if (!bot || !canUseBot(config, userId, botId)) return [];
  return (config.workspaces ?? []).filter((workspace) =>
    members(workspace).includes(userId) && workspace.agentIds.includes(bot.agentId));
}

export function workspaceById(config: WorkspaceConfig, userId: number, botId: string, workspaceId: string): WorkspaceDefinition | null {
  return workspacesFor(config, userId, botId).find((workspace) => workspace.id === workspaceId) ?? null;
}

/**
 * The workspace a session path belongs to for this user, or "default" for the owner's service
 * workspace. Returns null when the path is not authorized for the user and bot.
 */
export function authorizedWorkspace(
  config: WorkspaceConfig & { workspacePath: string }, userId: number, botId: string, path: string,
): WorkspaceDefinition | typeof DEFAULT_WORKSPACE_ID | null {
  if (userId === config.ownerId && path === config.workspacePath) return DEFAULT_WORKSPACE_ID;
  return workspacesFor(config, userId, botId).find((workspace) => workspace.path === path) ?? null;
}

/** Private chats of configured users are conversations of that user; everything else stays owner-owned. */
export function scopeOwnerId(config: Pick<WorkspaceConfig, "ownerId" | "users">, binding: { kind: string; chatId: number }): number {
  return binding.kind === "private" && (config.users ?? []).some((user) => user.telegramUserId === binding.chatId)
    ? binding.chatId : config.ownerId;
}

export function validateUsers(config: WorkspaceConfig): void {
  const seen = new Set<number>();
  const bots = new Set(config.bots.map((bot) => bot.id));
  for (const user of config.users ?? []) {
    if (user.telegramUserId === config.ownerId || seen.has(user.telegramUserId)) throw new ConfigError("USER_DUPLICATE");
    seen.add(user.telegramUserId);
    if (new Set(user.allowedBotIds).size !== user.allowedBotIds.length ||
        user.allowedBotIds.some((bot) => !bots.has(bot))) throw new ConfigError("USER_BOT_INVALID");
  }
}

export interface WorkspaceRoots {
  code: string;
  configFile: string;
  secretsPath: string;
  serviceWorkspace: string;
  runtimeDataPath: string;
  runtimeHomePath: string;
  interactiveHomePath: string;
}

/** Validates membership, agents and paths; returns definitions whose `path` is canonical. */
export function resolveWorkspaces(
  config: WorkspaceConfig, agents: AgentDefinition[], roots: WorkspaceRoots, fromConfig: (path: string) => string,
): WorkspaceDefinition[] {
  const resolved: WorkspaceDefinition[] = [];
  const ids = new Set<string>();
  for (const definition of config.workspaces ?? []) {
    if (definition.id === DEFAULT_WORKSPACE_ID || ids.has(definition.id)) throw new ConfigError("WORKSPACE_DUPLICATE");
    ids.add(definition.id);
    const memberIds = members(definition);
    if (!memberIds.every((member) => isAuthorizedUser(config, member))) throw new ConfigError("WORKSPACE_MEMBER_UNAUTHORIZED");
    if (definition.access === "private" && memberIds.length !== 1) throw new ConfigError("WORKSPACE_PRIVATE_MEMBERS_INVALID");
    if (new Set(definition.memberUserIds ?? []).size !== (definition.memberUserIds ?? []).length) {
      throw new ConfigError("WORKSPACE_MEMBER_DUPLICATE");
    }
    if (new Set(definition.agentIds).size !== definition.agentIds.length ||
        !definition.agentIds.every((agentId) => agents.some((agent) => agent.id === agentId && agent.userInvocable))) {
      throw new ConfigError("WORKSPACE_AGENT_INVALID");
    }
    const path = checkedPath(fromConfig(definition.path), "directory");
    for (const protectedPath of [roots.code, roots.serviceWorkspace, roots.runtimeDataPath, roots.runtimeHomePath, roots.interactiveHomePath]) {
      // Explicit co-location lets the authorized workspace share its exact root with agent sources.
      // Ancestor/descendant overlap remains forbidden, as do overlaps with every other protected root.
      if (protectedPath === roots.serviceWorkspace && path === roots.serviceWorkspace) continue;
      assertDisjoint(protectedPath, path);
    }
    if (isWithin(path, roots.configFile) || isWithin(path, roots.secretsPath)) throw new ConfigError("UNSAFE_PATH_OVERLAP");
    for (const other of resolved) {
      if (isWithin(other.path, path) || isWithin(path, other.path)) throw new ConfigError("WORKSPACE_PATH_SHARED");
    }
    resolved.push({ ...definition, path });
  }
  return resolved;
}
