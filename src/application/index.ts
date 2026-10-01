import { isAbsolute, resolve } from "node:path";
import { authorizeScope, discoverAgents } from "../config/index.js";
import type { LoadedConfig } from "../config/index.js";
import type {
  Attachment, DeliveryPayload, IncomingCallback, IncomingMessage, LogicalInput, ModelInfo,
  PendingRequest, RequestAnswer, Run, RunIdentity, RuntimeEvent, Scope, Session,
} from "../domain.js";
import { scopeKey } from "../domain.js";
import type {
  AgentRuntime, DeliveryTransport, DiagnosticSink, IngressHandler, MediaPreparation, Recovery, StateStore,
} from "../ports.js";
import type { ControlledSessionOptions } from "../agents/contracts.js";
import { bounded, RuntimeError } from "../agents/contracts.js";
import { Controls, currentField, opaqueId, questionAnswer, sanitizeParameters } from "../permissions/index.js";
import type { MenuPayload } from "./menu.js";
import { DeletionJournal } from "./deletion.js";
import type { DeletionIntent } from "./deletion.js";
import { failureCode, failureMessage, mediaNotice } from "./messages.js";

export interface ApplicationMedia extends MediaPreparation {
  releaseRun(identity: RunIdentity): void;
  removeArtifacts(artifacts: Attachment[]): Promise<void>;
}

export interface ApplicationOptions {
  config: LoadedConfig;
  store: StateStore;
  runtime: AgentRuntime;
  media: ApplicationMedia;
  delivery: DeliveryTransport;
  diagnostics: DiagnosticSink;
  albumDelayMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  idleReleaseMs?: number;
  refreshAgents?: boolean;
  /** @deprecated Delivery is always transport-owned; retained for bootstrap compatibility. */
  deferDelivery?: true;
}
export interface Application extends IngressHandler {
  start(recovery?: Recovery): Promise<void>;
  recover(recovery: Recovery): void;
  shutdown(): Promise<void>;
  /** Wait for admitted work; useful for shutdown/tests, never the polling loop. */
  drain(): Promise<void>;
}
type Action =
  | { kind: "stop"; identity: RunIdentity }
  | { kind: "models"; page: number }
  | { kind: "model"; model: string }
  | { kind: "cancel-model"; model: string }
  | { kind: "sessions"; page: number }
  | { kind: "resume"; sessionId: string }
  | { kind: "delete"; sessionId: string; confirmed: boolean }
  | { kind: "request"; requestId: string; choice?: string; field?: number; approved?: boolean; done?: boolean; cancel?: boolean }
  | { kind: "recovery"; resume: boolean }
  | { kind: "retry"; outboxId: string; confirmed: boolean };
type Context = {
  run: Run; controller: AbortController; jobs: Set<Promise<unknown>>; exports: Attachment[];
  stopping?: Promise<void>; preparingSteer: boolean; failureCode?: string; requestIds: Set<string>; stopForced?: boolean;
};
type Barrier = { controller: AbortController; promise: Promise<void>; runtimeSessionId: string };

const runLabels: Record<string, string> = {
  preparing: "підготовка вкладень", running: "працює", waiting: "очікує відповіді",
  cancelling: "зупиняється", succeeded: "завершено", failed: "помилка", cancelled: "зупинено", interrupted: "перервано",
};
const help = "Команди: /help, /status, /model, /new, /sessions, /stop.\n" +
  "У цій розмові працює закріплений агент. Уточнення під час роботи передаються активному виконанню. " +
  "На запитання відповідайте кнопками або відповіддю на повідомлення форми. Дозволи — лише кнопками.\n" +
  "/stop не відкочує зовнішні дії.";

