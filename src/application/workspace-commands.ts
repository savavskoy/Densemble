import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_ID, workspacesFor, type WorkspaceConfig } from "../config/index.js";
import type { Scope, Session } from "../domain.js";

type Config = WorkspaceConfig & { workspacePath: string; runtimeDataPath: string };
export type WorkspaceCommand =
  | { kind: "list" } | { kind: "select"; id: string } | { kind: "usage" };

export function parseWorkspaceCommand(args: string): WorkspaceCommand {
  const value = args.trim();
  if (!value) return { kind: "list" };
  if (value === "status") return { kind: "usage" };
  return /^[a-z0-9][a-z0-9_-]*$/.test(value) ? { kind: "select", id: value } : { kind: "usage" };
}

function entries(config: Config, session: Session): { id: string; name: string; path: string }[] {
  const owner = session.scope.ownerId === config.ownerId ? [{ id: DEFAULT_WORKSPACE_ID, name: "Службовий workspace", path: config.workspacePath }] : [];
  return [...owner, ...workspacesFor(config, session.scope.ownerId, session.scope.botId)
    .map((workspace) => ({ id: workspace.id, name: workspace.name, path: workspace.path }))];
}

export function workspaceListText(config: Config, session: Session): string {
  const available = entries(config, session);
  if (!available.length) return "Для вас не налаштовано жодного workspace.";
  return "Доступні workspace:\n" + available.map((entry) =>
    `${entry.path === session.workspace ? "▶" : "•"} ${entry.id} — ${entry.name}`).join("\n") +
    "\nОбрати: /workspace <id>. Перемикання створює нову сесію без попередньої історії.";
}

export function workspaceRequiredText(config: Config, session: Session): string {
  const available = entries(config, session);
  return available.length
    ? `Спочатку оберіть workspace:\n${available.map((entry) => `• ${entry.id} — ${entry.name}`).join("\n")}\n/workspace <id>`
    : "Для вас не налаштовано жодного workspace. Зверніться до власника сервісу.";
}

/** The owner starts in the service workspace; others only in their single workspace, else an empty lobby. */
export function defaultSessionWorkspace(config: Config, scope: Scope): string {
  if (scope.ownerId === config.ownerId) return config.workspacePath;
  const available = workspacesFor(config, scope.ownerId, scope.botId);
  if (available.length === 1) return available[0]!.path;
  const lobby = join(config.runtimeDataPath, "lobby");
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  return lobby;
}
