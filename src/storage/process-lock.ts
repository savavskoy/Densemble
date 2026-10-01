import { closeSync, constants, fchmodSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { checkedPath } from "../config/paths.js";
import { StateError } from "./database.js";

export interface ProcessLock {
  release(): void;
}

export function acquireProcessLock(directory: string): ProcessLock {
  const root = checkedPath(directory, "directory");
  const path = join(root, "instance.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const stat = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new StateError("UNSAFE_LOCK_PATH");
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  const database = new Database(path, { timeout: 0 });
  try {
    // SQLite's OS lock is released on process death; no stale PID reclamation race.
    database.pragma("locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    database.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL)");
    database.prepare("INSERT OR REPLACE INTO owner(id,pid) VALUES(1,?)").run(process.pid);
  } catch (error) {
    database.close();
    if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY") {
      throw new StateError("SERVICE_ALREADY_RUNNING");
    }
    throw new StateError("SERVICE_LOCK_FAILED");
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { database.exec("ROLLBACK"); } finally { database.close(); }
    },
  };
}