export function createApplication(options: ApplicationOptions): Application {
  const { config, store, runtime, media, delivery, diagnostics } = options;
  const controls = new Controls<Action>();
  const contexts = new Map<string, Context>();
  const barriers = new Map<string, Barrier>();
  const held = new Set<string>();
  const jobs = new Set<Promise<unknown>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const lastRuns = new Map<string, RunIdentity>();
  const requestFields = new Map<string, number>();
  const runtimeFaults = new Map<string, string>();
  const deletionJournal = new DeletionJournal(config.config.runtimeDataPath);
  let stopped = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  let started = false;
  let ticker: NodeJS.Timeout | undefined;

  function launch(work: Promise<unknown>, context?: Context): void {
    const guarded = work.catch(() => diagnostics.record("APPLICATION_BACKGROUND_FAILED"));
    jobs.add(guarded); context?.jobs.add(guarded);
    void guarded.finally(() => { jobs.delete(guarded); context?.jobs.delete(guarded); });
  }
  function live(identity: RunIdentity): boolean {
    return !stopped && !closing && !contexts.get(identity.runId)?.controller.signal.aborted && store.runs.isLive(identity);
  }
  function current(scope: Scope): Session {
    const existing = store.sessions.current(scope);
    if (existing) return existing;
    return createSession(scope);
  }
  function createSession(scope: Scope): Session {
    const bot = config.config.bots.find((entry) => entry.id === scope.botId);
    const agents = options.refreshAgents === false ? config.agents : discoverAgents(config.config);
    if (options.refreshAgents !== false) config.agents = agents;
    const agent = agents.find((entry) => entry.id === bot?.agentId && entry.userInvocable);
    if (!agent) throw new RuntimeError("AGENT_CONFIGURATION_INVALID");
    return store.sessions.create(scope, { agentId: agent.id, workspace: config.config.workspacePath, model: agent.defaultModel });
  }
  function text(session: Session, value: string, key = opaqueId(), runId?: string): void {
    store.outbox.enqueue({ scope: session.scope, sessionId: session.id, dedupKey: key,
      payload: { kind: "text", text: value }, ...(runId ? { runId } : {}) });
  }
  function menu(session: Session, value: string, rows: { text: string; action: Action }[][], key = opaqueId(), requestId = ""): void {
    const buttons = rows.map((row) => row.map((button) => ({
        text: button.text, data: controls.add(session.scope, `${session.id}:${session.generation}`, button.action),
      })));
    const payload: DeliveryPayload | MenuPayload = requestId
      ? { kind: "request", requestId, text: value, buttons }
      : { kind: "text", text: value, buttons };
    store.outbox.enqueue({ scope: session.scope, sessionId: session.id, dedupKey: key, payload });
  }
  function reportFailure(session: Session, code: string, runId?: string): void {
    runtimeFaults.set(scopeKey(session.scope), code);
    diagnostics.record(code);
    text(session, failureMessage(code), runId ? `run:${runId}:error` : opaqueId(), runId);
  }
  function sessionFor(identity: RunIdentity): Session | null { return store.sessions.get(identity.scope, identity.sessionId); }
  function runControl(run: Run): void {
    const session = sessionFor(run);
    if (session) menu(session, "Виконання прийнято. Результат ще не готовий.",
      [[{ text: "Зупинити", action: { kind: "stop", identity: run } }]], `run:${run.runId}:control`);
  }
  async function exportFile(identity: RunIdentity, path: string, signal: AbortSignal): Promise<Attachment> {
    const context = contexts.get(identity.runId);
    if (!context || !live(identity)) throw new RuntimeError("EXPORT_STALE_RUN");
    const combined = AbortSignal.any([signal, context.controller.signal]);
    const work = (async () => {
      const session = sessionFor(identity);
      if (!session) throw new RuntimeError("EXPORT_STALE_RUN");
      const source = isAbsolute(path) ? path : resolve(session.workspace, path);
      const attachment = await media.exportFile(identity, source, combined);
      if (!live(identity) || combined.aborted || attachment.sessionId !== identity.sessionId ||
          scopeKey(attachment.scope) !== scopeKey(identity.scope) || attachment.runId !== identity.runId) {
        throw new RuntimeError("EXPORT_STALE_RUN");
      }
      context.exports.push(attachment);
      return attachment;
    })();
    context.jobs.add(work);
    try { return await work; } finally { context.jobs.delete(work); }
  }
  async function open(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const control = barriers.get(scopeKey(session.scope));
    if (control) control.runtimeSessionId = session.id;
    const active = store.runs.active(session.scope);
    const emptyHistory = session.generation === 0 || (session.generation === 1 &&
      active?.sessionId === session.id && active.generation === 1 && active.status === "preparing");
    const supplied: ControlledSessionOptions = { session, signal, emptyHistory, onEvent, exportFile };
    const result = await runtime.open(supplied);
    signal.throwIfAborted();
    if (!store.sessions.setProviderSessionId(session.scope, session.id, result.providerSessionId)) {
      throw new RuntimeError("SESSION_PROVIDER_CONFLICT");
    }
  }
  function notices(session: Session, values: string[], identity: RunIdentity): void {
    values.forEach((value, index) => {
      if (live(identity)) text(session, mediaNotice(value), `run:${identity.runId}:notice:${opaqueId()}:${index}`, identity.runId);
    });
  }
  function pump(scope: Scope): void {
    if (stopped || closing || barriers.has(scopeKey(scope)) || held.has(scopeKey(scope))) return;
    if ([...contexts.values()].some((context) => scopeKey(context.run.scope) === scopeKey(scope) &&
        !store.runs.isLive(context.run))) return;
    const session = store.sessions.current(scope);
    if (!session) return;
    const active = store.runs.active(scope);
    if (active) {
      const context = contexts.get(active.runId);
      if (context && active.status !== "preparing" && active.status !== "cancelling" && !context.preparingSteer) {
        launch(steer(context), context);
      }
      return;
    }
    if (session.pendingModel) { switchModel(session, session.pendingModel); return; }
    const input = store.inbox.queued(scope).find((entry) => entry.sessionId === session.id);
    if (!input) { releaseIdle(session); return; }
    clearTimeout(idleTimers.get(scopeKey(scope)));
    if (input.readyAt > Date.now()) {
      clearTimeout(timers.get(scopeKey(scope)));
      timers.set(scopeKey(scope), setTimeout(() => { timers.delete(scopeKey(scope)); pump(scope); }, input.readyAt - Date.now() + 1));
      return;
    }
    const run = store.inbox.reserve(scope, input.id);
    if (!run) return;
    const context: Context = { run, controller: new AbortController(), jobs: new Set(), exports: [],
      preparingSteer: false, requestIds: new Set() };
    contexts.set(run.runId, context); runControl(run);
    const reserved = store.inbox.get(scope, input.id);
    if (!reserved) { launch(failRun(context, "INPUT_MISSING")); return; }
    launch(executeInput(context, reserved), context);
  }
  async function executeInput(context: Context, input: LogicalInput): Promise<void> {
    const { run, controller } = context;
    const session = sessionFor(run);
    if (!session) return;
    try {
      if (!live(run)) return;
      const prepared = await media.prepare(input, run, controller.signal);
      if (!live(run)) return;
      notices(session, prepared.notices, run);
      await open(session, controller.signal);
      if (!live(run)) return;
      if (prepared.images.length) {
        const model = (await runtime.models(run.scope, run.sessionId)).find((entry) => entry.id === session.appliedModel);
        if (!live(run)) return;
        if (!model?.supportsImages) throw new RuntimeError("MODEL_IMAGES_UNSUPPORTED");
      }
      if (!store.runs.markRunning(run)) return;
      await runtime.execute({ kind: "send", identity: run, input: prepared });
      if (live(run)) pump(run.scope);
    } catch (error) {
      if (live(run)) {
        const code = failureCode(error);
        launch(failRun(context, code));
      }
    }
  }
  async function steer(context: Context): Promise<void> {
    if (context.preparingSteer || !live(context.run)) return;
    const input = store.inbox.queued(context.run.scope).find((entry) => entry.sessionId === context.run.sessionId);
    if (!input) return;
    if (input.readyAt > Date.now()) {
      const key = scopeKey(context.run.scope);
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => { timers.delete(key); pump(context.run.scope); }, input.readyAt - Date.now() + 1));
      return;
    }
    context.preparingSteer = true;
    try {
      const prepared = await media.prepare(input, context.run, context.controller.signal);
      if (!live(context.run)) return; // Still queued: the next turn can claim it.
      const session = sessionFor(context.run)!;
      notices(session, prepared.notices, context.run);
      if (prepared.images.length) {
        const model = (await runtime.models(session.scope, session.id)).find((entry) => entry.id === session.appliedModel);
        if (!live(context.run)) return;
        if (!model?.supportsImages) {
          text(session, "Поточна модель не підтримує зображення. Зупиніть виконання, оберіть модель через /model і надішліть фото знову.");
          throw new RuntimeError("MODEL_IMAGES_UNSUPPORTED");
        }
      }
      if (!store.inbox.attachToRun(context.run, input.id)) return;
      await runtime.execute({ kind: "steer", identity: context.run, input: prepared });
      if (live(context.run)) text(session,
        "Уточнення передано активному виконанню; уже виконані дії не змінюються.", `steer:${input.id}`);
    } catch {
      if (live(context.run)) {
        text(sessionFor(context.run)!, "Уточнення не підтверджено. Зупиняю виконання, щоб уникнути повторної дії.");
        launch(stopRun(context.run), undefined);
      }
    } finally {
      context.preparingSteer = false;
      pump(context.run.scope);
    }
  }
  async function failRun(context: Context, code: string): Promise<void> {
    const session = sessionFor(context.run);
    if (!session) return;
    // Do not release the live slot while an errored send may still be executing.
    context.failureCode = code;
    try { reportFailure(session, code, context.run.runId); } catch { diagnostics.record("FAILURE_DELIVERY_PERSIST_FAILED"); }
    await stopRun(context.run);
  }
  function finishContext(context: Context): void {
    context.controller.abort();
    lastRuns.set(scopeKey(context.run.scope), context.run);
    for (const id of context.requestIds) requestFields.delete(id);
    if (delivery.invalidatePreview) launch(delivery.invalidatePreview(context.run));
    launch(Promise.allSettled([...context.jobs]).then(() => {
      media.releaseRun(context.run);
      contexts.delete(context.run.runId);
      pump(context.run.scope);
    }));
  }
  function onEvent(event: RuntimeEvent): void {
    try { acceptEvent(event); }
    catch {
      diagnostics.record("RUNTIME_EVENT_PERSIST_FAILED");
      const context = contexts.get(event.runId);
      if (context && live(context.run)) launch(failRun(context, "RESULT_PERSIST_FAILED"));
    }
  }
  function acceptEvent(event: RuntimeEvent): void {
    const context = contexts.get(event.runId);
    if (!context || context.run.generation !== event.generation ||
        context.run.sessionId !== event.sessionId || scopeKey(context.run.scope) !== scopeKey(event.scope)) return;
    if (event.kind === "stopped") {
      context.stopForced = event.forced;
      if (live(event)) launch(failRun(context, "RUNTIME_INTERRUPTED"));
      return;
    }
    if (!live(event)) return;
    const session = sessionFor(event)!;
    switch (event.kind) {
      case "delta":
        launch(delivery.preview(event, event.text).catch(() => diagnostics.record("PREVIEW_FAILED")));
        break;
      case "status": text(session, event.status, opaqueId(), event.runId); break;
      case "request": {
        const payload = event.payload.kind === "permission" ? { ...event.payload,
          parameters: sanitizeParameters(event.payload.parameters) } : event.payload;
        try {
          const request = store.requests.create(event, payload, {
            id: event.requestId, expiresAt: Date.now() + (options.requestTimeoutMs ?? 10 * 60_000),
          });
          context.requestIds.add(request.id);
          store.runs.markWaiting(event); showRequest(session, request);
        } catch { launch(stopRun(context.run)); }
        break;
      }
      case "completed": {
        const deliveries = [{ dedupKey: `run:${event.runId}:result`, payload: { kind: "text" as const, text: event.text },
          replyToMessageId: store.inbox.get(event.scope, context.run.inputId)?.messages[0]?.messageId },
        ...context.exports.map((attachment) => ({
          dedupKey: `run:${event.runId}:file:${attachment.id}`,
          payload: { kind: "file" as const, attachmentId: attachment.id }, attachmentIds: [attachment.id],
        }))].map((item) => {
          if ("replyToMessageId" in item && item.replyToMessageId === undefined) {
            const { replyToMessageId: _unused, ...rest } = item; return rest;
          }
          return item;
        });
        if (store.runs.complete(event, deliveries)) {
          runtimeFaults.delete(scopeKey(event.scope));
          finishContext(context);
        }
        break;
      }
      case "failed": launch(failRun(context, event.code)); break;
    }
  }
  function stopRun(identity: RunIdentity): Promise<void> {
    const context = contexts.get(identity.runId);
    if (context?.stopping) return context.stopping;
    const run = store.runs.get(identity.scope, identity.runId);
    if (!run || !["preparing", "running", "waiting", "cancelling"].includes(run.status) ||
        run.sessionId !== identity.sessionId || run.generation !== identity.generation) return Promise.resolve();
    try { store.runs.cancel(identity); } catch { diagnostics.record("CANCELLATION_PERSIST_FAILED"); }
    context?.controller.abort();
    if (delivery.invalidatePreview) launch(delivery.invalidatePreview(identity));
    const session = sessionFor(identity)!;
    try { text(session, "Зупиняю. Зовнішні дії не відкочуються.", `run:${identity.runId}:cancelling`, identity.runId); }
    catch { diagnostics.record("CANCELLATION_DELIVERY_PERSIST_FAILED"); }
    const stopping = (async () => {
      try {
        await bounded(runtime.execute({ kind: "stop", identity }), options.stopTimeoutMs ?? 35_000, "STOP_UNCONFIRMED");
        // Runtime open/media continuations must observe cancellation before scope reuse.
        if (context) {
          await bounded(Promise.allSettled([...context.jobs]), options.stopTimeoutMs ?? 35_000, "MEDIA_STOP_UNCONFIRMED");
        }
        if (store.runs.finish(identity, context?.failureCode ? "failed" : "cancelled")) {
          text(session, `${context?.stopForced ? "Зупинено примусово." : "Зупинено."} ` +
            "Результат уже надісланої зовнішньої дії може бути невідомим; автоматичного повтору не буде.",
            `run:${identity.runId}:stopped`, identity.runId);
          if (context) finishContext(context);
        }
      } catch {
        diagnostics.record("STOP_UNCONFIRMED");
        runtimeFaults.set(scopeKey(identity.scope), "STOP_UNCONFIRMED");
        text(session, "Зупинку не підтверджено. Нові дії в цій розмові заблоковано. Перевірте стан сервісу.",
          `run:${identity.runId}:stop-failed`, identity.runId);
      }
    })();
    if (context) context.stopping = stopping;
    return stopping;
  }
  function stopScope(session: Session): Promise<void> {
    const key = scopeKey(session.scope);
    clearTimeout(timers.get(key)); timers.delete(key);
    store.inbox.cancelQueued(session.scope, session.id);
    const pending = store.sessions.get(session.scope, session.id)?.pendingModel;
    if (pending) store.sessions.clearPendingModel(session.scope, session.id, pending);
    const barrier = barriers.get(key);
    barrier?.controller.abort();
    if (barrier) {
      text(session, "Зупиняю керувальну операцію. Нові дії зачекають підтвердження.");
      launch(runtime.disconnect(session.scope, barrier.runtimeSessionId).catch(() => diagnostics.record("CONTROL_ABORT_PENDING")));
    }
    const run = store.runs.active(session.scope);
    const stopping = run ? stopRun(run) : Promise.resolve();
    return (async () => {
      await stopping;
      if (barrier) await barrier.promise;
      if (!run) text(session, "Активного виконання немає. Чергу й очікувану зміну моделі скасовано.");
    })();
  }
  function barrier(session: Session, work: (signal: AbortSignal) => Promise<void>): void {
    if (stopped || closing) return;
    const key = scopeKey(session.scope);
    if (barriers.has(key)) { text(session, "Керувальна операція ще триває. Доступна /stop."); return; }
    clearTimeout(idleTimers.get(key));
    const controller = new AbortController();
    const state: Barrier = { controller, promise: Promise.resolve(), runtimeSessionId: session.id };
    barriers.set(key, state);
    state.promise = (async () => {
      try { await work(controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) {
          reportFailure(store.sessions.current(session.scope) ?? current(session.scope),
            error instanceof RuntimeError ? error.code : "CONTROL_FAILED");
        }
      } finally {
        if (controller.signal.aborted) {
          try { await runtime.disconnect(session.scope, state.runtimeSessionId); }
          catch { diagnostics.record("CONTROL_CANCEL_FAILED"); }
        }
        if (barriers.get(key) === state) barriers.delete(key);
        pump(session.scope);
      }
    })();
    launch(state.promise);
  }
  function releaseIdle(session: Session): void {
    const key = scopeKey(session.scope);
    if (idleTimers.has(key) || stopped || closing) return;
    const timer = setTimeout(() => {
      idleTimers.delete(key);
      if (store.runs.active(session.scope) || barriers.has(key)) return;
      barrier(session, async () => {
        const last = lastRuns.get(key);
        if (last?.sessionId === session.id && delivery.invalidatePreview) launch(delivery.invalidatePreview(last));
        await runtime.disconnect(session.scope, session.id);
      });
    }, options.idleReleaseMs ?? 5 * 60_000);
    timer.unref(); idleTimers.set(key, timer);
  }
  function switchModel(session: Session, model: string): void {
    if (barriers.has(scopeKey(session.scope))) {
      text(session, "Попередня керувальна операція ще триває. Дочекайтесь її завершення або скористайтесь /stop.");
      return;
    }
    if (store.runs.active(session.scope)) {
      store.sessions.requestModel(session.scope, session.id, model);
      menu(session, `Фактична модель: ${session.appliedModel}\nОчікує: ${model}. Зміна після завершення ходу.`,
        [[{ text: "Скасувати зміну", action: { kind: "cancel-model", model } }]]);
      return;
    }
    store.sessions.requestModel(session.scope, session.id, model);
    barrier(session, async (signal) => {
      try {
        const available = await runtime.models(session.scope, session.id);
        signal.throwIfAborted();
        if (!available.some((entry) => entry.id === model)) throw new RuntimeError("MODEL_UNAVAILABLE");
        const requested = available.some((entry) => entry.id === session.appliedModel)
          ? session : { ...session, appliedModel: model };
        await open(requested, signal);
        signal.throwIfAborted();
        await runtime.setModel(session.scope, session.id, model);
        signal.throwIfAborted();
        if (store.sessions.applyModel(session.scope, session.id, model)) text(session, `Модель підтверджено: ${model}. Історію збережено.`);
      } catch (error) {
        store.sessions.clearPendingModel(session.scope, session.id, model);
        throw error;
      }
    });
  }
  async function models(session: Session, page: number, signal: AbortSignal): Promise<void> {
    const available = await runtime.models(session.scope, session.id);
    signal.throwIfAborted();
    const latest = store.sessions.get(session.scope, session.id);
    if (!latest || store.sessions.current(session.scope)?.id !== session.id) return;
    showModels(latest, available, page);
  }
  function showModels(session: Session, available: ModelInfo[], page: number): void {
    const size = 6;
    const offset = Math.max(0, Math.min(Math.floor(page), Math.max(0, Math.ceil(available.length / size) - 1)));
    const rows: { text: string; action: Action }[][] = available.slice(offset * size, (offset + 1) * size)
      .map((model) => [{ text: `${model.id === session.appliedModel ? "✓ " : ""}${model.name} (${model.id})`,
        action: { kind: "model", model: model.id } }]);
    const navigation: { text: string; action: Action }[] = [];
    if (offset > 0) navigation.push({ text: "←", action: { kind: "models", page: offset - 1 } });
    if ((offset + 1) * size < available.length) navigation.push({ text: "→", action: { kind: "models", page: offset + 1 } });
    if (navigation.length) rows.push(navigation);
    if (session.pendingModel) rows.push([{ text: "Скасувати зміну", action: { kind: "cancel-model", model: session.pendingModel } }]);
    menu(session, `Фактична модель: ${session.appliedModel}\nОчікує: ${session.pendingModel ?? "немає"}\n` +
      (available.some((model) => model.id === session.appliedModel) ? "Оберіть модель:" : "Початкова модель недоступна. Оберіть альтернативу; автоматичної заміни немає."), rows);
  }
  function sessions(session: Session, page: number): void {
    const all = store.sessions.list(session.scope).sort((left, right) =>
      Number(right.id === session.id) - Number(left.id === session.id));
    const offset = Math.max(0, Math.min(page, Math.max(0, Math.ceil(all.length / 5) - 1)));
    const rows: { text: string; action: Action }[][] = all.slice(offset * 5, (offset + 1) * 5).map((entry) => [
      { text: `${entry.id === session.id ? "✓ " : ""}${new Date(entry.createdAt).toLocaleString("uk-UA")} · ${entry.appliedModel}`,
        action: { kind: "resume", sessionId: entry.id } },
      { text: "Видалити", action: { kind: "delete", sessionId: entry.id, confirmed: false } },
    ]);
    if (offset > 0) rows.push([{ text: "←", action: { kind: "sessions", page: offset - 1 } }]);
    if ((offset + 1) * 5 < all.length) rows.push([{ text: "→", action: { kind: "sessions", page: offset + 1 } }]);
    menu(session, "Сесії лише цієї розмови. Перемикання та видалення — після /stop.", rows);
  }
  function showRequest(session: Session, request: PendingRequest, fieldIndex = currentField(request)): void {
    if (request.status !== "pending" || !live(request)) return;
    if (request.payload.kind === "permission") {
      menu(session, `Дозвіл на конкретну дію: ${request.payload.action}\n${JSON.stringify(request.payload.parameters, null, 2)}\n` +
        "Дозволити лише один раз? Звичайний текст не є дозволом.", [[
        { text: "Дозволити один раз", action: { kind: "request", requestId: request.id, approved: true } },
        { text: "Відхилити", action: { kind: "request", requestId: request.id, approved: false } },
      ]], opaqueId(), request.id);
      return;
    }
    const field = request.payload.fields[fieldIndex];
    if (!field) return;
    requestFields.set(request.id, fieldIndex);
    const selected = request.draft[field.id] ?? [];
    const rows: { text: string; action: Action }[][] = field.choices.map((choice) => [{
      text: `${selected.includes(choice) ? "✓ " : ""}${choice}`,
      action: { kind: "request", requestId: request.id, field: fieldIndex, choice },
    }]);
    if (field.multiple) rows.push([{ text: "Готово", action: { kind: "request", requestId: request.id, field: fieldIndex, done: true } }]);
    rows.push([{ text: "Скасувати виконання", action: { kind: "request", requestId: request.id, cancel: true } }]);
    menu(session, `Запитання ${fieldIndex + 1}/${request.payload.fields.length}: ${field.prompt}\n` +
      (field.allowFreeform ? "Можна відповісти текстом або голосом саме на це повідомлення." : "Оберіть запропонований варіант.") +
      (selected.length ? `\nОбрано: ${selected.join(", ")}` : ""), rows, opaqueId(), request.id);
  }
  function requestIsLive(request: PendingRequest | null): request is PendingRequest {
    return Boolean(request && request.status === "pending" && request.expiresAt > Date.now() && live(request));
  }
  function answer(session: Session, request: PendingRequest, value: RequestAnswer): void {
    if (!requestIsLive(store.requests.get(session.scope, request.id))) return;
    const claimed = store.requests.claim(request, request.id, value);
    if (!claimed) { text(session, "Відповідь неповна або запит уже недійсний."); return; }
    launch((async () => {
      if (!live(request)) return;
      try {
        await runtime.execute({ kind: "answer", identity: request, requestId: request.id, answer: value });
        if (!live(request)) return;
        store.requests.resolve(request, request.id);
        requestFields.delete(request.id);
        if (!store.requests.pending(session.scope).some((entry) => entry.runId === request.runId)) store.runs.markRunning(request);
        text(session, "Відповідь передано.", `request:${request.id}:answered`);
      } catch {
        const context = contexts.get(request.runId);
        if (context && live(request)) launch(failRun(context, "REQUEST_DELIVERY_FAILED"));
      }
    })());
  }
  function submitField(session: Session, request: PendingRequest, index: number, values: string[]): void {
    const value = questionAnswer(request, index, values);
    if (value?.kind !== "question") { text(session, "Невалідна відповідь. Скористайтесь формою."); return; }
    if (!store.requests.saveDraft(request, request.id, value.answers)) { text(session, "Ця форма вже недійсна."); return; }
    const updated = store.requests.get(session.scope, request.id)!;
    const next = index + 1;
    if (updated.payload.kind === "question" && next < updated.payload.fields.length) showRequest(session, updated, next);
    else answer(session, updated, value);
  }
  function requestAction(session: Session, action: Extract<Action, { kind: "request" }>): void {
    const request = store.requests.get(session.scope, action.requestId);
    if (!requestIsLive(request) || request.sessionId !== session.id) return;
    if (action.cancel) {
      store.requests.cancel(session.scope, request.id);
      launch(stopRun(request));
      return;
    }
    if (request.payload.kind === "permission") {
      if (typeof action.approved === "boolean") answer(session, request, { kind: "permission", approved: action.approved });
      return;
    }
    const index = action.field ?? requestFields.get(request.id) ?? currentField(request);
    if (index !== requestFields.get(request.id)) return;
    const field = request.payload.fields[index];
    if (!field) return;
    if (action.done) { submitField(session, request, index, request.draft[field.id] ?? []); return; }
    if (!action.choice || !field.choices.includes(action.choice)) return;
    if (!field.multiple) { submitField(session, request, index, [action.choice]); return; }
    const selected = request.draft[field.id] ?? [];
    const values = selected.includes(action.choice) ? selected.filter((entry) => entry !== action.choice) : [...selected, action.choice];
    const draft = { ...request.draft };
    if (values.length) draft[field.id] = values; else delete draft[field.id];
    if (store.requests.saveDraft(request, request.id, draft)) showRequest(session, store.requests.get(session.scope, request.id)!, index);
  }
  async function reply(session: Session, request: PendingRequest, message: IncomingMessage): Promise<void> {
    if (request.payload.kind === "permission") {
      text(session, "Дозвіл приймається лише кнопками конкретного запиту."); return;
    }
    const context = contexts.get(request.runId);
    if (!context || !requestIsLive(request)) return;
    const index = requestFields.get(request.id) ?? currentField(request);
    const field = request.payload.fields[index];
    if (!field?.allowFreeform) { text(session, "Це поле потребує вибору кнопками."); return; }
    let value = message.text.trim();
    const voice = message.attachments.find((attachment) => attachment.kind === "voice");
    try {
      if (voice) {
        value = await media.transcribe(voice, message.scope, context.controller.signal);
        const latest = store.requests.get(message.scope, request.id);
        if (!requestIsLive(latest) || latest.promptMessageId !== message.replyToMessageId || requestFields.get(request.id) !== index) return;
        text(session, `Автоматично розпізнано:\n${value}\nЗа потреби уточніть відповідь.`);
      }
      const latest = store.requests.get(message.scope, request.id);
      if (!requestIsLive(latest) || latest.promptMessageId !== message.replyToMessageId || requestFields.get(request.id) !== index) return;
      submitField(session, latest, index, [value]);
    } catch (error) { if (live(request)) text(session, failureMessage(failureCode(error))); }
  }
  function status(session: Session): void {
    const run = store.runs.active(session.scope);
    const pending = store.requests.pending(session.scope).filter((entry) => entry.sessionId === session.id);
    const failures = store.outbox.list(session.scope).filter((entry) => ["uncertain", "failed"].includes(entry.status));
    text(session, `Агент: ${session.agentId}\nСтан: ${run ? runLabels[run.status] : "очікує повідомлення"}\n` +
      `Модель: ${session.appliedModel}\nОчікувана модель: ${session.pendingModel ?? "немає"}\n` +
      `Активних запитів: ${pending.length}\nПроблема runtime: ${runtimeFaults.get(scopeKey(session.scope)) ?? "немає"}\n` +
      `Проблем доставки: ${failures.length}` +
      (held.has(scopeKey(session.scope)) ? "\nЗбережена черга утримується після перезапуску." : ""));
    for (const item of failures.slice(-5)) {
      menu(session, `Доставка ${item.status === "uncertain" ? "не підтверджена" : "невдала"}. Повтор не запускає агента.`,
        [[{ text: "Повторити доставку", action: { kind: "retry", outboxId: item.id, confirmed: false } }]]);
    }
  }
  async function finishDeletion(intent: DeletionIntent): Promise<void> {
    if (store.sessions.get(intent.scope, intent.sessionId)) {
      // A pre-delete crash has not passed the transactional busy guards.
      await deletionJournal.remove(intent);
      return;
    }
    const binding = config.config.bindings.find((entry) => entry.botId === intent.scope.botId &&
      entry.chatId === intent.scope.chatId && entry.topicId === intent.scope.topicId);
    if (!binding || intent.scope.ownerId !== config.config.ownerId) throw new RuntimeError("DELETION_SCOPE_UNAVAILABLE");
    if (intent.providerSessionId) await runtime.deleteSession(intent.scope, intent.sessionId, intent.providerSessionId);
    await media.removeArtifacts(intent.artifacts);
    await deletionJournal.remove(intent);
    text(current(intent.scope), "Сесію та її службові артефакти видалено. Workspace не змінено.");
  }
  function callback(session: Session, ingress: IncomingCallback): void {
    const action = controls.take(ingress.scope, `${session.id}:${session.generation}`, ingress.data);
    launch(delivery.acknowledgeCallback(ingress.scope.botId, ingress.callbackId, action ? undefined : "Кнопка недійсна або застаріла."));
    if (!action) return;
    if (action.kind === "stop") { launch(stopRun(action.identity)); return; }
    if (store.runs.active(session.scope)?.status === "cancelling") { text(session, "Спочатку дочекайтесь підтвердженої зупинки."); return; }
    switch (action.kind) {
      case "request":
        if (store.requests.get(session.scope, action.requestId)?.promptMessageId === ingress.messageId) requestAction(session, action);
        break;
      case "models": barrier(session, (signal) => models(session, action.page, signal)); break;
      case "model": switchModel(session, action.model); break;
      case "cancel-model":
        if (store.sessions.clearPendingModel(session.scope, session.id, action.model)) {
          const pending = barriers.get(scopeKey(session.scope));
          pending?.controller.abort();
          if (pending) launch(runtime.disconnect(session.scope, pending.runtimeSessionId));
          text(session, "Очікувану зміну моделі скасовано.");
        }
        break;
      case "sessions": sessions(session, action.page); break;
      case "resume": {
        if (store.runs.active(session.scope)) { text(session, "Спочатку зупиніть поточне виконання: /stop."); break; }
        const target = store.sessions.get(session.scope, action.sessionId);
        if (!target) break;
        barrier(session, async (signal) => {
          await runtime.disconnect(session.scope, session.id);
          signal.throwIfAborted();
          await open(target, signal);
          signal.throwIfAborted();
          if (store.sessions.activate(session.scope, target.id)) text(target, "Сесію відновлено. Незавершені дії автоматично не повторюються.");
        });
        break;
      }
      case "delete": {
        const target = store.sessions.get(session.scope, action.sessionId);
        if (!target || store.runs.active(session.scope)) { text(session, "Видалення недоступне під час роботи."); break; }
        if (!action.confirmed) {
          menu(session, "Видалити цю сесію та лише її службові файли? Файли workspace не видаляються.",
            [[{ text: "Так, видалити", action: { ...action, confirmed: true } }]]);
          break;
        }
        barrier(session, async (signal) => {
          if (store.outbox.list(session.scope).some((item) => item.sessionId === target.id && item.status === "sending") ||
              [...contexts.values()].some((context) => context.run.sessionId === target.id)) throw new RuntimeError("SESSION_BUSY");
          const intent: DeletionIntent = { scope: target.scope, sessionId: target.id,
            providerSessionId: target.providerSessionId, artifacts: store.attachments.list(target.scope, target.id) };
          let saved = false;
          try {
            await runtime.disconnect(session.scope, session.id);
            signal.throwIfAborted();
            await deletionJournal.save(intent);
            saved = true;
            signal.throwIfAborted();
            const deleted = store.sessions.delete(session.scope, target.id);
            if (!deleted) throw new RuntimeError("SESSION_DELETE_REFUSED");
            // This durable local deletion is idempotent. A crash cannot turn a
            // busy-store refusal into deletion of live native history.
            await finishDeletion(intent);
          } catch (error) {
            if (saved && store.sessions.get(target.scope, target.id)) await deletionJournal.remove(intent);
            throw error;
          }
        });
        break;
      }
      case "recovery":
        if (!held.has(scopeKey(session.scope))) break;
        if (!action.resume) {
          for (const input of store.inbox.queued(session.scope)) store.inbox.cancelQueued(session.scope, input.sessionId);
        }
        held.delete(scopeKey(session.scope));
        text(session, action.resume ? "Збережену чергу дозволено продовжити. Перервані зовнішні дії не повторюються." : "Збережену чергу відкинуто.");
        pump(session.scope);
        break;
      case "retry": {
        const item = store.outbox.get(session.scope, action.outboxId);
        if (!item || item.sessionId !== session.id) break;
        if (item.status === "uncertain" && !action.confirmed) {
          menu(session, "Telegram міг уже отримати повідомлення. Повтор може створити дубль. Продовжити?",
            [[{ text: "Повторити попри ризик дубля", action: { ...action, confirmed: true } }]]);
        } else store.outbox.retry(session.scope, item.id, { allowUncertain: action.confirmed });
        break;
      }
    }
  }
  function command(session: Session, message: IncomingMessage): void {
    const name = message.command!.name.toLowerCase().replace(/^\//, "");
    if (name === "stop") { launch(stopScope(session)); return; }
    if (store.runs.active(session.scope)?.status === "cancelling") { text(session, "Зупинку ще не підтверджено. Нові дії заблоковані."); return; }
    switch (name) {
      case "start": case "help": text(session, `Агент: ${session.agentId}\n${help}`); break;
      case "status": status(session); break;
      case "model": barrier(session, (signal) => models(session, 0, signal)); break;
      case "sessions": sessions(session, 0); break;
      case "new":
        launch((async () => {
          await stopScope(session);
          if (stopped || closing || store.runs.active(session.scope) || barriers.has(scopeKey(session.scope))) return;
          barrier(session, async (signal) => {
            await runtime.disconnect(session.scope, session.id);
            signal.throwIfAborted();
            for (const input of store.inbox.queued(session.scope)) store.inbox.cancelQueued(session.scope, input.sessionId);
            held.delete(scopeKey(session.scope));
            const fresh = createSession(session.scope);
            await open(fresh, signal);
            signal.throwIfAborted();
            text(fresh, `Нову сесію створено. Початкова модель: ${fresh.appliedModel}. Попередню історію збережено.`);
          });
        })());
        break;
      default: text(session, "Невідома команда. Перелік: /help.");
    }
  }

  const app: Application = {
    async handle(ingress) {
      if (stopped || closing) throw new RuntimeError("APPLICATION_STOPPED");
      if (!authorizeScope(config.config, { ...ingress.scope, chatKind: ingress.chatKind, isBot: false })) {
        store.inbox.recordIgnored(ingress.scope.botId, ingress.updateId); return;
      }
      if (ingress.kind === "callback") {
        if (!store.inbox.recordControl(ingress)) return;
        const session = store.sessions.current(ingress.scope);
        if (session) callback(session, ingress);
        else launch(delivery.acknowledgeCallback(ingress.scope.botId, ingress.callbackId, "Кнопка недійсна або застаріла."));
        return;
      }
      if (ingress.command) {
        if (store.inbox.recordControl(ingress)) command(current(ingress.scope), ingress);
        return;
      }
      const session = current(ingress.scope);
      if (ingress.replyToMessageId !== undefined) {
        const prompt = store.outbox.list(ingress.scope).find((entry) => entry.payload.kind === "request" &&
          entry.payload.requestId && entry.remoteMessageIds.includes(ingress.replyToMessageId!));
        if (prompt?.payload.kind === "request") {
          if (!store.inbox.recordControl(ingress)) return;
          const request = store.requests.get(ingress.scope, prompt.payload.requestId);
          if (requestIsLive(request) && request.sessionId === session.id) {
            const context = contexts.get(request.runId);
            launch(reply(session, request, ingress), context);
          } else text(session, "Ця форма вже недійсна.");
          return;
        }
      }
      const admitted = store.inbox.admit(ingress, { sessionId: session.id, reserveRun: false,
        albumDelayMs: options.albumDelayMs ?? 750 });
      if (admitted.disposition === "late-album") {
        text(session, "Частина альбому надійшла запізно. Надішліть її окремо.", `late-album:${ingress.updateId}`); return;
      }
      if (!admitted.accepted) return;
      if (store.runs.active(ingress.scope)?.status === "cancelling") {
        store.inbox.cancelQueued(ingress.scope, session.id);
        text(session, "Зупинку ще не підтверджено. Повідомлення не буде виконано."); return;
      }
      if (held.has(scopeKey(ingress.scope))) text(session, "Повідомлення збережено в утримуваній черзі. Оберіть продовжити або відкинути.");
      pump(ingress.scope);
    },
    async start(recovery) {
      if (stopped || closing) throw new RuntimeError("APPLICATION_STOPPED");
      if (started) return;
      started = true;
      app.recover(recovery ?? store.recover());
      for (const intent of await deletionJournal.pending()) await finishDeletion(intent);
      await media.cleanup();
      ticker = setInterval(() => { store.requests.expire(); }, 500);
      ticker.unref();
    },
    recover(recovery) {
      if (contexts.size || barriers.size) throw new RuntimeError("RECOVERY_REQUIRES_IDLE_APPLICATION");
      controls.clear();
      requestFields.clear();
      for (const binding of config.config.bindings) {
        const scope: Scope = { ownerId: config.config.ownerId, botId: binding.botId,
          chatId: binding.chatId, topicId: binding.topicId };
        for (const session of store.sessions.list(scope)) {
          if (session.pendingModel && store.sessions.clearPendingModel(scope, session.id, session.pendingModel)) {
            text(session, `Зміна моделі не була підтверджена до перезапуску й скасована. Збережена модель: ${session.appliedModel}.`);
          }
        }
      }
      const affected = new Map<string, Scope>();
      for (const run of recovery.interruptedRuns) affected.set(scopeKey(run.scope), run.scope);
      for (const input of recovery.queuedInputs) affected.set(scopeKey(input.scope), input.scope);
      for (const [key, scope] of affected) {
        held.add(key);
        const session = store.sessions.current(scope);
        if (!session) continue;
        menu(session, "Сервіс перезапущено. Попередні виконання перервані, дозволи недійсні. " +
          "Результат зовнішніх дій може бути невідомим. Автоматичного повтору не буде.\nЗбережену чергу продовжити чи відкинути?", [[
          { text: "Продовжити чергу", action: { kind: "recovery", resume: true } },
          { text: "Відкинути чергу", action: { kind: "recovery", resume: false } },
        ]]);
      }
    },
    async drain() {
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      shutdownPromise = (async () => {
        clearInterval(ticker);
        for (const timer of [...timers.values(), ...idleTimers.values()]) clearTimeout(timer);
        for (const barrier of barriers.values()) barrier.controller.abort();
        const stops = [...contexts.values()].map((context) => stopRun(context.run));
        await Promise.all(stops);
        stopped = true;
        controls.clear();
        requestFields.clear();
        try { await runtime.shutdown(); }
        finally {
          try { await bounded(app.drain(), options.stopTimeoutMs ?? 35_000, "APPLICATION_SHUTDOWN_TIMEOUT"); }
          finally { await media.cleanup(); }
        }
      })();
      return shutdownPromise;
    },
  };
  return app;
}
