import type { EngineId, Scope, Session } from "../domain.js";
import { scopeKey } from "../domain.js";
import type { ControlledRuntime } from "./contracts.js";
import { RuntimeError } from "./contracts.js";

export interface EngineRouterOptions {
  engines: Partial<Record<EngineId, ControlledRuntime>>;
  /** The engine recorded on a stored session; sessions never change engine. */
  sessionEngine(scope: Scope, sessionId: string): EngineId | undefined;
  recoverOwnedProcesses(): Promise<void>;
}

/** Dispatches every runtime call to the engine that owns the session; an engine never opens a foreign session. */
export function createEngineRouter(options: EngineRouterOptions): ControlledRuntime {
  const opened = new Map<string, { sessionId: string; engine: EngineId }>();
  function runtimeFor(engine: EngineId): ControlledRuntime {
    const runtime = options.engines[engine];
    if (!runtime) throw new RuntimeError(engine === "claude-code" ? "CLAUDE_CODE_NOT_CONFIGURED" : "ENGINE_NOT_CONFIGURED");
    return runtime;
  }
  function engineOf(scope: Scope, sessionId: string): EngineId | undefined {
    const known = opened.get(scopeKey(scope));
    return known?.sessionId === sessionId ? known.engine : options.sessionEngine(scope, sessionId);
  }
  const all = () => Object.values(options.engines).filter((runtime): runtime is ControlledRuntime => Boolean(runtime));
  return {
    recoverOwnedProcesses: () => options.recoverOwnedProcesses(),
    supportsSteering: (session: Session) => options.engines[session.engine]?.supportsSteering?.(session) ?? true,
    async open(supplied) {
      const result = await runtimeFor(supplied.session.engine).open(supplied);
      opened.set(scopeKey(supplied.session.scope), { sessionId: supplied.session.id, engine: supplied.session.engine });
      return result;
    },
    async execute(command) {
      const engine = engineOf(command.identity.scope, command.identity.sessionId);
      if (engine) return runtimeFor(engine).execute(command);
      if (command.kind !== "stop") throw new RuntimeError("RUNTIME_SESSION_NOT_OPEN");
      await Promise.all(all().map((runtime) => runtime.execute(command)));
    },
    async models(scope, sessionId) {
      const engine = engineOf(scope, sessionId);
      if (!engine) throw new RuntimeError("RUNTIME_SESSION_NOT_OPEN");
      return runtimeFor(engine).models(scope, sessionId);
    },
    async setModel(scope, sessionId, model) {
      const engine = engineOf(scope, sessionId);
      if (!engine) throw new RuntimeError("MODEL_BOUNDARY_REQUIRED");
      return runtimeFor(engine).setModel(scope, sessionId, model);
    },
    async disconnect(scope, sessionId) {
      // Each engine ignores scopes it does not own, so a release reaches whichever engine holds the slot.
      await Promise.all(all().map((runtime) => runtime.disconnect(scope, sessionId)));
      if (opened.get(scopeKey(scope))?.sessionId === sessionId) opened.delete(scopeKey(scope));
    },
    async deleteSession(scope, sessionId, providerSessionId, engine = "copilot") {
      await runtimeFor(engine).deleteSession(scope, sessionId, providerSessionId);
      if (opened.get(scopeKey(scope))?.sessionId === sessionId) opened.delete(scopeKey(scope));
    },
    async shutdown() {
      const results = await Promise.allSettled(all().map((runtime) => runtime.shutdown()));
      if (results.some((result) => result.status === "rejected")) throw new RuntimeError("RUNTIME_SHUTDOWN_UNCONFIRMED");
    },
  };
}
