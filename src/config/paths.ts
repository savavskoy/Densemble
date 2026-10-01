import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ConfigError";
  }
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

export function checkedPath(path: string, kind: "file" | "directory" | "any"): string {
  const absolute = resolve(path);
  try {
    let cursor = absolute;
    while (true) {
      if (lstatSync(cursor).isSymbolicLink()) throw new ConfigError("SYMLINK_PATH_REJECTED");
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const actual = realpathSync.native(absolute);
    const stat = statSync(actual);
    if (kind === "file" ? !stat.isFile() : kind === "directory" ? !stat.isDirectory() : !stat.isFile() && !stat.isDirectory()) {
      throw new ConfigError("PATH_KIND_INVALID");
    }
    return actual;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("PATH_MISSING_OR_UNREADABLE");
  }
}

export function sourcePath(workspace: string, path: string, kind: "file" | "directory" | "any"): string {
  const actual = checkedPath(path, kind);
  if (!isWithin(workspace, actual)) throw new ConfigError("SOURCE_OUTSIDE_WORKSPACE");
  return actual;
}

export function assertDisjoint(a: string, b: string): void {
  if (isWithin(a, b) || isWithin(b, a)) throw new ConfigError("UNSAFE_PATH_OVERLAP");
}
