import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig } from "../config/index.js";
import { RuntimeError } from "./contracts.js";

export const CLAUDE_SDK_VERSION = "0.3.305";
export const CLAUDE_CODE_VERSION = "2.1.305";
export const pluginName = "densemble";
const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** The service-owned CLAUDE_CONFIG_DIR; it never falls back to the interactive ~/.claude. */
export function claudeHome(config: LoadedConfig): string {
  const home = config.config.claudeCode?.homePath;
  if (!home) throw new RuntimeError("CLAUDE_CODE_NOT_CONFIGURED");
  return home;
}

/** Resolve the pinned native binary bundled with the pinned SDK, never a global `claude` launcher. */
export async function pinnedClaudePath(): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new RuntimeError("RUNTIME_REQUIRES_MACOS_ARM64");
  let manifest: string;
  let sdkEntry: string;
  try {
    manifest = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json"));
    sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  } catch { throw new RuntimeError("CLAUDE_ENGINE_UNAVAILABLE"); }
  const native = JSON.parse(await readFile(manifest, "utf8")) as { version: string };
  const sdk = JSON.parse(await readFile(join(dirname(sdkEntry), "package.json"), "utf8")) as { version: string; claudeCodeVersion?: string };
  if (native.version !== CLAUDE_SDK_VERSION || sdk.version !== CLAUDE_SDK_VERSION || sdk.claudeCodeVersion !== CLAUDE_CODE_VERSION) {
    throw new RuntimeError("RUNTIME_VERSION_MISMATCH");
  }
  const binary = join(dirname(manifest), "claude");
  try {
    const stat = await lstat(binary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
  } catch { throw new RuntimeError("CLAUDE_ENGINE_UNAVAILABLE"); }
  return binary;
}

/** A complete environment: nothing ambient (API keys, tokens, interactive config dirs) is inherited. */
export function claudeEnvironment(config: LoadedConfig): Record<string, string> {
  const home = process.env.HOME;
  if (!home) throw new RuntimeError("AUTH_HOME_REQUIRED");
  // The macOS Keychain login is looked up by account name; without USER the service login is invisible.
  const user = userInfo().username;
  return {
    HOME: home, USER: user, LOGNAME: user, CLAUDE_CONFIG_DIR: claudeHome(config),
    TMPDIR: join(config.config.runtimeDataPath, "scratch"),
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: "en_US.UTF-8", GH_PROMPT_DISABLED: "1",
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "densemble",
  };
}

export interface ServiceSkill { name: string; path: string }

function skillName(text: string, fallback: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return fallback;
  for (const line of lines.slice(1, lines.indexOf("---", 1))) {
    const match = /^name:\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return fallback;
}

/** Skills under the configured skill directories: each immediate subdirectory holding a SKILL.md. */
export async function serviceSkills(config: LoadedConfig): Promise<ServiceSkill[]> {
  const skills: ServiceSkill[] = [];
  for (const directory of config.config.skillDirectories) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      let text: string;
      try { text = await readFile(join(path, "SKILL.md"), "utf8"); } catch { continue; }
      const name = skillName(text, entry.name);
      if (skills.some((skill) => skill.name === name || skill.path === path)) throw new RuntimeError("CLAUDE_SKILL_DUPLICATE");
      skills.push({ name, path });
    }
  }
  return skills;
}

/**
 * Regenerate the service plugin that exposes workspace skills to Claude Code. Skills are symlinked, not
 * copied, so the knowledge workspace stays their only source. Only this service-owned directory is replaced.
 */
export async function writeServicePlugin(config: LoadedConfig, skills: ServiceSkill[]): Promise<string> {
  const home = claudeHome(config);
  if (await realpath(home) !== home) throw new RuntimeError("CLAUDE_HOME_UNSAFE");
  const root = join(home, `${pluginName}-plugin`);
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new RuntimeError("CLAUDE_PLUGIN_UNSAFE");
    await rm(root, { recursive: true });
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RuntimeError("CLAUDE_PLUGIN_UNSAFE");
  }
  await mkdir(join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "skills"), { mode: 0o700 });
  await writeFile(join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0", description: "Densemble workspace skills" }), { mode: 0o600 });
  for (const skill of skills) await symlink(skill.path, join(root, "skills", skill.name), "dir");
  return root;
}

/** Workspace-level instructions that Copilot loads from `instructionDirectories`, read explicitly. */
export async function workspaceInstructions(workspace: string): Promise<{ source: string; text: string }[]> {
  const result: { source: string; text: string }[] = [];
  for (const source of ["AGENTS.md", join(".github", "copilot-instructions.md")]) {
    const path = join(workspace, source);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue;
      if (await realpath(path) !== resolve(path)) continue;
      result.push({ source, text: await readFile(path, "utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RuntimeError("WORKSPACE_INSTRUCTIONS_UNREADABLE");
    }
  }
  return result;
}

async function entries(directory: string): Promise<import("node:fs").Dirent[]> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new RuntimeError("SESSION_HISTORY_UNSAFE");
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function owned(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || await realpath(path) !== path) throw new RuntimeError("SESSION_HISTORY_UNSAFE");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The transcript that proves a session has history: `<home>/projects/<project>/<uuid>.jsonl`. */
export async function claudeTranscripts(home: string, sessionId: string): Promise<string[]> {
  if (!sessionIdPattern.test(sessionId)) throw new RuntimeError("UNOWNED_PROVIDER_SESSION");
  const projects = join(home, "projects");
  const found: string[] = [];
  for (const project of await entries(projects)) {
    if (!project.isDirectory()) continue;
    const path = await owned(join(projects, project.name, `${sessionId}.jsonl`));
    if (path) found.push(path);
  }
  return found;
}

/**
 * Every service-owned path Claude Code keys by this session ID: transcript and subagent transcripts, edit
 * backups, session environment, todos and debug log. Nothing is matched by prefix beyond the exact ID.
 */
export async function claudeHistory(home: string, sessionId: string): Promise<string[]> {
  const found = await claudeTranscripts(home, sessionId);
  const projects = join(home, "projects");
  for (const project of await entries(projects)) {
    if (!project.isDirectory()) continue;
    const path = await owned(join(projects, project.name, sessionId));
    if (path) found.push(path);
  }
  for (const path of [join(home, "file-history", sessionId), join(home, "session-env", sessionId), join(home, "debug", `${sessionId}.txt`)]) {
    if (await owned(path)) found.push(path);
  }
  for (const entry of await entries(join(home, "todos"))) {
    if (entry.name === `${sessionId}.json` || (entry.name.startsWith(`${sessionId}-agent-`) && entry.name.endsWith(".json"))) {
      const path = await owned(join(home, "todos", entry.name));
      if (path) found.push(path);
    }
  }
  return found;
}
