import { parentPort, workerData } from "node:worker_threads";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { crc32 } from "node:zlib";
import type { IncomingAttachment } from "../domain.js";
import type { MEDIA_LIMITS } from "./limits.js";
import type { Extraction } from "./extraction.js";

const { path, attachment, limits } = workerData as {
  path: string; attachment: IncomingAttachment; limits: typeof MEDIA_LIMITS;
};
function fail(code: string): never { throw new Error(code); }
function bounded(text: string, emptyCode = "MEDIA_EMPTY"): string {
  if (text.includes("\0")) fail("MEDIA_INVALID_UTF8");
  if (text.length > limits.textCharacters) fail("MEDIA_TEXT_TOO_LARGE");
  if (!text.trim()) fail(emptyCode);
  return text;
}
function utf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("MEDIA_INVALID_UTF8"); }
}

async function pdf(bytes: Buffer): Promise<string> {
  const module = await import(new URL(import.meta.url.endsWith(".ts") ? "./pdf.ts" : "./pdf.js", import.meta.url).href) as typeof import("./pdf.js");
  return module.extractPdf(bytes, limits);
}

async function docx(bytes: Buffer): Promise<string> {
  const { fromBufferPromise } = await import("yauzl");
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false,
    validateEntrySizes: true, strictFileNames: true });
  try {
    if (zip.entryCount > limits.zipEntries) fail("MEDIA_DOCX_UNSAFE");
    const entries = [];
    const names = new Set<string>();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName.toLowerCase();
      if (entry.isEncrypted()) fail("MEDIA_ENCRYPTED");
      total += entry.uncompressedSize;
      if (names.has(name) || entry.uncompressedSize > limits.zipEntryBytes ||
          total > limits.zipUncompressedBytes ||
          entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.zipCompressionRatio ||
          ![0, 8].includes(entry.compressionMethod) ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
          /(?:vbaproject|macro|activex|embeddings)(?:[/.]|$)/i.test(name)) fail("MEDIA_DOCX_UNSAFE");
      names.add(name);
      entries.push(entry);
      if (entries.length > limits.zipEntries) fail("MEDIA_DOCX_UNSAFE");
    }
    if (!names.has("[content_types].xml") || !names.has("word/document.xml")) fail("MEDIA_CORRUPT");
    // Validate every stream only after ALL central-directory resource limits passed.
    for (const entry of entries) {
      const header = await zip.readLocalFileHeaderPromise(entry);
      if (header.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
          header.compressionMethod !== entry.compressionMethod ||
          !header.fileName.equals(entry.fileNameRaw)) fail("MEDIA_DOCX_UNSAFE");
      const stream = await zip.openReadStreamPromise(entry);
      let size = 0;
      let checksum = 0;
      const xml: Buffer[] = [];
      for await (const chunk of stream) {
        const data = chunk as Buffer;
        size += data.length;
        if (size > entry.uncompressedSize || size > limits.zipEntryBytes) {
          stream.destroy();
          fail("MEDIA_DOCX_UNSAFE");
        }
        checksum = crc32(data, checksum);
        if (/\.(xml|rels)$/i.test(entry.fileName)) xml.push(data);
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) fail("MEDIA_CORRUPT");
      if (xml.length) {
        const content = utf8(Buffer.concat(xml));
        if (/<!DOCTYPE|<!ENTITY|macroEnabled|vbaProject|activeX/iu.test(content)) fail("MEDIA_DOCX_UNSAFE");
      }
    }
    const mammoth = (await import("mammoth")).default;
    // Buffer input and extractRawText never expose external file access or render HTML.
    const result = await mammoth.extractRawText({ buffer: bytes });
    if (result.messages.some((message) => message.type === "error")) fail("MEDIA_CORRUPT");
    return bounded(result.value);
  } finally { zip.close(); }
}

async function image(bytes: Buffer, mimeType: string): Promise<Extraction> {
  const sharp = (await import("sharp")).default;
  sharp.cache(false);
  sharp.concurrency(1);
  try {
    const source = sharp(bytes, { limitInputPixels: limits.imagePixels, failOn: "warning", animated: false });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height || metadata.width > limits.imageDimension ||
        metadata.height > limits.imageDimension || metadata.width * metadata.height > limits.imagePixels ||
        (metadata.pages ?? 1) > 1 || !["png", "jpeg", "webp"].includes(metadata.format)) fail("MEDIA_IMAGE_UNSAFE");
    await source.stats();
    return { kind: "image", mimeType };
  } catch { return fail("MEDIA_IMAGE_UNSAFE"); }
}

