import { randomBytes } from "node:crypto";
import type { Json, PendingRequest, RequestAnswer, Scope } from "../domain.js";
import { scopeKey } from "../domain.js";

export function opaqueId(): string { return randomBytes(18).toString("base64url"); }

/** Secrets are removed before parameters reach either SQLite or Telegram. */
export function sanitizeParameters(value: unknown, secrets: readonly string[] = [], depth = 0): Json {
  if (depth > 8) return "[обсяг приховано]";
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join("[приховано]");
    return text
      .replace(/(authorization\s*:\s*)[^"'\r\n]+/gi, "$1[приховано]")
      .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [приховано]")
      .replace(/(["']?(?:token|password|secret|api[_-]?key|authorization)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[приховано]")
      .replace(/((?:--)(?:token|password|secret|api[_-]?key)\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[приховано]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[приховано]@")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[приховано]")
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[приховано]")
      .slice(0, 12_000);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeParameters(item, secrets, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key, /token|password|secret|authorization|cookie|api[_-]?key/i.test(key)
        ? "[приховано]" : sanitizeParameters(item, secrets, depth + 1),
    ]));
  }
  return "[непідтримувані дані]";
}

export class Controls<T> {
  private readonly entries = new Map<string, { scope: string; sessionId: string; expires: number; action: T }>();
  private readonly ttlMs: number;
  constructor(ttlMs = 10 * 60_000) { this.ttlMs = ttlMs; }
  add(scope: Scope, sessionId: string, action: T): string {
    this.prune();
    const id = opaqueId();
    this.entries.set(id, { scope: scopeKey(scope), sessionId, action, expires: Date.now() + this.ttlMs });
    return `c:${id}`;
  }
  take(scope: Scope, sessionId: string, data: string): T | null {
    const id = /^c:([A-Za-z0-9_-]{24})$/.exec(data)?.[1];
    if (!id) return null;
    const entry = this.entries.get(id);
    if (!entry || entry.scope !== scopeKey(scope) || entry.sessionId !== sessionId || entry.expires <= Date.now()) return null;
    this.entries.delete(id);
    return entry.action;
  }
  clear(): void { this.entries.clear(); }
  private prune(): void {
    for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id);
    if (this.entries.size > 10_000) this.entries.clear();
  }
}

export function currentField(request: PendingRequest): number {
  if (request.payload.kind !== "question") return -1;
  return request.payload.fields.findIndex((field) => !request.draft[field.id]?.length);
}

export function questionAnswer(request: PendingRequest, fieldIndex: number, values: string[]): RequestAnswer | null {
  if (request.payload.kind !== "question") return null;
  const field = request.payload.fields[fieldIndex];
  if (!field || !values.length || (!field.multiple && values.length !== 1) ||
      values.some((value) => !value.trim() || value.length > 12_000 ||
        (!field.allowFreeform && !field.choices.includes(value)))) return null;
  return { kind: "question", answers: { ...request.draft, [field.id]: [...new Set(values)] } };
}
