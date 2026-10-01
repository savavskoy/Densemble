import { constants, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkedPath, isWithin } from "../config/paths.js";
import type { ServiceConfig } from "../config/index.js";
import type { StateStore } from "../ports.js";
import { validateBackup } from "../storage/validate-backup.js";

const nativeSession = /^densemble-[a-f0-9-]{36}$/;
function fail(): never { throw new Error("BACKUP_PATH_UNSAFE_OR_EXISTS"); }

function copyFile(source: string, target: string, created: () => void = () => {}): void {
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let targetFd: number | undefined;
  try {
    const stat = fstatSync(sourceFd);
    if (!stat.isFile() || stat.nlink !== 1) fail();
    targetFd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created();
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const count = readSync(sourceFd, buffer);
      if (count === 0) break;
      let written = 0;
      while (written < count) written += writeSync(targetFd, buffer, written, count - written);
    }
  } finally {
    closeSync(sourceFd);
    if (targetFd !== undefined) closeSync(targetFd);
  }
}
function copyTree(source: string, target: string, created: () => void = () => {}): void {
  checkedPath(source, "directory");
  mkdirSync(target, { mode: 0o700 });
  created();
  for (const name of readdirSync(source)) {
    const file = join(source, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail();
    if (stat.isDirectory()) copyTree(file, join(target, name));
    else if (stat.isFile()) copyFile(file, join(target, name));
    else fail();
  }
}
function safeTarget(config: ServiceConfig, target: string): string {
  const requested = resolve(target);
  const parent = checkedPath(dirname(requested), "directory");
  const absolute = existsSync(requested) ? checkedPath(requested, "any") : join(parent, basename(requested));
  for (const root of [config.runtimeDataPath, config.runtimeHomePath, config.workspacePath,
    config.interactiveHomePath, config.secretsPath].filter((path): path is string => Boolean(path))) {
    let existing = resolve(root);
    const suffix: string[] = [];
    while (!existsSync(existing)) { suffix.unshift(basename(existing)); existing = dirname(existing); }
    const canonical = join(realpathSync.native(existing), ...suffix);
    if (isWithin(canonical, absolute) || isWithin(absolute, canonical)) fail();
  }
  return absolute;
}
const mediaKinds = ["incoming", "outgoing"] as const;

export async function backupService(config: ServiceConfig, store: StateStore, destination: string): Promise<void> {
  const target = safeTarget(config, destination);
  mkdirSync(target, { mode: 0o700 });
  const owned = lstatSync(target);
  try {
    await store.backup(join(target, "state.sqlite"));
    mkdirSync(join(target, "media"), { mode: 0o700 });
    for (const kind of mediaKinds) {
      const source = join(config.runtimeDataPath, "media", kind);
      if (existsSync(source)) copyTree(source, join(target, "media", kind));
    }
    const generated = join(config.runtimeDataPath, "generated");
    if (existsSync(generated)) copyTree(generated, join(target, "generated"));
    mkdirSync(join(target, "session-state"), { mode: 0o700 });
    const histories = join(config.runtimeHomePath, "session-state");
    if (existsSync(histories)) {
      checkedPath(histories, "directory");
      for (const name of readdirSync(histories)) {
        if (nativeSession.test(name)) copyTree(join(histories, name), join(target, "session-state", name));
      }
    }
    writeFileSync(join(target, "manifest.json"), JSON.stringify({ format: "densemble-backup", version: 1 }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    const current = lstatSync(target, { throwIfNoEntry: false });
    if (current?.dev === owned.dev && current.ino === owned.ino) rmSync(target, { recursive: true });
    throw error;
  }
}

export function restoreService(config: ServiceConfig, source: string): void {
  const snapshot = checkedPath(safeTarget(config, source), "directory");
  const manifestPath = checkedPath(join(snapshot, "manifest.json"), "file");
  if (lstatSync(manifestPath).size > 1024) throw new Error("BACKUP_MANIFEST_INVALID");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || !("format" in manifest) || manifest.format !== "densemble-backup" ||
    !("version" in manifest) || manifest.version !== 1) throw new Error("BACKUP_MANIFEST_INVALID");
  const database = checkedPath(join(snapshot, "state.sqlite"), "file");
  validateBackup(database);
  const stateTarget = join(config.runtimeDataPath, "state.sqlite");
  const mediaTarget = join(config.runtimeDataPath, "media");
  const generatedTarget = join(config.runtimeDataPath, "generated");
  const historiesTarget = join(config.runtimeHomePath, "session-state");
  for (const path of [stateTarget, `${stateTarget}-wal`, `${stateTarget}-shm`, mediaTarget, generatedTarget]) {
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("RESTORE_REQUIRES_EMPTY_DATA");
  }
  if (existsSync(historiesTarget)) {
    checkedPath(historiesTarget, "directory");
    if (readdirSync(historiesTarget).length) throw new Error("RESTORE_REQUIRES_EMPTY_NATIVE_HISTORY");
  }
  const histories = checkedPath(join(snapshot, "session-state"), "directory");
  for (const name of readdirSync(histories)) {
    if (!nativeSession.test(name) || basename(name) !== name) throw new Error("BACKUP_SESSION_INVALID");
  }
  const created: { path: string; dev: number; ino: number }[] = [];
  const record = (path: string) => () => {
    const stat = lstatSync(path);
    created.push({ path, dev: stat.dev, ino: stat.ino });
  };
  try {
    copyFile(database, stateTarget, record(stateTarget));
    copyTree(join(snapshot, "media"), mediaTarget, record(mediaTarget));
    if (existsSync(join(snapshot, "generated"))) {
      copyTree(join(snapshot, "generated"), generatedTarget, record(generatedTarget));
    }
    if (!existsSync(historiesTarget)) mkdirSync(historiesTarget, { mode: 0o700 });
    for (const name of readdirSync(histories)) {
      const path = join(historiesTarget, name);
      copyTree(join(histories, name), path, record(path));
    }
    chmodSync(stateTarget, 0o600);
  } catch (error) {
    for (const owned of created.reverse()) {
      const stat = lstatSync(owned.path, { throwIfNoEntry: false });
      if (stat?.dev === owned.dev && stat.ino === owned.ino) rmSync(owned.path, { recursive: stat.isDirectory() });
    }
    throw error;
  }
}
