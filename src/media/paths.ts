import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { MediaError } from "./errors.js";

export const OWNED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MARKER = ".densemble-media.json";
export const MANAGED_PATH = /^(incoming|outgoing|audio)\/[0-9a-f-]{36}\/(payload|decoded\.wav|transcript\.txt)$/;

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function lexicalPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || path.includes("\\") ||
      path.split("/").includes("..")) throw new MediaError("MEDIA_PATH_UNSAFE");
  return resolve(path);
}

/** Check each ancestor, not only realpath's final target. */
export async function checkedPath(path: string, kind: "file" | "directory"): Promise<string> {
  const absolute = lexicalPath(path);
  let cursor = parse(absolute).root;
  try {
    for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (cursor !== absolute && !stat.isDirectory())) throw new MediaError("MEDIA_PATH_UNSAFE");
    }
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
        await realpath(absolute) !== absolute) throw new MediaError("MEDIA_PATH_UNSAFE");
    return absolute;
  } catch { throw new MediaError("MEDIA_PATH_UNSAFE"); }
}

export async function privateDirectory(parent: string, name: string): Promise<string> {
  await checkedPath(parent, "directory");
  const path = join(parent, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new MediaError("MEDIA_PATH_UNSAFE");
  }
  return checkedPath(path, "directory");
}

export async function exclusiveFile(path: string, content?: string): Promise<void> {
  await checkedPath(resolve(path, ".."), "directory");
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { if (content !== undefined) await handle.writeFile(content); }
  finally { await handle.close(); }
}

export async function readBounded(path: string, max: number): Promise<Buffer> {
  await checkedPath(path, "file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new MediaError("MEDIA_TOO_LARGE");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const next = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (next.bytesRead === 0) break;
      bytes += next.bytesRead;
    }
    if (bytes !== stat.size || bytes > max) throw new MediaError("MEDIA_CORRUPT");
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

export async function newOwnedDirectory(category: string, active?: Set<string>): Promise<string> {
  await checkedPath(category, "directory");
  const directory = join(category, randomUUID());
  active?.add(directory);
  try {
    await mkdir(directory, { mode: 0o700 });
    return await checkedPath(directory, "directory");
  } catch (error) {
    active?.delete(directory);
    throw error;
  }
}

export async function deleteOwnedDirectory(directory: string, canDelete: () => boolean = () => true): Promise<void> {
  if (!canDelete()) return;
  await checkedPath(directory, "directory");
  if (!canDelete()) return;
  // Never recurse through a directory or touch filenames not created by this module.
  for (const name of ["payload", "decoded.wav", "transcript.txt", MARKER]) {
    const path = join(directory, name);
    try {
      await checkedPath(path, "file");
      if (!canDelete()) return;
      await unlink(path);
    } catch (error) {
      try { await lstat(path); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      throw error;
    }
  }
  if (!canDelete()) return;
  await rmdir(directory);
}

export function displayName(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  const cleaned = name.replace(/[\p{Cc}\p{Cf}/\\]/gu, "_").slice(0, 160);
  return cleaned.trim() || fallback;
}
