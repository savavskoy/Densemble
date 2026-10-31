import type { DiagnosticSink } from "../ports.js";

const scalarFields = new Set(["attempt", "count", "forced", "retryAfter", "externalOutcomeUnknown", "reason"]);
/** Module ids and health states only: fixed lowercase names, never paths or content. */
const nameFields = new Set(["module", "state"]);
const safeName = /^[a-z][a-z0-9-]{0,31}$/;

export function createDiagnostics(options: {
  botIds?: string[];
  write?: (line: string) => void;
} = {}): DiagnosticSink {
  const write = options.write ?? ((line: string) => { process.stderr.write(line); });
  const botIds = new Set(options.botIds ?? []);
  return {
    record(code, metadata) {
      const safe: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(metadata ?? {})) {
        if (key === "botId" && typeof value === "string" && botIds.has(value)) safe[key] = value;
        else if (scalarFields.has(key) && (value === null || typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)))) safe[key] = value;
        else if (nameFields.has(key) && typeof value === "string" && safeName.test(value)) safe[key] = value;
      }
      write(`${JSON.stringify({
        time: new Date().toISOString(),
        code: /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "UNSAFE_DIAGNOSTIC_CODE",
        ...safe,
      })}\n`);
    },
  };
}
