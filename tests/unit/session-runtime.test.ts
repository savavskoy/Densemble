import { afterEach, describe, expect, it, vi } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedInput, RuntimeCommand } from "../../src/domain.js";
import type { ControlledSessionOptions } from "../../src/agents/contracts.js";
import { createApplication } from "../../src/application/index.js";
import { deferred, fixture, neighbor, scope, until } from "./session-runtime-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup(options: Parameters<typeof fixture>[0] = {}) { const f = fixture(options); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

describe("durable admission and priority cancellation", () => {
  it("only enqueues deliveries and leaves claiming, sending and prompt mapping to the transport", async () => {
    const f = setup({ autoDelivery: false });
    const claim = vi.spyOn(f.store.outbox, "claim");
    const setPrompt = vi.spyOn(f.store.requests, "setPrompt");
    await f.app.start(f.store.recover());
    await f.app.handle(f.command("help")); await f.app.drain();
    expect(claim).not.toHaveBeenCalled();
    expect(setPrompt).not.toHaveBeenCalled();
    expect(f.delivery.deliver).not.toHaveBeenCalled();
    expect(f.store.outbox.list(scope).every((item) => item.status === "pending")).toBe(true);
    expect(f.store.outbox.list(scope)[0]?.payload).toMatchObject({
      kind: "text", text: expect.stringContaining("Введіть /, щоб побачити підказки команд."),
    });
    await f.flushDeliveries();
    expect(f.delivery.deliver).toHaveBeenCalledTimes(1);
    expect(f.store.outbox.list(scope)[0]?.status).toBe("sent");
  });
  it("never claims or remaps an SDK request prompt before or after external transport delivery", async () => {
    const f = setup({ autoDelivery: false });
    const claim = vi.spyOn(f.store.outbox, "claim");
    const setPrompt = vi.spyOn(f.store.requests, "setPrompt");
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "request", requestId: "external-delivery-only",
      payload: { kind: "permission", action: "Синтетична дія", parameters: {} } });
    await f.app.drain();
    expect(claim).not.toHaveBeenCalled();
    expect(setPrompt).not.toHaveBeenCalled();
    expect(f.store.requests.get(scope, "external-delivery-only")?.promptMessageId).toBeNull();
    await f.flushDeliveries();
    expect(setPrompt).toHaveBeenCalledOnce();
    setPrompt.mockClear();
    await f.app.drain();
    expect(setPrompt).not.toHaveBeenCalled();
  });
  it("returns after durable admission, deduplicates before media and stops pending preparation", async () => {
    const f = setup();
    let signal: AbortSignal | undefined;
    vi.mocked(f.media.prepare).mockImplementation((_input, _run, cancellation) => {
      signal = cancellation;
      return new Promise((_done, fail) => cancellation.addEventListener("abort", () => fail(new Error("cancelled")), { once: true }));
    });
    const incoming = f.message();
    await f.app.handle(incoming);
    expect(f.store.inbox.queued(scope)).toHaveLength(0);
    const run = f.store.runs.active(scope)!;
    expect(run.status).toBe("preparing");
    await f.app.handle(incoming);
    expect(f.media.prepare).toHaveBeenCalledTimes(1);
    expect(f.store.outbox.list(scope)).toEqual([]);
    await f.app.handle(f.command("stop"));
    expect(signal?.aborted).toBe(true);
    expect(f.store.runs.active(scope)?.status).toBe("cancelling");
    await f.app.drain();
    expect(f.store.runs.get(scope, run.runId)?.status).toBe("cancelled");
    expect(f.runtime.open).not.toHaveBeenCalled();
    expect(f.commands.map((command) => command.kind)).toEqual(["stop"]);
  });
  it("does not create sessions until delayed open and stop actually settle; late events are ignored", async () => {
    const f = setup();
    const pending = deferred<{ providerSessionId: string }>();
    vi.mocked(f.runtime.open).mockImplementationOnce((options: ControlledSessionOptions) => {
      f.hooks.set(options.session.id, options); return pending.promise;
    });
    await f.app.handle(f.message());
    await until(() => vi.mocked(f.runtime.open).mock.calls.length > 0);
    const run = f.store.runs.active(scope)!;
    const original = f.store.sessions.current(scope)!;
    await f.app.handle(f.command("stop"));
    await f.app.handle(f.command("new"));
    expect(f.store.sessions.list(scope)).toHaveLength(1);
    f.emit({ ...run, kind: "completed", text: "STALE_RESULT" });
    pending.resolve({ providerSessionId: `densemble-${original.id}` });
    await f.app.drain();
    expect(f.commands.some((command) => command.kind === "send")).toBe(false);
    expect(f.store.outbox.list(scope).some((item) => item.payload.kind === "text" && item.payload.text.includes("STALE_RESULT"))).toBe(false);
    await f.app.handle(f.command("new")); await f.app.drain();
    expect(f.store.sessions.list(scope)).toHaveLength(2);
    expect(f.store.sessions.current(scope)?.appliedModel).toBe("model-one");
  });
  it("keeps a scope blocked when stop is unconfirmed without blocking its neighbor", async () => {
    const f = setup({ stopTimeoutMs: 30 });
    const stop = deferred<void>();
    vi.mocked(f.runtime.execute).mockImplementation(async (command) => {
      f.commands.push(command);
      if (command.kind === "stop" && command.identity.scope.chatId === scope.chatId) await stop.promise;
    });
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    await f.app.handle(f.command("stop"));
    await f.app.handle(f.message("Сусід", neighbor)); await f.app.drain();
    expect(f.store.runs.active(scope)?.status).toBe("cancelling");
    expect(f.delivery.invalidatePreview).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
    expect(f.store.outbox.list(scope).find((item) => item.dedupKey === `run:${run.runId}:stop-failed`)?.runId).toBe(run.runId);
    expect(f.store.outbox.list(scope).some((item) => item.dedupKey === `run:${run.runId}:stopped`)).toBe(false);
    expect(f.store.runs.active(neighbor)?.status).toBe("running");
    await f.app.handle(f.command("new"));
    expect(f.store.sessions.list(scope)).toHaveLength(1);
    f.emit({ ...run, kind: "completed", text: "Late" });
    expect(f.store.runs.active(scope)?.status).toBe("cancelling");
    stop.resolve();
  });
  it("continues the priority path while native send is pending", async () => {
    const f = setup();
    const sent = deferred<void>();
    vi.mocked(f.runtime.execute).mockImplementation(async (command) => {
      f.commands.push(command);
      if (command.kind === "send") await sent.promise;
      if (command.kind === "stop") sent.resolve();
    });
    await f.app.handle(f.message());
    await until(() => f.commands.some((command) => command.kind === "send"));
    await f.app.handle(f.command("stop"));
    await f.app.drain();
    expect(f.store.runs.active(scope)).toBeNull();
  });
  it("persists completion and file links atomically before final delivery and ignores stale identity", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    const hook = f.hooks.get(run.sessionId)!;
    const attachment = await hook.exportFile!(run, "result.txt", new AbortController().signal);
    const observed: string[] = [];
    vi.mocked(f.delivery.deliver).mockImplementation(async (item) => {
      if (item.runId === run.runId && (item.payload.kind === "file" || item.dedupKey.endsWith(":result"))) {
        observed.push(f.store.runs.get(scope, run.runId)!.status);
      }
      return { status: "sent", remoteMessageIds: [600] };
    });
    f.emit({ ...run, generation: run.generation + 1, kind: "completed", text: "Wrong generation" });
    expect(f.store.runs.active(scope)).not.toBeNull();
    f.emit({ ...run, kind: "completed", text: "Готовий результат" }); await f.app.drain();
    expect(observed).toEqual(["succeeded", "succeeded"]);
    expect(f.store.outbox.list(scope).find((entry) => entry.payload.kind === "file")?.payload).toEqual({
      kind: "file", attachmentId: attachment.id,
    });
    await expect(hook.exportFile!(run, "other.txt", new AbortController().signal)).rejects.toThrow("EXPORT_STALE_RUN");
    expect(f.media.exportFile).toHaveBeenCalledTimes(1);
  });
  it("supplies reserved media identity and releases media pins and previews at terminal boundaries", async () => {
    const f = setup();
    f.media.releaseRun = vi.fn();
    f.delivery.invalidatePreview = vi.fn(async () => undefined);
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    expect(f.media.prepare).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "reserved" }),
      expect.objectContaining({ runId: run.runId }), expect.any(AbortSignal));
    f.emit({ ...run, kind: "completed", text: "Готово" }); await f.app.drain();
    expect(f.media.releaseRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
    expect(f.delivery.invalidatePreview).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
  });
  it("does not confirm stop before an in-progress file export observes cancellation", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    const pending = deferred<Awaited<ReturnType<typeof f.media.exportFile>>>();
    let signal: AbortSignal | undefined;
    vi.mocked(f.media.exportFile).mockImplementation((_identity, _path, cancellation) => {
      signal = cancellation; return pending.promise;
    });
    const exporting = f.hooks.get(run.sessionId)!.exportFile!(run, "result.txt", new AbortController().signal)
      .catch(() => undefined);
    await f.app.handle(f.command("stop"));
    expect(signal?.aborted).toBe(true);
    expect(f.store.runs.active(scope)?.status).toBe("cancelling");
    pending.reject(new Error("Cancelled export"));
    await exporting; await f.app.drain();
    expect(f.store.runs.get(scope, run.runId)?.status).toBe("cancelled");
  });
  it("invalidates the exact last run preview again when releasing an idle runtime", async () => {
    const f = setup({ idleReleaseMs: 5 });
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "completed", text: "Готово" }); await f.app.drain();
    vi.mocked(f.delivery.invalidatePreview!).mockClear();
    await until(() => vi.mocked(f.runtime.disconnect).mock.calls.length > 0);
    expect(f.delivery.invalidatePreview).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.runId, sessionId: run.sessionId, generation: run.generation,
    }));
  });
  it.each([
    ["MEDIA_PDF_NO_TEXT", "PDF не містить текстового шару"],
    ["MEDIA_PDF_UNSAFE", "PDF перевищує безпечні межі обробки"],
  ])("presents concrete Ukrainian %s failures rather than a misleading successful result", async (code, message) => {
    const f = setup();
    vi.mocked(f.media.prepare).mockRejectedValueOnce({ code });
    await f.app.handle(f.message()); await f.app.drain();
    expect(f.store.outbox.list(scope).some((entry) => entry.payload.kind === "text" &&
      entry.payload.text.includes(message))).toBe(true);
    expect(f.commands.some((entry) => entry.kind === "send")).toBe(false);
  });
  it("durably marks terminal errors without success and without replay", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "failed", code: "SYNTHETIC_RUNTIME_ERROR" });
    await f.app.drain();
    expect(f.store.runs.get(scope, run.runId)?.status).toBe("failed");
    expect(f.commands.filter((command) => command.kind === "send")).toHaveLength(1);
    expect(f.store.outbox.list(scope).some((item) => item.payload.kind === "text" && item.payload.text.includes("SYNTHETIC_RUNTIME_ERROR"))).toBe(true);
    expect(f.store.outbox.list(scope).find((item) => item.dedupKey === `run:${run.runId}:error`)?.runId).toBe(run.runId);
    expect(f.store.outbox.list(scope).find((item) => item.dedupKey === `run:${run.runId}:stopped`)?.runId).toBe(run.runId);
  });
});

