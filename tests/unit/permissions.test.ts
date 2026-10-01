import { afterEach, describe, expect, it, vi } from "vitest";
import { Controls, sanitizeParameters } from "../../src/permissions/index.js";
import { deferred, fixture, neighbor, scope, until } from "./session-runtime-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup(options: Parameters<typeof fixture>[0] = {}) { const f = fixture(options); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

describe("opaque permission and form controls", () => {
  it("redacts nested known secrets and token-shaped values without approving anything", () => {
    expect(sanitizeParameters({ command: "TOKEN=topsecret command", headers: { Authorization: "Bearer private" },
      other: "known-private-value" }, ["known-private-value"])).toEqual({
      command: "TOKEN=[приховано] command", headers: { Authorization: "[приховано]" }, other: "[приховано]",
    });
    const controls = new Controls<string>();
    const token = controls.add(scope, "session-one", "approve");
    expect(controls.take(neighbor, "session-one", token)).toBeNull();
    expect(controls.take(scope, "session-two", token)).toBeNull();
    expect(controls.take(scope, "session-one", `${token}x`)).toBeNull();
    expect(controls.take(scope, "session-one", token)).toBe("approve");
    expect(controls.take(scope, "session-one", token)).toBeNull();
  });
  it("requires an exact live button, ignores duplicate/foreign callbacks and atomically claims before answering runtime", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "request", requestId: "sdk_request_1", payload: {
      kind: "permission", action: "Запис", parameters: { command: "synthetic-command", token: "private-token" },
    } });
    await f.app.drain();
    const request = f.store.requests.get(scope, "sdk_request_1")!;
    expect(request.payload).toMatchObject({ parameters: { token: "[приховано]" } });
    expect(request.promptMessageId).toBeGreaterThan(0);
    await f.app.handle(f.message("так", scope, { replyToMessageId: request.promptMessageId! }));
    await f.app.drain();
    expect(f.commands.some((command) => command.kind === "answer")).toBe(false);
    const button = f.button("Дозволити один раз");
    await f.click("", neighbor, { data: button.data, messageId: request.promptMessageId! });
    const received: string[] = [];
    vi.mocked(f.runtime.execute).mockImplementation(async (command) => {
      f.commands.push(command);
      if (command.kind === "answer") received.push(f.store.requests.get(scope, command.requestId)!.status);
    });
    await f.click("Дозволити один раз"); await f.app.drain();
    await f.click("", scope, { data: button.data, messageId: request.promptMessageId! }); await f.app.drain();
    expect(received).toEqual(["claimed"]);
    expect(f.store.requests.get(scope, request.id)?.status).toBe("resolved");
    expect(f.commands.filter((command) => command.kind === "answer")).toHaveLength(1);
  });
  it("supports multi-select done and sequential freeform fields without partial runtime answers", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "request", requestId: "sdk_form", payload: { kind: "question", fields: [
      { id: "first", prompt: "Оберіть", choices: ["A", "B"], multiple: true, allowFreeform: false },
      { id: "second", prompt: "Поясніть", choices: [], multiple: false, allowFreeform: true },
    ] } });
    await f.app.drain();
    await f.click("A"); await f.app.drain();
    expect(f.store.requests.get(scope, "sdk_form")?.draft).toEqual({ first: ["A"] });
    await f.click("B"); await f.app.drain();
    expect(f.commands.filter((command) => command.kind === "answer")).toHaveLength(0);
    await f.click("Готово"); await f.app.drain();
    const request = f.store.requests.get(scope, "sdk_form")!;
    await f.app.handle(f.message("Пояснення", scope, { replyToMessageId: request.promptMessageId! }));
    await f.app.drain();
    expect(f.commands.find((command) => command.kind === "answer")).toMatchObject({
      requestId: "sdk_form", answer: { kind: "question", answers: { first: ["A", "B"], second: ["Пояснення"] } },
    });
  });
  it("ignores a voice continuation after its prompt changes during ASR", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "request", requestId: "voice_form", payload: { kind: "question", fields: [
      { id: "one", prompt: "Оберіть", choices: ["A"], multiple: false, allowFreeform: true },
      { id: "two", prompt: "Друге", choices: [], multiple: false, allowFreeform: true },
    ] } });
    await f.app.drain();
    const voice = deferred<string>();
    vi.mocked(f.media.transcribe).mockReturnValue(voice.promise);
    const request = f.store.requests.get(scope, "voice_form")!;
    const incoming = f.message("", scope, { replyToMessageId: request.promptMessageId!,
      attachments: [{ kind: "voice", fileId: "voice-one" }] });
    await f.app.handle(incoming);
    await f.app.handle(incoming);
    expect(f.media.transcribe).toHaveBeenCalledTimes(1);
    await f.click("A");
    await until(() => f.store.requests.get(scope, request.id)?.promptMessageId !== request.promptMessageId);
    voice.resolve("Stale answer"); await f.app.drain();
    expect(f.store.requests.get(scope, request.id)?.draft).toEqual({ one: ["A"] });
    expect(f.commands.filter((command) => command.kind === "answer")).toHaveLength(0);
  });
  it("stop aborts voice answer work and invalidates pending requests before late answers", async () => {
    const f = setup();
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "request", requestId: "voice_stop", payload: { kind: "question", fields: [
      { id: "answer", prompt: "Відповідь", choices: [], multiple: false, allowFreeform: true },
    ] } });
    await f.app.drain();
    let signal: AbortSignal | undefined;
    vi.mocked(f.media.transcribe).mockImplementation((_attachment, _scope, cancellation) => {
      signal = cancellation;
      return new Promise((_resolve, reject) => cancellation.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    });
    const request = f.store.requests.get(scope, "voice_stop")!;
    await f.app.handle(f.message("", scope, { replyToMessageId: request.promptMessageId!,
      attachments: [{ kind: "voice", fileId: "voice" }] }));
    await f.app.handle(f.command("stop"));
    expect(signal?.aborted).toBe(true);
    expect(f.store.requests.get(scope, request.id)?.status).toBe("invalidated");
    await f.app.drain();
    expect(f.commands.some((command) => command.kind === "answer")).toBe(false);
  });
  it("rejects expired callbacks and form cancellation stops its native wait", async () => {
    const f = setup({ requestTimeoutMs: 15 });
    await f.app.handle(f.message()); await f.app.drain();
    const run = f.store.runs.active(scope)!;
    f.emit({ ...run, kind: "request", requestId: "expired", payload: { kind: "permission", action: "Дія", parameters: {} } });
    await f.app.drain();
    await new Promise((done) => setTimeout(done, 20));
    await f.click("Дозволити один раз"); await f.app.drain();
    expect(f.commands.some((command) => command.kind === "answer")).toBe(false);
    f.emit({ ...run, kind: "request", requestId: "cancel", payload: { kind: "question", fields: [
      { id: "answer", prompt: "Відповідь", choices: [], multiple: false, allowFreeform: true },
    ] } });
    await f.app.drain();
    await f.click("Скасувати"); await f.app.drain();
    expect(f.commands.some((command) => command.kind === "stop")).toBe(true);
  });
});
