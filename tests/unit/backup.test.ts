import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/index.js";
import type { StateStore } from "../../src/ports.js";
import { openStore } from "../../src/storage/index.js";
import { backupService, restoreService } from "../../src/operations/backup.js";

let root: string;
let store: StateStore;
let config: ServiceConfig;
const scope = { ownerId: 42, botId: "helper", chatId: 42, topicId: null };
function fixture(base: string): ServiceConfig {
  const paths = {
    workspacePath: join(base, "workspace"), runtimeDataPath: join(base, "data"),
    runtimeHomePath: join(base, "copilot"), interactiveHomePath: join(base, "interactive"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return { ...paths, agentDefinitionsPath: join(paths.workspacePath, "agents"),
    agentLaunchersPath: join(paths.workspacePath, "launchers"),
    secretsPath: join(paths.workspacePath, "secrets.local.json"),
    skillDirectories: [join(paths.workspacePath, "skills")], ownerId: 42,
    bots: [{ id: "helper", agentId: "helper", tokenRef: "telegram.helper" }],
    bindings: [{ botId: "helper", chatId: 42, topicId: null, kind: "private" }], mcp: { mode: "none" },
  };
}
beforeEach(() => {
  mkdirSync(resolve(".cache"), { recursive: true });
  root = mkdtempSync(resolve(".cache", "backup-test-"));
  config = fixture(join(root, "original"));
  store = openStore({ path: join(config.runtimeDataPath, "state.sqlite") });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true }); });

describe("offline service backup and non-destructive restore", () => {
  it("restores SQLite, managed media and owned native history without credentials or audio", async () => {
    const session = store.sessions.create(scope, { agentId: "helper", workspace: config.workspacePath, model: "example" });
    const provider = `densemble-${session.id}`;
    store.sessions.setProviderSessionId(scope, session.id, provider);
    for (const path of [
      join(config.runtimeDataPath, "media", "incoming"), join(config.runtimeDataPath, "media", "audio"),
      join(config.runtimeHomePath, "session-state", provider),
      join(config.runtimeHomePath, "session-state", "unrelated-cli-session"),
    ]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config.runtimeDataPath, "media", "incoming", "owned.txt"), "document");
    writeFileSync(join(config.runtimeDataPath, "media", "audio", "raw.wav"), "do not back up voice");
    writeFileSync(join(config.runtimeHomePath, "session-state", provider, "events.jsonl"), "synthetic history");
    writeFileSync(join(config.runtimeHomePath, "config.json"), "synthetic login metadata");
    const snapshot = join(root, "snapshot");
    await backupService(config, store, snapshot);
    expect(statSync(join(snapshot, "state.sqlite")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(snapshot, "config.json"))).toBe(false);
    expect(existsSync(join(snapshot, "media", "audio"))).toBe(false);
    expect(existsSync(join(snapshot, "session-state", "unrelated-cli-session"))).toBe(false);
    const restoredConfig = fixture(join(root, "restored"));
    writeFileSync(join(restoredConfig.runtimeHomePath, "config.json"), "keep current OAuth");
    restoreService(restoredConfig, snapshot);
    const restored = openStore({ path: join(restoredConfig.runtimeDataPath, "state.sqlite") });
    try { expect(restored.sessions.current(scope)?.providerSessionId).toBe(provider); } finally { restored.close(); }
    expect(readFileSync(join(restoredConfig.runtimeHomePath, "config.json"), "utf8")).toBe("keep current OAuth");
    expect(readFileSync(join(restoredConfig.runtimeHomePath, "session-state", provider, "events.jsonl"), "utf8")).toBe("synthetic history");
    expect(() => restoreService(restoredConfig, snapshot)).toThrow("RESTORE_REQUIRES_EMPTY_DATA");
  });
  it("refuses existing/overlapping snapshots and rejects symlink artifacts without altering source", async () => {
    await expect(backupService(config, store, config.workspacePath)).rejects.toThrow();
    const existing = join(root, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "keep.txt"), "keep");
    await expect(backupService(config, store, existing)).rejects.toThrow();
    expect(readFileSync(join(existing, "keep.txt"), "utf8")).toBe("keep");
    mkdirSync(join(config.runtimeDataPath, "media", "incoming"), { recursive: true });
    symlinkSync(join(existing, "keep.txt"), join(config.runtimeDataPath, "media", "incoming", "link"));
    const snapshot = join(root, "bad-snapshot");
    await expect(backupService(config, store, snapshot)).rejects.toThrow();
    expect(existsSync(snapshot)).toBe(false);
    expect(readFileSync(join(existing, "keep.txt"), "utf8")).toBe("keep");
  });
  it("rejects invalid databases before writing restore artifacts", async () => {
    const snapshot = join(root, "snapshot");
    await backupService(config, store, snapshot);
    writeFileSync(join(snapshot, "state.sqlite"), "not SQLite");
    const restored = fixture(join(root, "restored"));
    expect(() => restoreService(restored, snapshot)).toThrow();
    expect(existsSync(join(restored.runtimeDataPath, "state.sqlite"))).toBe(false);
  });
  it("rejects incomplete schemas before occupying restore destinations", async () => {
    const snapshot = join(root, "snapshot");
    await backupService(config, store, snapshot);
    const database = new Database(join(snapshot, "state.sqlite"));
    database.exec("DROP TABLE attachment_pins");
    database.close();
    const restored = fixture(join(root, "restored"));
    expect(() => restoreService(restored, snapshot)).toThrow("BACKUP_DATABASE_INVALID");
    expect(existsSync(join(restored.runtimeDataPath, "state.sqlite"))).toBe(false);
  });
  it("canonicalizes case aliases before rejecting overlap on case-insensitive volumes", async () => {
    const alias = config.workspacePath.replace(/workspace$/, "WORKSPACE");
    if (!existsSync(alias)) return;
    await expect(backupService(config, store, join(alias, "snapshot"))).rejects.toThrow("BACKUP_PATH_UNSAFE_OR_EXISTS");
    expect(existsSync(join(config.workspacePath, "snapshot"))).toBe(false);
  });
});