describe("FIFO media, steering, and conversation controls", () => {
  it("reserves album quiet time FIFO, retains all captions and sends one album turn", async () => {
    const f = setup({ albumDelayMs: 25 });
    await f.app.handle(f.message("Перший", scope, { mediaGroupId: "album" }));
    await f.app.handle(f.message("Другий", scope, { mediaGroupId: "album" }));
    await f.app.handle(f.message("Після альбому"));
    expect(f.media.prepare).not.toHaveBeenCalled();
    await until(() => f.commands.some((command) => command.kind === "send"));
    await f.app.drain();
    const sends = f.commands.filter((command) => command.kind === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ input: { text: "Перший\nДругий" } });
    expect(f.commands.find((command) => command.kind === "steer")).toMatchObject({ input: { text: "Після альбому" } });
  });
  it("does not drop a queued steering input when the old run finishes during media", async () => {
    const f = setup();
    await f.app.handle(f.message("Перший")); await f.app.drain();
    const old = f.store.runs.active(scope)!;
    const prepared = deferred<PreparedInput>();
    vi.mocked(f.media.prepare).mockImplementationOnce((_input, _identity, signal) => {
      signal.addEventListener("abort", () => prepared.reject(new Error("cancelled")), { once: true });
      return prepared.promise;
    });
    await f.app.handle(f.message("Не загубити"));
    expect(f.store.inbox.queued(scope)).toHaveLength(1);
    f.emit({ ...old, kind: "completed", text: "Завершено" });
    await f.app.drain();
    expect(f.commands.filter((command) => command.kind === "send")).toHaveLength(2);
    expect(f.commands.at(-1)).toMatchObject({ kind: "send", input: { text: "Не загубити" } });
  });
  it("validates scopes before any SDK/media effects and scopes stop aliases to one conversation", async () => {
    const f = setup();
    await f.app.handle(f.message("Unknown", { ...scope, ownerId: 999 }));
    await f.app.handle(f.message("Unknown", { ...neighbor, topicId: 3 }));
    expect(f.runtime.open).not.toHaveBeenCalled();
    expect(f.media.prepare).not.toHaveBeenCalled();
    await f.app.handle(f.message()); await f.app.handle(f.message("Neighbor", neighbor)); await f.app.drain();
    const other = f.store.runs.active(neighbor)!;
    await f.app.handle(f.message("/stop@synthetic", scope, {
      command: { name: "stop", arguments: "", targetBotUsername: "synthetic" },
    }));
    await f.app.drain();
    expect(f.store.runs.active(scope)).toBeNull();
    expect(f.store.runs.active(neighbor)?.runId).toBe(other.runId);
  });
  it("shows real paginated models, keeps requested vs applied distinct and cancels pending change on stop", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    await f.app.handle(f.command("model")); await f.app.drain();
    expect(f.button("→").data).toMatch(/^c:[A-Za-z0-9_-]{24}$/);
    await f.click("→"); await f.app.drain();
    await f.click("model-8"); await f.app.drain();
    expect(f.store.sessions.current(scope)).toMatchObject({ pendingModel: "model-8", appliedModel: "model-one" });
    expect(f.runtime.setModel).not.toHaveBeenCalled();
    await f.app.handle(f.command("stop")); await f.app.drain();
    expect(f.store.sessions.current(scope)).toMatchObject({ pendingModel: null, appliedModel: "model-one" });
  });
  it("applies a pending model only on a completed boundary; failed switches leave actual model unchanged", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    await f.app.handle(f.command("model")); await f.app.drain();
    await f.click("model-2"); await f.app.drain();
    vi.mocked(f.runtime.setModel).mockRejectedValueOnce(new Error("Unavailable"));
    f.emit({ ...run, kind: "completed", text: "Готово" }); await f.app.drain();
    expect(f.runtime.setModel).toHaveBeenCalledWith(scope, run.sessionId, "model-2");
    expect(f.store.sessions.current(scope)).toMatchObject({ pendingModel: null, appliedModel: "model-one" });
    await f.app.handle(f.command("model")); await f.app.drain();
    await f.click("model-2"); await f.app.drain();
    expect(f.store.sessions.current(scope)).toMatchObject({ pendingModel: null, appliedModel: "model-2" });
  });
  it("cancels an in-flight model switch without falsely persisting requested model", async () => {
    const f = setup();
    const switching = deferred<void>();
    vi.mocked(f.runtime.setModel).mockReturnValueOnce(switching.promise);
    await f.app.handle(f.command("model")); await f.app.drain();
    await f.click("model-2");
    await until(() => vi.mocked(f.runtime.setModel).mock.calls.length === 1);
    await f.app.handle(f.command("stop"));
    expect(f.store.sessions.current(scope)?.appliedModel).toBe("model-one");
    switching.resolve(); await f.app.drain();
    expect(f.store.sessions.current(scope)).toMatchObject({ pendingModel: null, appliedModel: "model-one" });
    expect(f.runtime.disconnect).toHaveBeenCalled();
  });
  it("offers an explicit alternative when the configured initial model is unavailable", async () => {
    const f = setup();
    f.config.agents[0]!.defaultModel = "unavailable-initial";
    await f.app.handle(f.command("model")); await f.app.drain();
    expect(f.store.sessions.current(scope)?.appliedModel).toBe("unavailable-initial");
    await f.click("model-2"); await f.app.drain();
    expect(f.runtime.open).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ appliedModel: "model-2" }),
    }));
    expect(f.store.sessions.current(scope)?.appliedModel).toBe("model-2");
  });
  it("resumes a saved session with its applied model and does not send an implicit new turn", async () => {
    const f = setup();
    await f.app.handle(f.command("model")); await f.app.drain();
    await f.click("model-2"); await f.app.drain();
    const saved = f.store.sessions.current(scope)!;
    await f.app.handle(f.command("new")); await f.app.drain();
    expect(f.store.sessions.current(scope)?.appliedModel).toBe("model-one");
    await f.app.handle(f.command("sessions")); await f.app.drain();
    await f.click("model-2"); await f.app.drain();
    expect(f.store.sessions.current(scope)).toMatchObject({ id: saved.id, appliedModel: "model-2" });
    expect(f.commands.some((entry) => entry.kind === "send")).toBe(false);
  });
  it("starts runs without an automatic stop message or button and stops the current run with /stop", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const old = f.store.runs.active(scope)!;
    expect(f.store.outbox.list(scope)).toEqual([]);
    expect(f.delivery.deliver).not.toHaveBeenCalled();
    f.emit({ ...old, kind: "completed", text: "Завершено" }); await f.app.drain();
    await f.app.handle(f.message("Новий запит")); await f.app.drain();
    const active = f.store.runs.active(scope)!;
    expect(f.store.outbox.list(scope).map((item) => item.payload)).toEqual([{ kind: "text", text: "Завершено" }]);
    await f.app.handle(f.command("stop")); await f.app.drain();
    expect(f.store.runs.active(scope)).toBeNull();
    expect(f.store.runs.get(scope, old.runId)?.status).toBe("succeeded");
    expect(f.store.runs.get(scope, active.runId)?.status).toBe("cancelled");
    expect(f.commands.filter((entry) => entry.kind === "stop")).toEqual([
      expect.objectContaining({ identity: expect.objectContaining({ runId: active.runId }) }),
    ]);
  });
  it("invalidates forged and cross-scope menu tokens; requires a separate deletion confirmation", async () => {
    const f = setup();
    await f.app.handle(f.command("sessions")); await f.app.drain();
    const session = f.store.sessions.current(scope)!;
    const button = f.button("Видалити");
    expect(button.data).not.toContain(session.id);
    await f.click("", neighbor, { data: button.data, messageId: button.item.remoteMessageIds[0]! });
    expect(f.store.sessions.get(scope, session.id)).not.toBeNull();
    expect(f.store.sessions.current(neighbor)).toBeNull();
    await f.click("", scope, { data: `${button.data}tampered`, messageId: button.item.remoteMessageIds[0]! });
    await f.click("Видалити"); await f.app.drain();
    expect(f.store.sessions.get(scope, session.id)).not.toBeNull();
    await f.click("Так, видалити"); await f.app.drain();
    expect(f.store.sessions.get(scope, session.id)).toBeNull();
    expect(f.store.sessions.current(scope)?.id).not.toBe(session.id);
  });
  it("never deletes native history if the transactional store refuses deletion due to a processing pin", async () => {
    const f = setup();
    await f.app.handle(f.command("new")); await f.app.drain();
    const session = f.store.sessions.current(scope)!;
    const attachment = f.store.attachments.add({ scope, sessionId: session.id, runId: null, kind: "input",
      relativePath: "input/owned.txt", fileName: "owned.txt", mimeType: "text/plain", sizeBytes: 1 });
    f.store.attachments.pin(scope, attachment.id, "synthetic-processing");
    await f.app.handle(f.command("sessions")); await f.app.drain();
    await f.click("Видалити"); await f.app.drain();
    await f.click("Так, видалити"); await f.app.drain();
    expect(f.runtime.deleteSession).not.toHaveBeenCalled();
    expect(f.store.sessions.get(scope, session.id)).not.toBeNull();
    expect(await readdir(join(f.root, "session-deletions"))).toEqual([]);
    f.store.attachments.unpin("synthetic-processing");
  });
  it("recovers an already-confirmed local deletion after native cleanup fails, without replaying model actions", async () => {
    const f = setup();
    await f.app.handle(f.command("new")); await f.app.drain();
    const target = f.store.sessions.current(scope)!;
    vi.mocked(f.runtime.deleteSession).mockRejectedValueOnce(new Error("Synthetic interrupted cleanup"));
    await f.app.handle(f.command("sessions")); await f.app.drain();
    await f.click("Видалити"); await f.app.drain();
    await f.click("Так, видалити"); await f.app.drain();
    expect(f.store.sessions.get(scope, target.id)).toBeNull();
    expect(await readdir(join(f.root, "session-deletions"))).toEqual([`${target.id}.json`]);
    const recovered = createApplication({ config: f.config, store: f.store, runtime: f.runtime, media: f.media,
      delivery: f.delivery, diagnostics: f.diagnostics, refreshAgents: false });
    await recovered.start(f.store.recover()); await recovered.drain();
    expect(await readdir(join(f.root, "session-deletions"))).toEqual([]);
    expect(f.runtime.deleteSession).toHaveBeenCalledTimes(2);
    expect(f.commands.some((entry) => entry.kind === "send")).toBe(false);
    await recovered.shutdown();
  });
  it("holds recovered inputs until explicit resume and never replays interrupted actions", async () => {
    const f = setup();
    await f.app.handle(f.message("Interrupted")); await f.app.drain();
    const original = f.store.runs.active(scope)!;
    f.store.inbox.admit(f.message("Held"), { sessionId: original.sessionId, reserveRun: false });
    const recovery = f.store.recover();
    const recovered = createApplication({ config: f.config, store: f.store, runtime: f.runtime, media: f.media,
      delivery: f.delivery, diagnostics: f.diagnostics, refreshAgents: false, idleReleaseMs: 60_000 });
    await recovered.start(recovery); await recovered.drain(); await f.flushDeliveries();
    expect(f.commands.filter((entry) => entry.kind === "send")).toHaveLength(1);
    const { item, data } = f.button("Продовжити чергу");
    await recovered.handle({ kind: "callback", scope, chatKind: "private", updateId: 888, messageId: item.remoteMessageIds[0]!,
      receivedAt: Date.now(), callbackId: "resume", data });
    await recovered.drain();
    const sends = f.commands.filter((entry): entry is Extract<RuntimeCommand, { kind: "send" }> => entry.kind === "send");
    expect(sends.map((entry) => entry.input.text)).toEqual(["Interrupted", "Held"]);
    await recovered.shutdown();
  });
});
