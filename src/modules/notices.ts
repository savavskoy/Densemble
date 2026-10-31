import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnosticSink } from "../ports.js";
import { isQuietHours, type QuietHoursConfig } from "../scheduling/quiet-hours.js";
import type { ModuleStateReport } from "./contract.js";
import type { ModuleHost } from "./host.js";
import { writeJsonAtomic } from "./state.js";

/** `"ok"` is the recovered (or never failed) state; any other value is the last failure code notified. */
export interface NoticeEntry {
  notified: string;
  pending?: { code: string; at: number };
}

/** `runtimeDataPath/modules/notices.json`; survives restarts so a lasting failure is notified once. */
export interface NoticeLedger {
  version: 1;
  modules: Record<string, NoticeEntry>;
}

export interface ModuleNoticesOptions {
  host: Pick<ModuleHost, "report" | "onChange" | "health" | "get">;
  /** `Application.notifyCoordinator`; absent when no coordinator is configured (then nothing is sent). */
  notify?: (text: string, dedupKey: string) => boolean;
  runtimeDataPath: string;
  quietHours: QuietHoursConfig;
  diagnostics: DiagnosticSink;
  intervalMs?: number;
  now?: () => number;
}

export interface ModuleNotices {
  /** One evaluation pass (serialized); resolves once the ledger is saved. */
  evaluate(): Promise<void>;
  stop(): Promise<void>;
}

const OK = "ok";

export function noticesPath(runtimeDataPath: string): string {
  return join(runtimeDataPath, "modules", "notices.json");
}

export async function readNoticeLedger(path: string): Promise<NoticeLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as NoticeLedger;
    if (parsed?.version !== 1 || typeof parsed.modules !== "object" || parsed.modules === null) return { version: 1, modules: {} };
    const modules: Record<string, NoticeEntry> = {};
    for (const [id, entry] of Object.entries(parsed.modules)) {
      if (typeof entry?.notified !== "string") continue;
      const pending = entry.pending;
      modules[id] = { notified: entry.notified,
        ...(typeof pending?.code === "string" && typeof pending.at === "number" ? { pending: { code: pending.code, at: pending.at } } : {}) };
    }
    return { version: 1, modules };
  } catch { return { version: 1, modules: {} }; }
}

/** Deterministic Ukrainian text: module id, cause and fix only (no settings, paths or content). */
export function noticeText(row: ModuleStateReport): string {
  if (row.state === "ready") return `Модуль «${row.id}» знову працює.`;
  const lines = [`Модуль «${row.id}» ${row.state === "failed" ? "аварійно зупинився" : "недоступний"}.`];
  if (row.cause) lines.push(`Причина: ${row.cause}`);
  if (row.fix) lines.push(`Що зробити: ${row.fix}`);
  return lines.join("\n");
}

/**
 * Coordinator notices (FR-026, SC-010): once per failure code on a transition into `unavailable`/`failed`,
 * once on recovery, deferred during quiet hours unless the module marks the reason `urgent`.
 * Disabled and starting modules never notify. Re-evaluated on every host change and every 60 s.
 */
export function startModuleNotices(options: ModuleNoticesOptions): ModuleNotices {
  const path = noticesPath(options.runtimeDataPath);
  const now = options.now ?? Date.now;
  let ledger: Promise<NoticeLedger> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  function urgent(row: ModuleStateReport): boolean {
    try { return options.host.get(row.id)?.definition?.reasons?.[row.code]?.urgent === true; } catch { return false; }
  }

  async function pass(): Promise<void> {
    const notify = options.notify;
    if (!notify || stopped) return;
    const current = await (ledger ??= readNoticeLedger(path));
    const at = now();
    const quiet = isQuietHours(at, options.quietHours);
    let changed = false;
    for (const row of options.host.report()) {
      if (stopped) break;
      if (row.state === "disabled" || row.state === "starting") continue;
      const desired = row.state === "ready" ? OK : row.code;
      const entry = current.modules[row.id];
      if (entry?.notified === desired) {
        if (entry.pending) { delete entry.pending; changed = true; }
        continue;
      }
      // Never failed (as far as notices go): nothing to recover from.
      if (desired === OK && entry === undefined) { current.modules[row.id] = { notified: OK }; changed = true; continue; }
      if (desired === OK && entry?.notified === OK) continue;
      if (quiet && !(desired !== OK && urgent(row))) {
        if (entry?.pending?.code !== desired) {
          current.modules[row.id] = { notified: entry?.notified ?? OK, pending: { code: desired, at } };
          changed = true;
        }
        continue;
      }
      const since = options.host.health(row.id)?.since ?? at;
      let sent = false;
      try { sent = notify(noticeText(row), `module:${row.id}:${desired}:${since}`); } catch { sent = false; }
      if (!sent) continue;
      options.diagnostics.record("MODULE_NOTICE_SENT", { module: row.id });
      current.modules[row.id] = { notified: desired };
      changed = true;
    }
    if (changed) {
      try { await writeJsonAtomic(path, current); } catch { options.diagnostics.record("MODULE_NOTICES_WRITE_FAILED"); }
    }
  }

  function evaluate(): Promise<void> {
    chain = chain.then(pass).catch(() => { options.diagnostics.record("MODULE_NOTICES_FAILED"); });
    return chain;
  }

  const unsubscribe = options.host.onChange(() => { void evaluate(); });
  const timer = setInterval(() => { void evaluate(); }, options.intervalMs ?? 60_000);
  timer.unref();
  void evaluate();
  return {
    evaluate,
    async stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      await chain;
    },
  };
}
