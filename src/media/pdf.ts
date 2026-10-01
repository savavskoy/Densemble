import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { MEDIA_LIMITS } from "./limits.js";

const WASM_SHA256 = "5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa";
const MEMORY_SECTION_OFFSET = 12_553;
const ORIGINAL_MEMORY_SECTION = Buffer.from("01019c02808002", "hex");
const WASM_PAGE_BYTES = 65_536;
const MAX_PDF_MEMORY_BYTES = 128 * 1024 * 1024;

interface WasmMemory {
  readonly buffer: ArrayBuffer;
  grow(pages: number): number;
}
export interface BoundedPdfium {
  api: WrappedPdfiumModule;
  memory: WasmMemory;
  checkMemory(): void;
}
function fail(code: string): never { throw new Error(code); }

/** Constrain the pinned engine, not PDF syntax: memory[0].maximum is enforced by WebAssembly itself. */
export async function boundedPdfium(memoryBytes: number): Promise<BoundedPdfium> {
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 284 * WASM_PAGE_BYTES ||
      memoryBytes > MAX_PDF_MEMORY_BYTES || memoryBytes % WASM_PAGE_BYTES !== 0) fail("MEDIA_PDF_UNSAFE");
  const binary = await readFile(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
  if (binary.length !== 4_646_932 || createHash("sha256").update(binary).digest("hex") !== WASM_SHA256 ||
      !binary.subarray(MEMORY_SECTION_OFFSET, MEMORY_SECTION_OFFSET + 7).equals(ORIGINAL_MEMORY_SECTION)) {
    fail("MEDIA_PDF_UNSAFE");
  }
  // The vendor's one defined wasm32 memory has initial=284 and maximum=32768 pages.
  // Keep the three-byte unsigned LEB128 field width; only lower its maximum.
  const pages = memoryBytes / WASM_PAGE_BYTES;
  binary[MEMORY_SECTION_OFFSET + 4] = (pages & 0x7f) | 0x80;
  binary[MEMORY_SECTION_OFFSET + 5] = ((pages >>> 7) & 0x7f) | 0x80;
  binary[MEMORY_SECTION_OFFSET + 6] = pages >>> 14;
  const { init } = await import("@embedpdf/pdfium");
  let memoryFault = false;
  const api = await init({ wasmBinary: Uint8Array.from(binary).buffer,
    print: () => {}, printErr: () => {}, onAbort: () => { memoryFault = true; } });
  const memory = (api.pdfium.wasmExports as unknown as { memory: WasmMemory }).memory;
  if (!memory || memory.buffer.byteLength > memoryBytes) fail("MEDIA_PDF_UNSAFE");
  const grow = memory.grow.bind(memory);
  // This hook only detects allocation failure, including parsers that recover with empty text.
  // It is NOT the ceiling: even direct native memory.grow cannot bypass the module's maximum.
  Object.defineProperty(memory, "grow", { value: (additionalPages: number) => {
    try { return grow(additionalPages); }
    catch (error) { memoryFault = true; throw error; }
  } });
  return { api, memory, checkMemory() {
    if (memoryFault || memory.buffer.byteLength > memoryBytes) fail("MEDIA_PDF_UNSAFE");
  } };
}

export async function extractPdf(bytes: Buffer, limits: typeof MEDIA_LIMITS): Promise<string> {
  const engine = await boundedPdfium(limits.pdfMemoryBytes);
  const { api } = engine;
  api.PDFiumExt_Init();
  let document = 0;
  let input = 0;
  try {
    input = api.pdfium.wasmExports.malloc(bytes.length);
    if (!input) fail("MEDIA_PDF_UNSAFE");
    api.pdfium.HEAPU8.set(bytes, input);
    document = api.FPDF_LoadMemDocument(input, bytes.length, "");
    engine.checkMemory();
    if (!document) {
      const error = api.FPDF_GetLastError();
      if (error === 4 || error === 5) fail("MEDIA_ENCRYPTED");
      fail("MEDIA_CORRUPT");
    }
    if (api.FPDF_GetSecurityHandlerRevision(document) !== -1) fail("MEDIA_ENCRYPTED");
    const pages = api.FPDF_GetPageCount(document);
    if (pages > limits.pdfPages) fail("MEDIA_TEXT_TOO_LARGE");
    if (pages <= 0) fail("MEDIA_CORRUPT");
    let text = "";
    for (let index = 0; index < pages; index++) {
      const page = api.FPDF_LoadPage(document, index);
      engine.checkMemory();
      if (!page) fail("MEDIA_CORRUPT");
      let textPage = 0;
      let output = 0;
      try {
        textPage = api.FPDFText_LoadPage(page);
        engine.checkMemory();
        if (!textPage) fail("MEDIA_CORRUPT");
        const count = api.FPDFText_CountChars(textPage);
        if (count < 0) fail("MEDIA_CORRUPT");
        if (text.length + count + 1 > limits.textCharacters) fail("MEDIA_TEXT_TOO_LARGE");
        if (!count) continue;
        output = api.pdfium.wasmExports.malloc((count + 1) * 2);
        if (!output) fail("MEDIA_PDF_UNSAFE");
        const written = api.FPDFText_GetText(textPage, 0, count, output);
        engine.checkMemory();
        if (written <= 0 || written > count + 1) fail("MEDIA_CORRUPT");
        const value = new TextDecoder("utf-16le", { fatal: true })
          .decode(api.pdfium.HEAPU8.subarray(output, output + (written - 1) * 2));
        if (value.includes("\0")) fail("MEDIA_CORRUPT");
        text += value + "\n";
      } finally {
        if (output) api.pdfium.wasmExports.free(output);
        if (textPage) api.FPDFText_ClosePage(textPage);
        api.FPDF_ClosePage(page);
      }
    }
    engine.checkMemory();
    if (!text.trim()) fail("MEDIA_PDF_NO_TEXT");
    return text;
  } catch (error) {
    engine.checkMemory();
    throw error;
  } finally {
    if (document) api.FPDF_CloseDocument(document);
    if (input) api.pdfium.wasmExports.free(input);
    api.FPDF_DestroyLibrary();
  }
}