async function extract(): Promise<Extraction> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("MEDIA_PATH_UNSAFE");
    if (stat.size > limits.incomingBytes) fail("MEDIA_TOO_LARGE");
    bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) fail("MEDIA_MISMATCH");
    bytes = bytes.subarray(0, count);
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== count) fail("MEDIA_MISMATCH");
  } finally { await handle.close(); }
  if (!bytes.length) fail("MEDIA_EMPTY");
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  let detected: string | undefined;
  if (starts("89504e470d0a1a0a")) detected = "image/png";
  else if (starts("ffd8ff")) detected = "image/jpeg";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") detected = "image/webp";
  else if (bytes.toString("ascii", 0, 5) === "%PDF-") detected = "application/pdf";
  else if (starts("504b0304") || starts("504b0506")) detected = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  else if (bytes.toString("ascii", 0, 4) === "OggS") detected = "audio/ogg";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") detected = "audio/wav";
  else if (bytes.toString("ascii", 0, 4) === "fLaC") detected = "audio/flac";
  else if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) detected = "audio/mpeg";
  else if (bytes.toString("ascii", 4, 8) === "ftyp") detected = "audio/mp4";
  else if (starts("d0cf11e0a1b11e1")) fail("MEDIA_ENCRYPTED");
  const extension = extname(attachment.fileName ?? "").toLowerCase();
  const declared = attachment.mimeType?.toLowerCase().split(";")[0]?.trim();
  const generic = !declared || declared === "application/octet-stream";
  const extensions: Record<string, string[]> = {
    "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "audio/ogg": [".ogg", ".oga", ".opus"], "audio/wav": [".wav"],
    "audio/mpeg": [".mp3"], "audio/mp4": [".m4a", ".mp4"], "audio/flac": [".flac"],
  };
  if (detected) {
    const aliases: Record<string, string[]> = { "audio/ogg": ["audio/opus", "application/ogg"],
      "audio/wav": ["audio/x-wav", "audio/vnd.wave"], "audio/mp4": ["audio/x-m4a"] };
    if ((!generic && declared !== detected && !aliases[detected]?.includes(declared!)) ||
        (extension && !extensions[detected]?.includes(extension))) fail("MEDIA_MISMATCH");
    if (attachment.kind === "voice") {
      if (!detected.startsWith("audio/")) fail("MEDIA_MISMATCH");
      return { kind: "audio", mimeType: detected };
    }
    if (detected.startsWith("audio/")) fail("MEDIA_UNSUPPORTED");
    if (attachment.kind === "photo" && !detected.startsWith("image/")) fail("MEDIA_MISMATCH");
    if (detected.startsWith("image/")) return image(bytes, detected);
    return { kind: "text", mimeType: detected,
      text: detected === "application/pdf" ? await pdf(bytes) : await docx(bytes) };
  }
  if (attachment.kind !== "document") fail("MEDIA_MISMATCH");
  const textTypes: Record<string, string[]> = {
    ".txt": ["text/plain"], ".md": ["text/markdown", "text/x-markdown", "text/plain"],
    ".markdown": ["text/markdown", "text/x-markdown", "text/plain"], ".csv": ["text/csv", "application/csv", "text/plain"],
  };
  const textType = textTypes[extension] ?? (!extension && declared &&
    ["text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/csv"].includes(declared) ? [declared] : undefined);
  if (!textType || (!generic && !textType.includes(declared!))) {
    if ([".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)) fail("MEDIA_MISMATCH");
    fail("MEDIA_UNSUPPORTED");
  }
  return { kind: "text", mimeType: textType[0]!, text: bounded(utf8(bytes)) };
}

void extract().then(
  (result) => parentPort!.postMessage({ result }),
  (error: unknown) => parentPort!.postMessage({ error: error instanceof Error && /^MEDIA_[A-Z0-9_]+$/.test(error.message) ?
    error.message : "MEDIA_CORRUPT" }),
);
