import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationMedia } from "../../src/application/index.js";
import type { ModuleChat, ModuleChatBridge } from "../../src/modules/contract.js";
import { createModuleHost } from "../../src/modules/host.js";
import { entry, fakeCore, fakeLoader, fakeModule } from "../fixtures/modules/index.js";
import { fixture, neighbor, scope, until } from "./session-runtime-fixtures.js";

const reels = { id: "reels", agents: ["synthetic-agent"] };
const stranger = { id: "reels", agents: ["other-agent"] };

async function started(extra: Partial<ApplicationMedia> = {}) {
  const f = fixture();
  Object.assign(f.media, extra);
  await f.app.start(f.store.recover());
  return f;
}
const sends = (f: ReturnType<typeof fixture>) => f.commands.filter((command) => command.kind === "send");

describe("module chat bridge (spec 006, FR-007/FR-013)", () => {
  it("sends text once per dedup key only to owner bindings served by the module's agents", async () => {
    const f = await started();
    try {
      const bridge = f.app.moduleChat;
      expect(bridge.send(reels, scope, "Готово", "job-1")).toBe(true);
      expect(bridge.send(reels, scope, "Готово", "job-1")).toBe(true);
      expect(bridge.send(stranger, scope, "Готово", "job-2")).toBe(false);
      expect(bridge.send(reels, { ...scope, chatId: 999 }, "Готово", "job-3")).toBe(false);
      expect(bridge.send(reels, { ...scope, ownerId: 555 }, "Готово", "job-4")).toBe(false);
      expect(bridge.send(reels, scope, "Готово", " ")).toBe(false);
      expect(bridge.send(reels, neighbor, "У темі", "job-5")).toBe(true);
      expect(f.store.outbox.list(scope).filter((item) => item.dedupKey.startsWith("module:")).map((item) => item.dedupKey))
        .toEqual(["module:reels:job-1"]);
      expect(f.diagnostics.record).toHaveBeenCalledWith("MODULE_CHAT_REFUSED", { module: "reels" });
    } finally { await f.close(); }
  });

  it("exports a workspace file into the outbox with its caption, then releases the module pin", async () => {
    const release = vi.fn();
    const f = await started();
    try {
      f.media.exportModuleFile = vi.fn(async (target, sessionId) => ({
        attachment: f.store.attachments.add({ scope: target, sessionId, runId: null, kind: "output",
          relativePath: "outgoing/reel.mp4", fileName: "reel.mp4", mimeType: "application/octet-stream", sizeBytes: 10 }),
        release,
      }));
      const path = join(f.config.config.workspacePath, "raw", "reel.mp4");
      expect(await f.app.moduleChat.sendFile(reels, scope, path, { caption: "01 · Назва", dedupKey: "reel-1" })).toBe(true);
      expect(await f.app.moduleChat.sendFile(reels, scope, path, { caption: "01 · Назва", dedupKey: "reel-1" })).toBe(true);
      expect(await f.app.moduleChat.sendFile(reels, scope, "raw/reel.mp4", { dedupKey: "reel-2" })).toBe(false);
      expect(f.media.exportModuleFile).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      const items = f.store.outbox.list(scope).filter((item) => item.dedupKey === "module:reels:reel-1");
      expect(items).toHaveLength(1);
      expect(items[0]!.payload).toMatchObject({ kind: "file", caption: "01 · Назва" });
    } finally { await f.close(); }
  });

  it("wakes the agent with a module note as its own turn, deferred behind an active run, once per key", async () => {
    const f = await started();
    try {
      expect(await f.app.moduleChat.wake(reels, scope, "Відео готове.", "ready-1")).toBe(true);
      await until(() => sends(f).length === 1);
      const first = sends(f)[0]!;
      if (first.kind !== "send") throw new Error("EXPECTED_SEND");
      expect(first.input.text).toBe("[Densemble module reels] Відео готове.");
      // While that run is active, a second wake waits instead of steering into it.
      expect(await f.app.moduleChat.wake(reels, scope, "Нарізка готова.", "cut-1")).toBe(true);
      expect(await f.app.moduleChat.wake(reels, scope, "Нарізка готова.", "cut-1")).toBe(true);
      await new Promise((done) => setTimeout(done, 600));
      expect(sends(f)).toHaveLength(1);
      expect(f.commands.some((command) => command.kind === "steer")).toBe(false);
      f.emit({ ...first.identity, kind: "completed", text: "Добре." });
      await until(() => sends(f).length === 2, 3_000);
      const second = sends(f)[1]!;
      if (second.kind !== "send") throw new Error("EXPECTED_SEND");
      expect(second.input.text).toBe("[Densemble module reels] Нарізка готова.");
      f.emit({ ...second.identity, kind: "completed", text: "Добре." });
      await f.app.drain();
      // A repeated key after delivery is a duplicate update, not a new turn.
      expect(await f.app.moduleChat.wake(reels, scope, "Нарізка готова.", "cut-1")).toBe(true);
      await new Promise((done) => setTimeout(done, 600));
      expect(sends(f)).toHaveLength(2);
      expect(await f.app.moduleChat.wake(stranger, scope, "x", "y")).toBe(false);
    } finally { await f.close(); }
  });

  it("refuses everything once the application is shutting down", async () => {
    const f = await started();
    await f.app.shutdown();
    try {
      expect(f.app.moduleChat.send(reels, scope, "x", "k")).toBe(false);
      expect(await f.app.moduleChat.wake(reels, scope, "x", "k")).toBe(false);
    } finally { await f.close(); }
  });
});

describe("ModuleContext.chat (host side)", () => {
  it("adds the calling module, refuses without a bridge or after stop, and contains bridge errors", async () => {
    const runtime = mkdtempSync(join(tmpdir(), "densemble-module-chat-"));
    let chat: ModuleChat | undefined;
    let bridge: ModuleChatBridge | undefined;
    const record = vi.fn();
    const host = createModuleHost({
      entries: [entry("reels", { agents: ["synthetic-agent"] })],
      loader: fakeLoader([fakeModule("reels", { start: async (ctx) => { chat = ctx.chat; return { stop: async () => undefined }; } })]),
      core: fakeCore(), runtimeDataPath: runtime, diagnostics: { record }, chat: () => bridge,
    });
    try {
      await host.start();
      expect(chat!.send(scope, "x", "k")).toBe(false);
      const send = vi.fn(() => true);
      bridge = { send, sendFile: async () => { throw new Error("boom"); }, wake: async () => true };
      expect(chat!.send(scope, "x", "k")).toBe(true);
      expect(send).toHaveBeenCalledWith({ id: "reels", agents: ["synthetic-agent"] }, scope, "x", "k");
      expect(await chat!.sendFile(scope, "/w/a.mp4", { dedupKey: "f" })).toBe(false);
      expect(record).toHaveBeenCalledWith("MODULE_CHAT_FAILED", { module: "reels" });
      await host.stop();
      expect(await chat!.wake(scope, "x", "k")).toBe(false);
    } finally { rmSync(runtime, { recursive: true, force: true }); }
  });
});
