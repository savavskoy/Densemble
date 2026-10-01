import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { InputFile } from "grammy";
import type { Scope } from "../domain.js";
import { TelegramError, type TelegramApi } from "./common.js";
import { safeFileName } from "./normalize.js";

export const TELEGRAM_DOWNLOAD_LIMIT = 20_000_000;
export const TELEGRAM_UPLOAD_LIMIT = 50_000_000;
export interface ResolvedAttachment { path: string; fileName: string; mimeType: string }
export type AttachmentResolver = (scope: Scope, id: string) => ResolvedAttachment | Promise<ResolvedAttachment>;
export type DownloadFile = (botId: string, fileId: string, destination: string, signal: AbortSignal, maxBytes: number) => Promise<{ sizeBytes: number }>;

async function managedPath(root: string, path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new TelegramError("TG_FILE_PATH_REJECTED");
  const target = resolve(path);
  const inside = relative(root, target);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) throw new TelegramError("TG_FILE_PATH_REJECTED");
  for (let current = dirname(target); ; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TelegramError("TG_FILE_PATH_REJECTED");
    if (current === root) break;
    if (dirname(current) === current) throw new TelegramError("TG_FILE_PATH_REJECTED");
  }
  if (await realpath(root) !== root) throw new TelegramError("TG_FILE_PATH_REJECTED");
  return target;
}

function assertEmptyOwnedDestination(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0 || stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 || (process.geteuid && stat.uid !== process.geteuid())) {
    throw new TelegramError("TG_DESTINATION_REJECTED");
  }
}

export async function openUpload(root: string, attachment: ResolvedAttachment): Promise<{ file: InputFile; close(): Promise<void> }> {
  let handle: FileHandle | undefined;
  try {
    const path = await managedPath(root, attachment.path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    const current = await lstat(path);
    if (!stat.isFile() || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev) {
      throw new TelegramError("TG_FILE_PATH_REJECTED");
    }
    if (stat.size > TELEGRAM_UPLOAD_LIMIT) throw new TelegramError("TG_UPLOAD_TOO_LARGE");
    const owned = handle;
    let read = 0;
    const source = async function* () {
      for await (const chunk of owned.createReadStream({ autoClose: false })) {
        const bytes = chunk as Buffer;
        read += bytes.length;
        if (read > TELEGRAM_UPLOAD_LIMIT || read > stat.size) throw new TelegramError("TG_UPLOAD_TOO_LARGE");
        yield bytes;
      }
      if (read !== stat.size) throw new TelegramError("TG_FILE_CHANGED");
    };
    return { file: new InputFile(source(), safeFileName(attachment.fileName)), close: () => owned.close() };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error instanceof TelegramError ? error : new TelegramError("TG_FILE_UNAVAILABLE");
  }
}

export async function downloadTelegramFile(options: {
  api: TelegramApi; token: string; fileId: string; destination: string; root: string;
  signal: AbortSignal; maxBytes: number; fetch?: typeof fetch;
}): Promise<{ sizeBytes: number }> {
  let handle: FileHandle | undefined;
  let ownedPath: string | undefined;
  let ownedInode: { ino: number; dev: number } | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
  const abortRead = () => { void reader?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new TelegramError("TG_DOWNLOAD_LIMIT_INVALID");
    const max = Math.min(TELEGRAM_DOWNLOAD_LIMIT, options.maxBytes);
    const path = await managedPath(options.root, options.destination);
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) assertEmptyOwnedDestination(existing);
    const metadata = await options.api.getFile({ file_id: options.fileId }, signal);
    if (metadata.file_size !== undefined && metadata.file_size > max) throw new TelegramError("TG_DOWNLOAD_TOO_LARGE");
    const remote = metadata.file_path;
    if (!remote || !/^[A-Za-z0-9_./-]+$/.test(remote) || remote.startsWith("/") ||
        remote.split("/").some((part) => !part || part === "." || part === "..")) throw new TelegramError("TG_REMOTE_PATH_REJECTED");
    const response = await (options.fetch ?? fetch)(
      `https://api.telegram.org/file/bot${options.token}/${remote.split("/").map(encodeURIComponent).join("/")}`,
      { signal, redirect: "error" },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new TelegramError("TG_DOWNLOAD_HTTP_REJECTED");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
      await response.body.cancel();
      throw new TelegramError("TG_DOWNLOAD_TOO_LARGE");
    }
    reader = response.body.getReader();
    handle = await open(path, existing ? constants.O_WRONLY | constants.O_NOFOLLOW :
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (!existing) ownedPath = path;
    const stat = await handle.stat();
    if (existing) {
      assertEmptyOwnedDestination(stat);
      if (stat.ino !== existing.ino || stat.dev !== existing.dev) throw new TelegramError("TG_DESTINATION_REJECTED");
    }
    ownedInode = { ino: stat.ino, dev: stat.dev };
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new TelegramError("TG_DOWNLOAD_TOO_LARGE");
      let written = 0;
      while (written < next.value.byteLength) {
        signal.throwIfAborted();
        const result = await handle.write(next.value, written, next.value.byteLength - written);
        if (!result.bytesWritten) throw new TelegramError("TG_DOWNLOAD_WRITE_FAILED");
        written += result.bytesWritten;
      }
    }
    if (declared !== null && Number(declared) !== size) throw new TelegramError("TG_DOWNLOAD_TRUNCATED");
    signal.throwIfAborted();
    const finished = await handle.stat();
    const current = await lstat(path);
    if (finished.size !== size || finished.nlink !== 1 || current.isSymbolicLink() ||
        current.ino !== stat.ino || current.dev !== stat.dev) throw new TelegramError("TG_DESTINATION_CHANGED");
    await handle.sync();
    await handle.close();
    handle = undefined;
    ownedPath = undefined;
    return { sizeBytes: size };
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    if (ownedPath && ownedInode) {
      const stat = await lstat(ownedPath).catch(() => null);
      if (stat && !stat.isSymbolicLink() && stat.ino === ownedInode.ino && stat.dev === ownedInode.dev) {
        await unlink(ownedPath).catch(() => undefined);
      }
    }
    if (signal.aborted) throw new TelegramError("TG_DOWNLOAD_CANCELLED");
    throw error instanceof TelegramError ? error : new TelegramError("TG_DOWNLOAD_FAILED");
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader?.releaseLock();
  }
}
