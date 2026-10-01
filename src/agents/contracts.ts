import type { Attachment, RunIdentity } from "../domain.js";
import type { AgentRuntime, RuntimeSessionOptions } from "../ports.js";

export interface ControlledSessionOptions extends RuntimeSessionOptions {
  signal?: AbortSignal;
  /** Proven by durable admission: no prior SDK turn can have run in this session. */
  emptyHistory?: boolean;
  exportFile?: (identity: RunIdentity, path: string, signal: AbortSignal) => Promise<Attachment>;
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
