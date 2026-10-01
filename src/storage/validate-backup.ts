import Database from "better-sqlite3";
import { checkedPath } from "../config/paths.js";
import { Connection, StateError } from "./database.js";

export function validateBackup(path: string): void {
  const database = new Database(checkedPath(path, "file"), { readonly: true, fileMustExist: true });
  const expected = new Connection(":memory:");
  try {
    const foreignKeyErrors = database.pragma("foreign_key_check");
    if (database.pragma("quick_check", { simple: true }) !== "ok" ||
      database.pragma("user_version", { simple: true }) !== expected.db.pragma("user_version", { simple: true }) ||
      !Array.isArray(foreignKeyErrors) || foreignKeyErrors.length) throw new StateError("BACKUP_DATABASE_INVALID");
    const schema = "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    if (JSON.stringify(database.prepare(schema).all()) !== JSON.stringify(expected.db.prepare(schema).all())) {
      throw new StateError("BACKUP_DATABASE_INVALID");
    }
  } finally { expected.db.close(); database.close(); }
}
