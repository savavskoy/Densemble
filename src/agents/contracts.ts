import type {
  Attachment,
  ProactiveInitiator,
  ProactiveItem,
  ProactiveKind,
  ProactiveSchedule,
  ProactiveStatus,
  RunIdentity,
  Scope,
} from "../domain.js";
import type { AgentRuntime, RuntimeSessionOptions } from "../ports.js";

export interface ProactivityItemSummary {
  id: ProactiveItem["id"];
  kind: ProactiveKind;
  schedule: ProactiveSchedule;
  purpose: ProactiveItem["purpose"];
  initiator: ProactiveInitiator;
  status: ProactiveStatus;
  nextDueAt: ProactiveItem["nextDueAt"];
}
export type ProactivityRequest =
  | { action: "schedule"; kind: ProactiveKind; schedule: ProactiveSchedule; purpose: string }
  | { action: "list" }
  | { action: "cancel"; id: string }
  | { action: "pause" }
  | { action: "resume" };
export type ProactivityResponse =
  | { ok: true; action: "schedule"; item: ProactivityItemSummary; message: string }
  | { ok: true; action: "list"; items: ProactivityItemSummary[]; paused: boolean; message: string }
  | { ok: true; action: "cancel"; id: string; status: "cancelled"; message: string }
  | { ok: true; action: "pause"; paused: true; changed: boolean; message: string }
  | { ok: true; action: "resume"; paused: false; changed: boolean; message: string }
  | { ok: false; action: ProactivityRequest["action"]; code: string; message: string };
export interface ControlledSessionOptions extends RuntimeSessionOptions {
  signal?: AbortSignal;
  /** Proven by durable admission: no prior SDK turn can have run in this session. */
  emptyHistory?: boolean;
  exportFile?: (identity: RunIdentity, path: string, signal: AbortSignal) => Promise<Attachment>;
  proactivity?: (scope: Scope, agentId: string, request: ProactivityRequest) => Promise<ProactivityResponse>;
}
export interface ControlledRuntime extends AgentRuntime {
  open(options: ControlledSessionOptions): Promise<{ providerSessionId: string }>;
  recoverOwnedProcesses(): Promise<void>;
}
export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export async function bounded<T>(operation: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RuntimeError(code)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
