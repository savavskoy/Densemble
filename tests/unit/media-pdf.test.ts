import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDeflate } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extractFile } from "../../src/media/extraction.js";
import { MEDIA_LIMITS } from "../../src/media/limits.js";
import { boundedPdfium } from "../../src/media/pdf.js";

let root: string;
beforeEach(async () => {
  root = resolve(".cache", `media-pdf-${randomUUID()}`);
  await mkdir(root, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function pdfWithCompressedStream(compressed: Buffer): Buffer {
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),
      compressed, Buffer.from("\nendstream")]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let offset = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const encoded = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(encoded);
    offset += encoded.length;
  }
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((position) =>
    `${String(position).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
  return Buffer.concat(parts);
}

async function compressedWhitespace(megabytes: number): Promise<Buffer> {
  const compressor = createDeflate();
  const chunks: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(compressor, "end");
  const whitespace = Buffer.alloc(1024 * 1024, " ");
  for (let index = 0; index < megabytes; index++) {
    if (!compressor.write(whitespace)) await once(compressor, "drain");
  }
  compressor.end("BT /F1 12 Tf 20 50 Td (Synthetic bounded text) Tj ET");
  await ended;
  return Buffer.concat(chunks);
}

it("enforces the PDF engine's native linear-memory maximum, even bypassing its JS growth hook", async () => {
  const engine = await boundedPdfium(MEDIA_LIMITS.pdfMemoryBytes);
  engine.api.PDFiumExt_Init();
  try {
    const before = engine.memory.buffer.byteLength;
    const additionalPages = (MEDIA_LIMITS.pdfMemoryBytes - before) / 65_536 + 1;
    const nativeGrow = Object.getPrototypeOf(engine.memory).grow as (this: unknown, pages: number) => number;
    expect(() => nativeGrow.call(engine.memory, additionalPages)).toThrow(RangeError);
    expect(engine.memory.buffer.byteLength).toBe(before);
    engine.checkMemory();
  } finally { engine.api.FPDF_DestroyLibrary(); }
});

it("rejects a tiny one-page Flate bomb before decoded PDF memory can exceed the hard cap", async () => {
  // Reuse one 1 MiB chunk: generating the fixture never allocates its 129 MiB decoded stream.
  const compressed = await compressedWhitespace(129);
  const file = pdfWithCompressedStream(compressed);
  expect(file.length).toBeLessThan(150_000);
  const path = join(root, "synthetic-flate-bomb.pdf");
  await writeFile(path, file);
  await expect(extractFile(path, { kind: "document", fileId: "synthetic", fileName: "bomb.pdf" },
    new AbortController().signal)).rejects.toMatchObject({ code: "MEDIA_PDF_UNSAFE" });
}, 15_000);

it("still extracts ordinary compressed text PDFs using the same bounded engine", async () => {
  const path = join(root, "synthetic-compressed.pdf");
  await writeFile(path, pdfWithCompressedStream(await compressedWhitespace(1)));
  await expect(extractFile(path, { kind: "document", fileId: "synthetic", fileName: "compressed.pdf" },
    new AbortController().signal)).resolves.toMatchObject({ kind: "text", text: expect.stringContaining("Synthetic bounded text") });
});
