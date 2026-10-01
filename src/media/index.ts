import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LoadedConfig } from "../config/index.js";
import { assertScope, scopeKey, type Attachment, type IncomingAttachment,
  type PreparedInput, type RunIdentity, type Scope } from "../domain.js";
import type { DiagnosticSink, MediaPreparation, StateStore } from "../ports.js";
import { createAudioTranscriber, type AudioSettings } from "./audio.js";
import { checkAbort, MediaError, mediaError } from "./errors.js";
import { extractFile, type ExtractionOptions } from "./extraction.js";
import { MEDIA_LIMITS } from "./limits.js";
import { checkedPath, deleteOwnedDirectory, displayName, exclusiveFile, lexicalPath, MANAGED_PATH,
  MARKER, newOwnedDirectory, OWNED_ID, privateDirectory, readBounded, within } from "./paths.js";
import { SerialQueue } from "./process.js";

export { MediaError, mediaMessages, type MediaErrorCode } from "./errors.js";
export { MEDIA_LIMITS } from "./limits.js";
export { checkAudioReadiness, type AudioSettings, type AudioReadiness } from "./audio.js";
export { runManagedProcess, type ProcessRunner, type ProcessOptions, type ProcessResult } from "./process.js";

export type MediaDownload = (botId: string, fileId: string, destination: string,
  signal: AbortSignal, maxBytes: number) => Promise<unknown>;
export interface MediaPaths { runtimeDataPath: string; workspacePath: string }
export interface MediaPipelineOptions {
  config: LoadedConfig | MediaPaths;
  store: StateStore;
  download: MediaDownload;
  diagnostics: DiagnosticSink;
  audio?: AudioSettings;
  extraction?: ExtractionOptions;
  now?: () => number;
}
export interface ResolvedAttachment { path: string; fileName: string; mimeType: string; sizeBytes: number }
export interface MediaPipeline extends MediaPreparation {
  resolveAttachment(scope: Scope, id: string, signal?: AbortSignal): Promise<ResolvedAttachment>;
  removeArtifacts(artifacts: Attachment[]): Promise<void>;
  releaseRun(identity: RunIdentity): void;
  generatedRunDirectory(identity: RunIdentity): Promise<string>;
}
interface Marker {
  version: 1;
  id: string;
  kind: "incoming" | "outgoing" | "audio";
  scope: Scope;
  sessionId: string | null;
  runId: string | null;
}

function runPin(identity: RunIdentity): string { return `media-run:${identity.runId}:${identity.generation}`; }
function sameScope(left: Scope, right: Scope): boolean { return scopeKey(left) === scopeKey(right); }
function safeScope(scope: Scope): void {
  try { assertScope(scope); } catch { throw new MediaError("MEDIA_SCOPE_INVALID"); }
}
function secretName(path: string): boolean {
  return path.split(/[\\/]/).some((part) => /^(?:\.env(?:\.|$)|secrets?(?:[._-]|$)|credentials?(?:[._-]|$)|config(?:[._-]|$)|private(?:[._-]|$)|(?:auth|tokens?|passwords?)(?:[._-]|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:ssh|copilot|aws|gnupg|git|npmrc|netrc|pypirc)$)/i.test(part) ||
    /(?:\.local\.|\.pem$|\.key$|\.p12$|\.pfx$|\.keystore$)/i.test(part));
}

