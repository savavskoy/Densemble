import { constants, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingAttachment, IncomingMessage, LogicalInput, Run, Scope } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { openStore } from "../../src/storage/index.js";
import { createMediaPipeline, MEDIA_LIMITS, MediaError, mediaMessages, type MediaPipeline, type MediaPipelineOptions } from "../../src/media/index.js";
import { extractFile } from "../../src/media/extraction.js";
import * as mediaPaths from "../../src/media/paths.js";

const scope: Scope = { ownerId: 111, botId: "synthetic", chatId: 111, topicId: null };
let root: string;
let workspace: string;
let runtime: string;
let store: StateStore;
let pipeline: MediaPipeline;
let run: Run;
let input: LogicalInput;
let clock: number;
const files = new Map<string, Buffer>();
const diagnostics = { record: vi.fn() };
const signal = () => new AbortController().signal;

function setup(options: Partial<MediaPipelineOptions> = {}): MediaPipeline {
  return createMediaPipeline({ config: { runtimeDataPath: runtime, workspacePath: workspace }, store,
    download: async (_bot, id, destination, abort, maxBytes) => {
      expect(maxBytes).toBe(20_000_000);
      abort.throwIfAborted();
      expect(existsSync(destination)).toBe(false);
      const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(files.get(id)!); } finally { await handle.close(); }
    }, diagnostics, now: () => clock, ...options });
}
function attach(bytes: Buffer | string, fileName: string, mimeType?: string, kind: IncomingAttachment["kind"] = "document"): IncomingAttachment {
  const fileId = randomUUID();
  files.set(fileId, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return { kind, fileId, fileName, ...(mimeType ? { mimeType } : {}) };
}
function prepare(attachments: IncomingAttachment[], text = "") {
  input.messages[0]!.attachments = attachments;
  input.messages[0]!.text = text;
  return pipeline.prepare(input, run, signal());
}

// Deliberately generated synthetic ZIP/PDF bytes, never private fixture documents.
function zip(entries: { name: string; text: string; compress?: boolean; encrypted?: boolean; declaredSize?: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.text);
    const compressed = entry.compress ? deflateRawSync(bytes) : bytes;
    const data = entry.encrypted ? Buffer.concat([Buffer.alloc(12), compressed]) : compressed;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(entry.compress ? 8 : 0, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    header.copy(record, 8, 6, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    local.push(header, name, data);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function docx(text = "Synthetic DOCX text", extra: Parameters<typeof zip>[0] = []): Buffer {
  return zip([
    { name: "[Content_Types].xml", text: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", text: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: "word/document.xml", text: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
    ...extra,
  ]);
}
function pdf(text = "Synthetic PDF text", encrypted = false): Buffer {
  const content = text ? `BT /F1 12 Tf 20 50 Td (${text}) Tj ET` : "q Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? "/Encrypt 6 0 R /ID [(synthetic)(synthetic)]" : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

beforeEach(() => {
  root = resolve(".cache", `media-unit-${randomUUID()}`);
  workspace = join(root, "workspace");
  runtime = join(root, "runtime");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runtime);
  store = openStore({ path: join(runtime, "state.sqlite") });
  const session = store.sessions.create(scope, { agentId: "synthetic", workspace, model: "synthetic-model" });
  const message: IncomingMessage = { kind: "message", scope, chatKind: "private", updateId: 1,
    messageId: 1, receivedAt: Date.now(), text: "", attachments: [] };
  const admission = store.inbox.admit(message, { sessionId: session.id, reserveRun: true });
  run = admission.run!;
  input = admission.input!;
  clock = Date.now();
  files.clear();
  diagnostics.record.mockClear();
  pipeline = setup();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("bounded document and image workers", () => {
  it.each([["note.txt", "text/plain"], ["note.md", "text/markdown"], ["table.csv", "text/csv"]])(
    "extracts strict UTF-8 %s and retains captions", async (name, mime) => {
      const result = await prepare([attach("Синтетичний текст\nrow,value", name!, mime)], "album caption");
      expect(result.text).toContain("album caption");
      expect(result.text).toContain("Синтетичний текст");
      expect(result.attachmentIds).toHaveLength(1);
      const record = store.attachments.get(scope, result.attachmentIds[0]!)!;
      expect(record.expiresAt! - record.createdAt).toBe(MEDIA_LIMITS.inputRetentionMs);
    });
  it.each([
    [Buffer.from([0xc3, 0x28]), "MEDIA_INVALID_UTF8"],
    [Buffer.from("text\0binary"), "MEDIA_INVALID_UTF8"],
    [Buffer.from("   "), "MEDIA_EMPTY"],
    [Buffer.alloc(0), "MEDIA_EMPTY"],
    [Buffer.from("x".repeat(MEDIA_LIMITS.textCharacters + 1)), "MEDIA_TEXT_TOO_LARGE"],
  ])("rejects invalid/empty/oversized text without silent truncation", async (bytes, code) => {
    await expect(prepare([attach(bytes as Buffer, "note.txt")])).rejects.toMatchObject({ code });
    expect(readdirSync(join(runtime, "media", "incoming"))).toEqual([]);
    expect(store.attachments.list(scope, run.sessionId)).toEqual([]);
  });
  it("uses mature PDF extraction and explicitly rejects image-only and corrupt PDF", async () => {
    const result = await prepare([attach(pdf(), "report.pdf", "application/pdf")]);
    expect(result.text).toContain("Synthetic PDF text");
    await expect(prepare([attach(pdf(""), "scan.pdf")])).rejects.toMatchObject({ code: "MEDIA_PDF_NO_TEXT" });
    await expect(prepare([attach("%PDF-corrupt", "broken.pdf")])).rejects.toMatchObject({ code: "MEDIA_CORRUPT" });
    await expect(prepare([attach(pdf("encrypted", true), "encrypted.pdf")])).rejects.toMatchObject({ code: "MEDIA_ENCRYPTED" });
  });
  it("extracts DOCX with ZIP preflight, rejecting corruption, encryption, macros and bombs", async () => {
    expect((await prepare([attach(docx(), "report.docx")])).text).toContain("Synthetic DOCX text");
    const invalid: [Buffer, string][] = [
      [Buffer.from("PK\x03\x04corrupt"), "MEDIA_CORRUPT"],
      [docx("text", [{ name: "word/vbaProject.bin", text: "macro" }]), "MEDIA_DOCX_UNSAFE"],
      [docx("text", [{ name: "secret", text: "encrypted", encrypted: true }]), "MEDIA_ENCRYPTED"],
      [docx("text", [{ name: "bomb", text: "a".repeat(200_000), compress: true }]), "MEDIA_DOCX_UNSAFE"],
      [docx("text", [{ name: "large", text: "x", compress: true, declaredSize: 100_000_000 }]), "MEDIA_DOCX_UNSAFE"],
      [docx("text", [{ name: "word/evil.xml", text: '<!DOCTYPE x [<!ENTITY x "boom">]><x/>' }]), "MEDIA_DOCX_UNSAFE"],
      [docx("text", [{ name: "../escape", text: "x" }]), "MEDIA_CORRUPT"],
    ];
    for (const [bytes, code] of invalid) await expect(prepare([attach(bytes, "bad.docx")])).rejects.toMatchObject({ code });
    const many = Array.from({ length: MEDIA_LIMITS.zipEntries + 1 }, (_, i) => ({ name: `entry-${i}`, text: "" }));
    await expect(prepare([attach(zip(many), "many.docx")])).rejects.toMatchObject({ code: "MEDIA_DOCX_UNSAFE" });
  }, 20_000);
  it.each(["png", "jpeg", "webp"] as const)("decodes actual %s image data and groups captions", async (format) => {
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#ff0000" } })[format]().toBuffer();
    input.messages.push({ ...input.messages[0]!, messageId: 2, text: "second caption",
      attachments: [attach(bytes, `second.${format}`, `image/${format}`, "photo")] });
    const result = await prepare([attach(bytes, `first.${format}`, `image/${format}`, "photo")], "first caption");
    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.mimeType).toBe(`image/${format}`);
    expect(result.text).toBe("first caption\n\nsecond caption");
    expect(result.images.every((image) => image.path.startsWith(join(runtime, "media", "incoming")))).toBe(true);
  });
  it("rejects image bombs, incomplete decodes, MIME/signature mismatch, unsupported files and byte mismatch", async () => {
    const valid = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const huge = Buffer.from(valid);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
    await expect(prepare([attach(huge, "huge.png")])).rejects.toMatchObject({ code: "MEDIA_IMAGE_UNSAFE" });
    await expect(prepare([attach(valid.subarray(0, 40), "broken.png")])).rejects.toMatchObject({ code: "MEDIA_IMAGE_UNSAFE" });
    await expect(prepare([attach(valid, "not.txt", "text/plain")])).rejects.toMatchObject({ code: "MEDIA_MISMATCH" });
    await expect(prepare([attach("not a PDF", "not.pdf")])).rejects.toMatchObject({ code: "MEDIA_MISMATCH" });
    await expect(prepare([attach("unsupported", "archive.zip")])).rejects.toMatchObject({ code: "MEDIA_UNSUPPORTED" });
    await expect(prepare([{ ...attach("text", "note.txt"), sizeBytes: 5 }])).rejects.toMatchObject({ code: "MEDIA_MISMATCH" });
    await expect(prepare([{ ...attach("x", "note.txt"), sizeBytes: MEDIA_LIMITS.incomingBytes + 1 }])).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    await expect(prepare([attach(Buffer.alloc(MEDIA_LIMITS.incomingBytes + 1), "note.txt")])).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });
  it("rejects an empty turn and aggregate text overflow rather than silently dropping sections", async () => {
    await expect(prepare([])).rejects.toMatchObject({ code: "MEDIA_EMPTY" });
    await expect(prepare([attach("x".repeat(100_000), "one.txt"), attach("y".repeat(100_000), "two.txt")]))
      .rejects.toMatchObject({ code: "MEDIA_TEXT_TOO_LARGE" });
    clock += MEDIA_LIMITS.inputRetentionMs + 1;
    await pipeline.cleanup();
    expect(store.attachments.list(scope, run.sessionId)).toEqual([]);
  });
  it("validates unnamed text uploads by their actual UTF-8 contents, not just the declared MIME", async () => {
    const file = attach("unnamed text", "", "text/plain");
    expect((await prepare([file])).text).toContain("unnamed text");
    await expect(prepare([attach(Buffer.from([0xc3, 0x28]), "", "text/plain")]))
      .rejects.toMatchObject({ code: "MEDIA_INVALID_UTF8" });
  });
  it("cancels a real worker and enforces bounded worker timeout without blocking the event loop", async () => {
    const path = join(root, "document.txt");
    writeFileSync(path, "synthetic");
    const abort = new AbortController();
    const pending = extractFile(path, attach("synthetic", "note.txt"), abort.signal);
    setImmediate(() => abort.abort());
    await expect(pending).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    await expect(extractFile(path, attach("synthetic", "note.txt"), signal(), { timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
  });
  it("does not inherit eval-only --input-type options into a file-based worker", async () => {
    const path = join(root, "note.txt");
    writeFileSync(path, "synthetic");
    const original = process.execArgv;
    try {
      process.execArgv = [...original, "--input-type=module"];
      await expect(extractFile(path, attach("synthetic", "note.txt"), signal())).resolves.toMatchObject({ text: "synthetic" });
    } finally { process.execArgv = original; }
  });
});

describe("durable queued steering preparation", () => {
  function enqueue(attachments: IncomingAttachment[], mediaGroupId?: string): LogicalInput {
    return store.inbox.admit({ ...input.messages[0]!, updateId: 2, messageId: 2,
      text: "queued steering caption", attachments, ...(mediaGroupId ? { mediaGroupId } : {}) },
    { sessionId: run.sessionId, albumDelayMs: 0, now: clock }).input!;
  }
  it("prepares an existing same-session queued input without assigning or consuming it", async () => {
    const queued = enqueue([attach("queued document", "steering.txt")]);
    const before = store.inbox.get(scope, queued.id);
    const attachToRun = vi.spyOn(store.inbox, "attachToRun");
    const reserve = vi.spyOn(store.inbox, "reserve");
    const result = await pipeline.prepare(queued, run, signal());
    expect(result.text).toContain("queued steering caption");
    expect(result.text).toContain("queued document");
    expect(store.inbox.get(scope, queued.id)).toEqual(before);
    expect(store.inbox.get(scope, queued.id)).toMatchObject({ status: "queued", runId: null });
    expect(attachToRun).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(store.inbox.attachToRun(run, queued.id)).toMatchObject({ status: "reserved", runId: run.runId });
  });
  it("rejects if the root completes during preparation and keeps the complete input queued", async () => {
    const queued = enqueue([attach("preserved document", "steering.txt")]);
    const before = store.inbox.get(scope, queued.id);
    pipeline = setup({ download: async (_bot, _id, path) => {
      await writeFile(path, "preserved document", { flag: "wx", mode: 0o600 });
      store.runs.complete(run, []);
    } });
    await expect(pipeline.prepare(queued, run, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(store.inbox.get(scope, queued.id)).toEqual(before);
    expect(store.inbox.queued(scope)).toContainEqual(before);
    expect(readdirSync(join(runtime, "media", "incoming"))).toEqual([]);
    expect(store.attachments.list(scope, run.sessionId)).toEqual([]);
    expect(store.inbox.reserve(scope, queued.id)).not.toBeNull();
  });
  it("rejects unknown, wrong-session, already-reserved and other-run inputs before downloading", async () => {
    const queued = enqueue([attach("queued document", "steering.txt")]);
    const download = vi.fn(async () => {});
    pipeline = setup({ download });
    await expect(pipeline.prepare({ ...queued, id: randomUUID() }, run, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    await expect(pipeline.prepare({ ...queued, sessionId: randomUUID() }, run, signal())).rejects.toMatchObject({ code: "MEDIA_SCOPE_INVALID" });
    await expect(pipeline.prepare({ ...queued, status: "reserved", runId: randomUUID() }, run, signal()))
      .rejects.toMatchObject({ code: "MEDIA_SCOPE_INVALID" });
    store.inbox.attachToRun(run, queued.id);
    await expect(pipeline.prepare(queued, run, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(download).not.toHaveBeenCalled();
  });
  it("rejects a queued input claimed by another continuation during download", async () => {
    const queued = enqueue([attach("queued document", "steering.txt")]);
    pipeline = setup({ download: async (_bot, _id, path) => {
      await writeFile(path, "queued document", { flag: "wx", mode: 0o600 });
      store.inbox.attachToRun(run, queued.id);
    } });
    await expect(pipeline.prepare(queued, run, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(store.inbox.get(scope, queued.id)).toMatchObject({ status: "reserved", runId: run.runId });
    expect(store.attachments.list(scope, run.sessionId)).toEqual([]);
  });
  it("rejects stale queued album snapshots without discarding newly admitted parts", async () => {
    const queued = enqueue([attach("queued document", "steering.txt")], "queued-album");
    pipeline = setup({ download: async (_bot, _id, path) => {
      await writeFile(path, "queued document", { flag: "wx", mode: 0o600 });
      store.inbox.admit({ ...queued.messages[0]!, updateId: 3, messageId: 3, text: "new album caption", attachments: [] },
        { sessionId: run.sessionId, albumDelayMs: 0, now: clock });
    } });
    await expect(pipeline.prepare(queued, run, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(store.inbox.get(scope, queued.id)).toMatchObject({ status: "queued", runId: null });
    expect(store.inbox.get(scope, queued.id)!.messages).toHaveLength(2);
    expect(store.inbox.get(scope, queued.id)!.messages[1]!.text).toBe("new album caption");
    expect(store.attachments.list(scope, run.sessionId)).toEqual([]);
  });
});

describe("ownership, export policy and lifecycle", () => {
  it("rechecks activity when preparation starts while cleanup is awaiting the ownership marker", async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const directoryVisible = deferred();
    const finishDirectoryCreation = deferred();
    const markerReadStarted = deferred();
    const finishMarkerRead = deferred();
    const downloadStarted = deferred();
    const finishDownload = deferred();
    let directory = "";
    let interceptedMarker = false;
    const actualRead = mediaPaths.readBounded;
    vi.spyOn(mediaPaths, "newOwnedDirectory").mockImplementation(async (category) => {
      // Deliberately reproduce the old mkdir-visible-before-active.add scheduling window.
      directory = join(category, randomUUID());
      mkdirSync(directory, { mode: 0o700 });
      directoryVisible.resolve();
      await finishDirectoryCreation.promise;
      return directory;
    });
    vi.spyOn(mediaPaths, "readBounded").mockImplementation(async (path, max) => {
      if (path === join(directory, mediaPaths.MARKER) && !interceptedMarker) {
        interceptedMarker = true;
        markerReadStarted.resolve();
        await finishMarkerRead.promise;
      }
      return actualRead(path, max);
    });
    pipeline = setup({ download: async (_bot, _id, path) => {
      await writeFile(path, "kept during preparation", { flag: "wx", mode: 0o600 });
      downloadStarted.resolve();
      await finishDownload.promise;
    } });
    const preparing = prepare([attach("kept during preparation", "race.txt")]);
    await directoryVisible.promise;
    const cleaning = pipeline.cleanup();
    await markerReadStarted.promise;
    finishDirectoryCreation.resolve();
    await downloadStarted.promise;
    finishMarkerRead.resolve();
    try {
      await cleaning;
      expect(readFileSync(join(directory, "payload"), "utf8")).toBe("kept during preparation");
      expect(existsSync(join(directory, mediaPaths.MARKER))).toBe(true);
    } finally { finishDownload.resolve(); }
    await expect(preparing).resolves.toMatchObject({ text: expect.stringContaining("kept during preparation") });
  });
  it("checks the cleanup deletion guard again after asynchronous path validation", async () => {
    const directory = join(root, "guarded");
    mkdirSync(directory);
    writeFileSync(join(directory, "payload"), "keep");
    let checks = 0;
    await mediaPaths.deleteOwnedDirectory(directory, () => ++checks < 3);
    expect(checks).toBe(3);
    expect(readFileSync(join(directory, "payload"), "utf8")).toBe("keep");
  });
  it("rechecks the deletion guard before subsequent files and preserves their ownership marker", async () => {
    const directory = join(root, "guarded-audio");
    mkdirSync(directory);
    for (const file of ["payload", "decoded.wav", "transcript.txt", mediaPaths.MARKER]) {
      writeFileSync(join(directory, file), "keep");
    }
    let checks = 0;
    await mediaPaths.deleteOwnedDirectory(directory, () => ++checks < 4);
    expect(existsSync(join(directory, "payload"))).toBe(false);
    for (const file of ["decoded.wav", "transcript.txt", mediaPaths.MARKER]) {
      expect(readFileSync(join(directory, file), "utf8")).toBe("keep");
    }
  });
  it("emits only fixed uppercase diagnostics and never forwards upstream exception text", async () => {
    for (const code of Object.keys(mediaMessages)) expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,95}$/);
    pipeline = setup({ download: async () => { throw new Error("synthetic upstream content must not be logged"); } });
    await expect(prepare([attach("text", "note.txt")])).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED" });
    expect(diagnostics.record.mock.calls).toEqual([["MEDIA_DOWNLOAD_FAILED"]]);
  });
  it("guards stale identity before IO and after downloads", async () => {
    const download = vi.fn(async () => {});
    const stale = { ...run, generation: run.generation + 1 };
    await expect(setup({ download }).prepare(input, stale, signal())).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(download).not.toHaveBeenCalled();
    pipeline = setup({ download: async (_bot, _id, path) => {
      await writeFile(path, "synthetic");
      store.runs.cancel(run);
    } });
    await expect(prepare([attach("synthetic", "file.txt")])).rejects.toMatchObject({ code: "MEDIA_STALE_RUN" });
    expect(readdirSync(join(runtime, "media", "incoming"))).toEqual([]);
  });
  it("never uses Telegram filenames as filesystem paths and rejects symlink downloads", async () => {
    const result = await prepare([attach("safe", "../../outside.txt")]);
    const record = store.attachments.get(scope, result.attachmentIds[0]!)!;
    expect(record.relativePath).toMatch(/^incoming\/[a-f0-9-]+\/payload$/);
    expect(record.fileName).not.toContain("/");
    pipeline = setup({ download: async (_bot, _id, path) => {
      symlinkSync(join(workspace, "target"), path);
    } });
    writeFileSync(join(workspace, "target"), "unchanged");
    await expect(prepare([attach("safe", "file.txt")])).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
    expect(readFileSync(join(workspace, "target"), "utf8")).toBe("unchanged");
  });
  it("rejects symlink ancestors, workspace overlap, hard links and unsafe export names", async () => {
    expect(() => createMediaPipeline({ config: { runtimeDataPath: workspace, workspacePath: workspace },
      store, download: vi.fn(), diagnostics })).toThrow(MediaError);
    const external = join(root, "outside.txt");
    writeFileSync(external, "outside");
    linkSync(external, join(workspace, "hardlink.txt"));
    symlinkSync(root, join(workspace, "linked"));
    for (const path of [external, join(workspace, "linked", "outside.txt"), join(workspace, "hardlink.txt"), `${workspace}/../outside.txt`]) {
      await expect(pipeline.exportFile(run, path, signal())).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
    }
    for (const name of ["secrets.local.json", ".env", ".env.production", "config.local.json", "private-config.json", "id_ed25519", "cert.pem", ".npmrc", ".netrc"]) {
      const path = join(workspace, name);
      writeFileSync(path, "never export");
      await expect(pipeline.exportFile(run, path, signal())).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
    }
    const linkedRuntime = join(root, "linked-runtime");
    symlinkSync(runtime, linkedRuntime);
    await expect(createMediaPipeline({ config: { runtimeDataPath: linkedRuntime, workspacePath: workspace },
      store, download: vi.fn(), diagnostics }).cleanup()).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
  });
  it("copies approved workspace or current generated-run exports, never deletes source files", async () => {
    const source = join(workspace, "report.txt");
    writeFileSync(source, "synthetic export");
    const record = await pipeline.exportFile(run, source, signal());
    const result = await pipeline.resolveAttachment(scope, record.id);
    expect(result.path).not.toBe(source);
    expect(readFileSync(result.path, "utf8")).toBe("synthetic export");
    expect(result.fileName).toBe("report.txt");
    await expect(pipeline.resolveAttachment({ ...scope, chatId: 112 }, record.id)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    const generated = await pipeline.generatedRunDirectory(run);
    writeFileSync(join(generated, "generated.txt"), "generated");
    await expect(pipeline.exportFile(run, join(generated, "generated.txt"), signal())).resolves.toMatchObject({ kind: "output" });
    pipeline.releaseRun(run);
    store.runs.finish(run, "succeeded");
    const deletion = store.sessions.delete(scope, run.sessionId)!;
    await pipeline.removeArtifacts(deletion.artifacts);
    expect(existsSync(result.path)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("synthetic export");
  });
  it("rejects files above the 50 MB export ceiling, cancelled exports, directories and live-row deletion", async () => {
    const path = join(workspace, "large.txt");
    const handle = await open(path, "wx");
    await handle.truncate(MEDIA_LIMITS.outgoingBytes + 1);
    await handle.close();
    await expect(pipeline.exportFile(run, path, signal())).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    await expect(pipeline.exportFile(run, workspace, signal())).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(pipeline.exportFile(run, path, cancelled.signal)).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    const prepared = await prepare([attach("text", "note.txt")]);
    const record = store.attachments.get(scope, prepared.attachmentIds[0]!)!;
    await expect(pipeline.removeArtifacts([record])).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
  });
  it("retains processing pins, expires input after seven days and retains uncertain outbox exports", async () => {
    const result = await prepare([attach("retained text", "note.txt")]);
    const id = result.attachmentIds[0]!;
    clock += MEDIA_LIMITS.inputRetentionMs + 1;
    await pipeline.cleanup();
    expect(store.attachments.get(scope, id)).not.toBeNull();
    await expect(pipeline.resolveAttachment(scope, id)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    pipeline.releaseRun(run);
    await pipeline.cleanup();
    expect(store.attachments.get(scope, id)).toBeNull();
    const source = join(workspace, "out.txt");
    writeFileSync(source, "outgoing");
    const record = await pipeline.exportFile(run, source, signal());
    const delivery = store.outbox.enqueue({ scope, sessionId: run.sessionId, runId: run.runId,
      dedupKey: "media-output", payload: { kind: "file", attachmentId: record.id }, attachmentIds: [record.id] });
    const attempt = store.outbox.claim()!;
    store.outbox.settle(delivery.id, attempt.attempts, { status: "uncertain" });
    pipeline.releaseRun(run);
    clock += MEDIA_LIMITS.inputRetentionMs + 1;
    await pipeline.cleanup();
    expect(store.attachments.get(scope, record.id)).not.toBeNull();
    await expect(pipeline.resolveAttachment(scope, record.id)).resolves.toMatchObject({ fileName: "out.txt" });
    store.outbox.discard(scope, delivery.id);
    await pipeline.cleanup();
    expect(store.attachments.get(scope, record.id)).toBeNull();
    expect(existsSync(source)).toBe(true);
  });
  it("rechecks path and size immediately before delivering a registered artifact", async () => {
    const source = join(workspace, "report.txt");
    writeFileSync(source, "text");
    const { id } = await pipeline.exportFile(run, source, signal());
    const resolved = await pipeline.resolveAttachment(scope, id);
    writeFileSync(resolved.path, "changed size");
    await expect(pipeline.resolveAttachment(scope, id)).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
    rmSync(resolved.path);
    const target = join(workspace, "target.txt");
    writeFileSync(target, "text");
    symlinkSync(target, resolved.path);
    await expect(pipeline.resolveAttachment(scope, id)).rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
  });
  it("only resolves explicitly registered outputs, not input files or arbitrary IDs", async () => {
    const result = await prepare([attach("text", "note.txt")]);
    await expect(pipeline.resolveAttachment(scope, result.attachmentIds[0]!)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    await expect(pipeline.resolveAttachment(scope, randomUUID())).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });
  it("cleans expired rows after files disappear and refuses forged cleanup paths", async () => {
    const result = await prepare([attach("retained", "file.txt")]);
    const record = store.attachments.get(scope, result.attachmentIds[0]!)!;
    rmSync(join(runtime, "media", record.relativePath));
    pipeline.releaseRun(run);
    clock += MEDIA_LIMITS.inputRetentionMs + 1;
    await pipeline.cleanup();
    expect(store.attachments.get(scope, record.id)).toBeNull();
    expect(readdirSync(join(runtime, "media", "incoming"))).toEqual([]);
    const result2 = await prepare([attach("retained", "file2.txt")]);
    const record2 = store.attachments.get(scope, result2.attachmentIds[0]!)!;
    rmSync(join(runtime, "media", record2.relativePath, ".."), { recursive: true });
    pipeline.releaseRun(run);
    clock += MEDIA_LIMITS.inputRetentionMs + 1;
    await pipeline.cleanup();
    expect(store.attachments.get(scope, record2.id)).toBeNull();
    const protectedFile = join(workspace, "keep.txt");
    writeFileSync(protectedFile, "keep");
    await expect(pipeline.removeArtifacts([{ ...record, relativePath: "../../workspace/keep.txt" }]))
      .rejects.toMatchObject({ code: "MEDIA_PATH_UNSAFE" });
    expect(readFileSync(protectedFile, "utf8")).toBe("keep");
  });
  it("cleans orphan artifacts after recovery without traversing workspace or foreign folders", async () => {
    const result = await prepare([attach("text", "note.txt")]);
    const record = store.attachments.get(scope, result.attachmentIds[0]!)!;
    pipeline.releaseRun(run);
    store.runs.finish(run, "succeeded");
    store.sessions.delete(scope, run.sessionId);
    const orphan = join(runtime, "media", record.relativePath);
    expect(existsSync(orphan)).toBe(true);
    const foreign = join(runtime, "media", "incoming", "not-owned");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.txt"), "foreign");
    writeFileSync(join(workspace, "keep.txt"), "workspace");
    store.recover();
    const restored = setup();
    await restored.cleanup();
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("foreign");
    expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe("workspace");
  });
});
