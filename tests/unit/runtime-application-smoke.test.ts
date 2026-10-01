import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import type { SessionEvent } from "@github/copilot-sdk";
import { expect, it, vi } from "vitest";
import { createCopilotRuntime } from "../../src/agents/copilot.js";
import { RuntimeError } from "../../src/agents/contracts.js";
import { createApplication } from "../../src/application/index.js";
import { fixture, scope, until } from "./session-runtime-fixtures.js";

it.skipIf(process.env.DENSEMBLE_APPLICATION_SMOKE !== "1")(
  "completes a synthetic real-SDK reply, stops a second turn and resumes preserved history without replay",
  async () => {
    const home = process.env.DENSEMBLE_RUNTIME_HOME;
    if (!home || !isAbsolute(home)) throw new Error("EXPLICIT_SERVICE_RUNTIME_HOME_REQUIRED");
    const f = fixture({ autoDelivery: false });
    f.config.config.runtimeHomePath = home;
    f.config.config.runtimeDataPath = join(f.root, "data");
    f.config.config.skillDirectories = [];
    f.config.agents[0]!.tools = [];
    await mkdir(f.config.config.runtimeDataPath);
    const runtime = createCopilotRuntime({ config: f.config, diagnostics: f.diagnostics });
    const app = createApplication({
      config: f.config, store: f.store, runtime, media: f.media,
      delivery: f.delivery, diagnostics: f.diagnostics, refreshAgents: false,
      idleReleaseMs: 60_000, stopTimeoutMs: 20_000,
    });
    const sent = vi.spyOn(CopilotSession.prototype, "send");
    const nativeEvents: SessionEvent[] = [];
    const originalCreate = CopilotClient.prototype.createSession;
    vi.spyOn(CopilotClient.prototype, "createSession").mockImplementation(function (this: CopilotClient, options) {
      return originalCreate.call(this, { ...options, onEvent(event) {
        nativeEvents.push(event);
        options.onEvent?.(event);
      } });
    });
    const originalResume = CopilotClient.prototype.resumeSession;
    const resumedEvents: SessionEvent[] = [];
    const resumedNative: { session?: CopilotSession } = {};
    const resumed = vi.spyOn(CopilotClient.prototype, "resumeSession").mockImplementation(function (this: CopilotClient, id, options) {
      return originalResume.call(this, id, {
        ...options,
        onEvent(event) {
          resumedEvents.push(event);
          options.onEvent?.(event);
        },
      }).then((session) => { resumedNative.session = session; return session; });
    });
    async function click(label: string): Promise<void> {
      await f.flushDeliveries();
      const button = f.button(label);
      const ingress = f.message("");
      await app.handle({
        kind: "callback", scope, chatKind: "private", updateId: ingress.updateId,
        messageId: button.item.remoteMessageIds.at(-1)!, receivedAt: ingress.receivedAt,
        callbackId: `synthetic-${ingress.updateId}`, data: button.data,
      });
      await app.drain();
    }
    let stage = "recovery";
    try {
      await runtime.recoverOwnedProcesses();
      stage = "models";
      const probeId = randomUUID();
      const models = await runtime.models(scope, probeId);
      const selected = models.find((entry) => entry.id === "gpt-5-mini") ??
        models.find((entry) => entry.id === "claude-haiku-4.5") ?? models[0];
      if (!selected) throw new Error("SYNTHETIC_MODEL_UNAVAILABLE");
      f.config.agents[0]!.defaultModel = selected.id;
      await runtime.disconnect(scope, probeId);
      await app.start(f.store.recover());

      stage = "complete";
      await app.handle(f.message("Do not use any tools. Reply with exactly SYNTHETIC_COMPLETED."));
      const completed = f.store.runs.active(scope)!;
      await app.drain();
      const deadline = Date.now() + 45_000;
      while (f.store.runs.active(scope)?.runId === completed.runId) {
        if (Date.now() >= deadline) throw new Error("SYNTHETIC_COMPLETION_TIMEOUT");
        const pending = f.store.requests.pending(scope);
        if (pending.some((request) => request.payload.kind !== "permission")) throw new Error("SYNTHETIC_UNEXPECTED_QUESTION");
        if (pending.length) await click("Відхилити");
        await new Promise((done) => setTimeout(done, 20));
      }
      await app.drain();
      expect(f.store.runs.get(scope, completed.runId)?.status).toBe("succeeded");
      expect(f.store.outbox.list(scope).some((item) => item.runId === completed.runId &&
        item.payload.kind === "text" && item.payload.text.includes("SYNTHETIC_COMPLETED"))).toBe(true);
      expect(nativeEvents.filter((event) => event.type === "tool.execution_start").length).toBe(0);

      stage = "second-send";
      await app.handle(f.message(
        "Synthetic cancellation check. Without using any tools, write the integers 1 through 1000, one per line.",
      ));
      const run = f.store.runs.active(scope)!;
      await app.drain();
      expect(sent).toHaveBeenCalledTimes(2);
      expect(f.store.runs.active(scope)?.runId).toBe(run.runId);
      expect(f.store.sessions.current(scope)?.appliedModel).toBe(selected.id);

      stage = "stop";
      await app.handle(f.command("stop"));
      await app.drain();
      expect(f.store.runs.get(scope, run.runId)?.status).toBe("cancelled");
      expect(f.store.runs.active(scope)).toBeNull();
      expect(f.store.requests.pending(scope)).toHaveLength(0);
      expect(f.store.outbox.list(scope).some((item) =>
        item.dedupKey === `run:${run.runId}:stopped` && item.runId === run.runId)).toBe(true);

      stage = "resume";
      await app.handle(f.command("sessions"));
      await app.drain();
      await click("✓");
      expect(resumed).toHaveBeenCalledOnce();
      expect(resumed.mock.calls[0]![1].continuePendingWork).toBe(false);
      expect(resumed.mock.calls[0]![1]).not.toHaveProperty("continuePendingMessages");
      await until(() => f.store.outbox.list(scope).some((item) =>
        item.payload.kind === "text" && item.payload.text.startsWith("Сесію відновлено")), 10_000);
      await new Promise((done) => setTimeout(done, 1_000));
      expect(resumedEvents.filter((event) =>
        event.type === "assistant.message" || event.type === "tool.execution_start").length).toBe(0);
      const history = await resumedNative.session?.getEvents();
      expect(history?.some((event) => event.type === "assistant.message" &&
        event.data.content.includes("SYNTHETIC_COMPLETED"))).toBe(true);
      expect(sent).toHaveBeenCalledTimes(2);
      expect(f.store.runs.active(scope)).toBeNull();
    } catch (error) {
      throw new Error(`SYNTHETIC_APPLICATION_${stage.toUpperCase()}_${error instanceof RuntimeError ? error.code : "FAILED"}`);
    } finally {
      try {
        if (f.store.runs.active(scope)) {
          await app.handle(f.command("stop"));
          await app.drain();
        }
        for (const session of f.store.sessions.list(scope)) {
          await runtime.disconnect(scope, session.id);
          if (session.providerSessionId) await runtime.deleteSession(scope, session.id, session.providerSessionId);
        }
      } finally {
        try { await app.shutdown(); }
        finally {
          vi.restoreAllMocks();
          await f.close();
        }
      }
    }
  }, 120_000,
);