export function createMediaPipeline(options: MediaPipelineOptions): MediaPipeline {
  const paths = "config" in options.config ? options.config.config : options.config;
  const runtime = lexicalPath(paths.runtimeDataPath);
  const workspace = lexicalPath(paths.workspacePath);
  if (within(runtime, workspace) || within(workspace, runtime)) throw new MediaError("MEDIA_PATH_UNSAFE");
  const root = join(runtime, "media");
  const store = options.store;
  const now = options.now ?? Date.now;
  const audio = createAudioTranscriber(options.audio);
  const extractionQueue = new SerialQueue();
  const active = new Set<string>();
  let ready: Promise<void> | undefined;
  const initialize = () => ready ??= (async () => {
    await checkedPath(runtime, "directory");
    await checkedPath(workspace, "directory");
    await privateDirectory(runtime, "media");
    for (const kind of ["incoming", "outgoing", "audio"]) await privateDirectory(root, kind);
  })();
  const live = (identity: RunIdentity, signal?: AbortSignal) => {
    if (signal) checkAbort(signal);
    safeScope(identity.scope);
    if (!store.runs.isLive(identity) || !store.sessions.get(identity.scope, identity.sessionId) ||
        !OWNED_ID.test(identity.sessionId) || !OWNED_ID.test(identity.runId)) throw new MediaError("MEDIA_STALE_RUN");
  };
  const report = (error: unknown): MediaError => {
    const safe = mediaError(error);
    options.diagnostics.record(safe.code);
    return safe;
  };
  const readMarker = async (directory: string): Promise<Marker> => {
    try {
      const marker = JSON.parse((await readBounded(join(directory, MARKER), 4096)).toString("utf8")) as Marker;
      if (marker.version !== 1 || !OWNED_ID.test(marker.id) || !["incoming", "outgoing", "audio"].includes(marker.kind) ||
          (marker.sessionId !== null && !OWNED_ID.test(marker.sessionId)) ||
          (marker.runId !== null && !OWNED_ID.test(marker.runId))) throw new MediaError("MEDIA_PATH_UNSAFE");
      safeScope(marker.scope);
      if (dirname(directory) !== join(root, marker.kind) || !OWNED_ID.test(basename(directory))) throw new MediaError("MEDIA_PATH_UNSAFE");
      return marker;
    } catch { throw new MediaError("MEDIA_PATH_UNSAFE"); }
  };
  const newDirectory = async (kind: Marker["kind"], scope: Scope, identity?: RunIdentity) => {
    await initialize();
    const directory = await newOwnedDirectory(join(root, kind), active);
    active.add(directory);
    const marker: Marker = { version: 1, id: randomUUID(), kind, scope,
      sessionId: identity?.sessionId ?? null, runId: identity?.runId ?? null };
    try { await exclusiveFile(join(directory, MARKER), JSON.stringify(marker)); }
    catch (error) {
      active.delete(directory);
      await deleteOwnedDirectory(directory, () => !active.has(directory));
      throw error;
    }
    return { directory, marker, path: join(directory, "payload") };
  };
  const download = async (attachment: IncomingAttachment, scope: Scope, path: string, signal: AbortSignal,
    guard: () => void = () => {}) => {
    checkAbort(signal);
    guard();
    if (!attachment.fileId || (attachment.sizeBytes !== undefined &&
        (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0))) throw new MediaError("MEDIA_MISMATCH");
    if ((attachment.sizeBytes ?? 0) > MEDIA_LIMITS.incomingBytes) throw new MediaError("MEDIA_TOO_LARGE");
    await checkedPath(dirname(path), "directory");
    try {
      await lstat(path);
      throw new MediaError("MEDIA_PATH_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MediaError("MEDIA_PATH_UNSAFE");
    }
    guard();
    try { await options.download(scope.botId, attachment.fileId, path, signal, MEDIA_LIMITS.incomingBytes); }
    catch (error) {
      checkAbort(signal);
      throw mediaError(error, "MEDIA_DOWNLOAD_FAILED");
    }
    checkAbort(signal);
    guard();
    await checkedPath(path, "file");
    const after = await lstat(path);
    guard();
    if (after.size > MEDIA_LIMITS.incomingBytes) throw new MediaError("MEDIA_TOO_LARGE");
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== after.size) throw new MediaError("MEDIA_MISMATCH");
  };
  const transcribe = async (attachment: IncomingAttachment, scope: Scope, signal: AbortSignal,
    guard: () => void = () => {}): Promise<string> => {
    safeScope(scope);
    if (attachment.kind !== "voice") throw new MediaError("MEDIA_UNSUPPORTED");
    return audio.run(signal, async () => {
      checkAbort(signal);
      guard();
      const owned = await newDirectory("audio", scope);
      try {
        guard();
        await download(attachment, scope, owned.path, signal, guard);
        guard();
        const extracted = await extractionQueue.run(signal, () => {
          guard();
          return extractFile(owned.path, attachment, signal, options.extraction);
        });
        guard();
        if (extracted.kind !== "audio") throw new MediaError("MEDIA_MISMATCH");
        const text = await audio.transcribe(owned.path, signal, guard);
        checkAbort(signal);
        guard();
        return text;
      } finally {
        try { await deleteOwnedDirectory(owned.directory); }
        finally { active.delete(owned.directory); }
      }
    });
  };
  const artifactDirectory = async (attachment: Attachment): Promise<string> => {
    const relativePath = attachment.relativePath;
    if (!MANAGED_PATH.test(relativePath) || !OWNED_ID.test(relativePath.split("/")[1]!)) throw new MediaError("MEDIA_PATH_UNSAFE");
    const path = join(root, relativePath);
    if (basename(path) !== "payload") throw new MediaError("MEDIA_PATH_UNSAFE");
    const marker = await readMarker(dirname(path));
    if (marker.id !== attachment.id || marker.sessionId !== attachment.sessionId || marker.runId !== attachment.runId ||
        !sameScope(marker.scope, attachment.scope) ||
        marker.kind !== ({ input: "incoming", output: "outgoing", audio: "audio" } as const)[attachment.kind]) {
      throw new MediaError("MEDIA_PATH_UNSAFE");
    }
    return dirname(path);
  };
  const registeredPath = async (attachment: Attachment): Promise<string> => {
    const directory = await artifactDirectory(attachment);
    return checkedPath(join(directory, "payload"), "file");
  };
  const missingDirectory = async (attachment: Attachment): Promise<boolean> => {
    if (!MANAGED_PATH.test(attachment.relativePath) || !OWNED_ID.test(attachment.relativePath.split("/")[1]!)) return false;
    const directory = dirname(join(root, attachment.relativePath));
    await checkedPath(dirname(directory), "directory");
    try { await lstat(directory); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  };
  const removeArtifacts = async (artifacts: Attachment[]): Promise<void> => {
    await initialize();
    for (const artifact of artifacts) {
      if (store.attachments.get(artifact.scope, artifact.id)) throw report(new MediaError("MEDIA_PATH_UNSAFE"));
      try {
        // Session deletion returns former rows. Do not accept live rows/pins as deletion authority.
        const directory = await artifactDirectory(artifact);
        if (active.has(directory)) throw new MediaError("MEDIA_PATH_UNSAFE");
        await deleteOwnedDirectory(directory);
      } catch (error) {
        // Missing files are idempotent; malformed paths and symlinks are not followed.
        if (await missingDirectory(artifact)) continue;
        throw report(error);
      }
    }
  };
  const pipeline: MediaPipeline = {
    async prepare(input, identity, signal) {
      const ownedPins = new Set<string>();
      try {
        live(identity, signal);
        const queued = input.status === "queued" && input.runId === null;
        if (!sameScope(input.scope, identity.scope) || input.sessionId !== identity.sessionId ||
            (!queued && input.runId !== identity.runId) ||
            !input.messages.every((message) => sameScope(message.scope, identity.scope))) {
          throw new MediaError("MEDIA_SCOPE_INVALID");
        }
        const messages = queued ? structuredClone(input.messages) : input.messages;
        const inputId = input.id;
        const createdAt = input.createdAt;
        const readyAt = input.readyAt;
        const mediaGroupId = input.mediaGroupId;
        const checkInput = () => {
          live(identity, signal);
          const current = store.inbox.get(identity.scope, inputId);
          if (!current || current.id !== inputId || current.sessionId !== identity.sessionId ||
              !sameScope(current.scope, identity.scope)) throw new MediaError("MEDIA_STALE_RUN");
          if (queued ? current.status !== "queued" || current.runId !== null || current.readyAt !== readyAt ||
              current.createdAt !== createdAt || current.mediaGroupId !== mediaGroupId || !isDeepStrictEqual(current.messages, messages) :
            current.status !== "reserved" || current.runId !== identity.runId) throw new MediaError("MEDIA_STALE_RUN");
        };
        checkInput();
        const prepared: PreparedInput = { text: "", images: [], attachmentIds: [], notices: [] };
        const append = (text: string) => {
          prepared.text += (prepared.text ? "\n\n" : "") + text;
          if (prepared.text.length > MEDIA_LIMITS.textCharacters) throw new MediaError("MEDIA_TEXT_TOO_LARGE");
        };
        for (const message of messages) {
          if (message.text) append(message.text);
          for (const attachment of message.attachments) {
            checkInput();
            if (attachment.kind === "voice") {
              const text = await transcribe(attachment, identity.scope, signal, checkInput);
              checkInput();
              append(`[Automatic voice transcription]\n${text}`);
              prepared.notices.push(`Automatically transcribed voice (you can correct it with a message):\n${text}`);
              continue;
            }
            const owned = await newDirectory("incoming", identity.scope, identity);
            let registered = false;
            try {
              checkInput();
              await download(attachment, identity.scope, owned.path, signal, checkInput);
              checkInput();
              const extraction = await extractionQueue.run(signal, () => {
                checkInput();
                return extractFile(owned.path, attachment, signal, options.extraction);
              });
              checkInput();
              const fileName = displayName(attachment.fileName, extraction.kind === "image" ? "image" : "document");
              if (extraction.kind === "text") append(`[Document: ${fileName}]\n${extraction.text!}`);
              else if (extraction.kind === "image") prepared.images.push({ path: owned.path, mimeType: extraction.mimeType, displayName: fileName });
              else throw new MediaError("MEDIA_UNSUPPORTED");
              await checkedPath(owned.path, "file");
              const fileStat = await stat(owned.path);
              checkInput();
              const createdAt = now();
              const record = store.attachments.add({ id: owned.marker.id, scope: identity.scope,
                sessionId: identity.sessionId, runId: identity.runId, kind: "input",
                relativePath: relative(root, owned.path), fileName, mimeType: extraction.mimeType, sizeBytes: fileStat.size,
                createdAt, expiresAt: createdAt + MEDIA_LIMITS.inputRetentionMs });
              registered = true;
              const pin = `${runPin(identity)}:${record.id}`;
              store.attachments.pin(identity.scope, record.id, pin);
              ownedPins.add(pin);
              prepared.attachmentIds.push(record.id);
            } finally {
              try { if (!registered) await deleteOwnedDirectory(owned.directory); }
              finally { active.delete(owned.directory); }
            }
          }
        }
        checkInput();
        if (!prepared.text.trim() && prepared.images.length === 0) throw new MediaError("MEDIA_EMPTY");
        return prepared;
      } catch (error) {
        for (const pin of ownedPins) store.attachments.unpin(pin);
        throw report(error);
      }
    },
    async transcribe(attachment, scope, signal) {
      try { return await transcribe(attachment, scope, signal); }
      catch (error) { throw report(error); }
    },
    async generatedRunDirectory(identity) {
      live(identity);
      await initialize();
      const generated = await privateDirectory(runtime, "generated");
      const session = await privateDirectory(generated, identity.sessionId);
      const run = await privateDirectory(session, identity.runId);
      live(identity);
      return run;
    },
    async exportFile(identity, source, signal) {
      let owned: Awaited<ReturnType<typeof newDirectory>> | undefined;
      let registered = false;
      try {
        live(identity, signal);
        if (secretName(source)) throw new MediaError("MEDIA_PATH_UNSAFE");
        const path = lexicalPath(source);
        const session = store.sessions.get(identity.scope, identity.sessionId)!;
        if (resolve(session.workspace) !== workspace) throw new MediaError("MEDIA_PATH_UNSAFE");
        const generated = join(runtime, "generated", identity.sessionId, identity.runId);
        if (!within(workspace, path) && !within(generated, path)) throw new MediaError("MEDIA_PATH_UNSAFE");
        await checkedPath(path, "file");
        live(identity, signal);
        const sourceHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await sourceHandle.stat();
          if (!before.isFile() || before.nlink !== 1) throw new MediaError("MEDIA_PATH_UNSAFE");
          if (before.size > MEDIA_LIMITS.outgoingBytes) throw new MediaError("MEDIA_TOO_LARGE");
          owned = await newDirectory("outgoing", identity.scope, identity);
          live(identity, signal);
          await exclusiveFile(owned.path);
          const destination = await open(owned.path, constants.O_WRONLY | constants.O_NOFOLLOW);
          try {
            const buffer = Buffer.alloc(64 * 1024);
            let copied = 0;
            for (;;) {
              live(identity, signal);
              const chunk = await sourceHandle.read(buffer, 0, buffer.length, copied);
              if (!chunk.bytesRead) break;
              copied += chunk.bytesRead;
              if (copied > MEDIA_LIMITS.outgoingBytes) throw new MediaError("MEDIA_TOO_LARGE");
              let written = 0;
              while (written < chunk.bytesRead) {
                const result = await destination.write(buffer, written, chunk.bytesRead - written, copied - chunk.bytesRead + written);
                written += result.bytesWritten;
              }
            }
            const after = await sourceHandle.stat();
            if (copied !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
                before.ctimeMs !== after.ctimeMs) throw new MediaError("MEDIA_PATH_UNSAFE");
          } finally { await destination.close(); }
          await checkedPath(path, "file");
          const latest = await lstat(path);
          if (latest.dev !== before.dev || latest.ino !== before.ino) throw new MediaError("MEDIA_PATH_UNSAFE");
          await checkedPath(owned.path, "file");
          live(identity, signal);
          const createdAt = now();
          const record = store.attachments.add({ id: owned.marker.id, scope: identity.scope,
            sessionId: identity.sessionId, runId: identity.runId, kind: "output",
            relativePath: relative(root, owned.path), fileName: displayName(basename(path), "export"),
            mimeType: "application/octet-stream", sizeBytes: before.size, createdAt,
            expiresAt: createdAt + MEDIA_LIMITS.inputRetentionMs });
          store.attachments.pin(identity.scope, record.id, `${runPin(identity)}:${record.id}`);
          registered = true;
          return record;
        } finally { await sourceHandle.close(); }
      } catch (error) { throw report(error); }
      finally {
        if (owned) {
          try { if (!registered) await deleteOwnedDirectory(owned.directory); }
          finally { active.delete(owned.directory); }
        }
      }
    },
    async resolveAttachment(scope, id, signal) {
      try {
        if (signal) checkAbort(signal);
        safeScope(scope);
        await initialize();
        const record = store.attachments.get(scope, id);
        if (!record || record.kind !== "output" || !store.sessions.get(scope, record.sessionId)) throw new MediaError("MEDIA_NOT_FOUND");
        if (record.runId) {
          const run = store.runs.get(scope, record.runId);
          if (!run || run.sessionId !== record.sessionId) throw new MediaError("MEDIA_SCOPE_INVALID");
        }
        const expired = record.expiresAt !== null && record.expiresAt <= now();
        if (expired && !store.outbox.pinnedAttachmentIds().includes(id)) throw new MediaError("MEDIA_NOT_FOUND");
        const path = await registeredPath(record);
        const file = await stat(path);
        if (file.size !== record.sizeBytes || file.size > MEDIA_LIMITS.outgoingBytes) throw new MediaError("MEDIA_PATH_UNSAFE");
        if (signal) checkAbort(signal);
        const current = store.attachments.get(scope, id);
        if (!current || current.sessionId !== record.sessionId || current.relativePath !== record.relativePath ||
            !store.sessions.get(scope, record.sessionId) ||
            (current.expiresAt !== null && current.expiresAt <= now() &&
              !store.outbox.pinnedAttachmentIds().includes(id))) throw new MediaError("MEDIA_NOT_FOUND");
        return { path, fileName: record.fileName, mimeType: record.mimeType, sizeBytes: record.sizeBytes };
      } catch (error) { throw report(error); }
    },
    removeArtifacts,
    releaseRun(identity) {
      safeScope(identity.scope);
      for (const attachment of store.attachments.list(identity.scope, identity.sessionId)) {
        if (attachment.runId === identity.runId) store.attachments.unpin(`${runPin(identity)}:${attachment.id}`);
      }
    },
    async cleanup() {
      await initialize();
      for (const artifact of store.attachments.expired(now())) {
        // Check before the transaction; removeExpired rechecks all pins.
        try {
          if (!await missingDirectory(artifact)) await artifactDirectory(artifact);
          if (active.has(dirname(join(root, artifact.relativePath)))) continue;
          const removed = store.attachments.removeExpired(artifact.id, now());
          if (removed) await removeArtifacts([removed]);
        } catch (error) { options.diagnostics.record(mediaError(error, "MEDIA_PATH_UNSAFE").code); }
      }
      for (const kind of ["incoming", "outgoing", "audio"] as const) {
        const category = await checkedPath(join(root, kind), "directory");
        for (const name of await readdir(category)) {
          if (!OWNED_ID.test(name)) continue;
          const directory = join(category, name);
          if (active.has(directory)) continue;
          try {
            const marker = await readMarker(directory);
            if (active.has(directory)) continue;
            if (kind !== "audio" && store.attachments.get(marker.scope, marker.id)) continue;
            await deleteOwnedDirectory(directory, () => !active.has(directory));
          } catch (error) { options.diagnostics.record(mediaError(error, "MEDIA_PATH_UNSAFE").code); }
        }
      }
    },
  };
  return pipeline;
}
