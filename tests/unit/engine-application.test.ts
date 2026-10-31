import { afterEach, describe, expect, it } from "vitest";
import type { RunIdentity } from "../../src/domain.js";
import { fixture, scope, until } from "./session-runtime-fixtures.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup(engine: "copilot" | "claude-code") {
  const f = fixture();
  fixtures.push(f);
  if (engine === "claude-code") {
    f.config.config.claudeCode = { homePath: f.root, defaultModel: "claude-sonnet-5-5" };
    f.config.config.bots[0] = { ...f.config.config.bots[0]!, engine };
    f.runtime.supportsSteering = (session) => session.engine !== "claude-code";
  }
  return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const texts = (f: ReturnType<typeof fixture>) => f.store.outbox.list(scope).flatMap((item) => item.payload.kind === "text" ? [item.payload.text] : []);

describe("engine-aware application", () => {
  it("creates Copilot sessions with the launcher model when no engine is configured", async () => {
    const f = setup("copilot");
    await f.app.handle(f.message("Привіт"));
    await until(() => f.commands.some((command) => command.kind === "send"));
    expect(f.store.sessions.current(scope)).toMatchObject({ engine: "copilot", appliedModel: "model-one" });
  });
  it("creates Claude Code sessions with the engine default or the bot's model", async () => {
    const f = setup("claude-code");
    await f.app.handle(f.message("Привіт"));
    await until(() => f.commands.some((command) => command.kind === "send"));
    expect(f.store.sessions.current(scope)).toMatchObject({ engine: "claude-code", appliedModel: "claude-sonnet-5-5" });
    const g = setup("claude-code");
    g.config.config.bots[0] = { ...g.config.config.bots[0]!, model: "claude-opus-5-5" };
    await g.app.handle(g.message("Привіт"));
    await until(() => g.commands.some((command) => command.kind === "send"));
    expect(g.store.sessions.current(scope)?.appliedModel).toBe("claude-opus-5-5");
  });
  it("keeps input queued while a Claude turn runs, says so once, then runs it next", async () => {
    const f = setup("claude-code");
    await f.app.handle(f.message("Перше"));
    await until(() => f.commands.some((command) => command.kind === "send"));
    await f.app.handle(f.message("Друге"));
    await f.app.handle(f.message("Третє"));
    await until(() => texts(f).some((text) => text.startsWith("Повідомлення в черзі")));
    expect(f.commands.some((command) => command.kind === "steer")).toBe(false);
    expect(texts(f).filter((text) => text.startsWith("Повідомлення в черзі"))).toHaveLength(1);
    const first = f.commands.find((command) => command.kind === "send")! as { identity: RunIdentity };
    f.emit({ ...first.identity, kind: "completed", text: "Готово" });
    await until(() => f.commands.filter((command) => command.kind === "send").length === 2);
    expect(f.commands.filter((command) => command.kind === "send")[1]).toMatchObject({ input: { text: "Друге" } });
  });
  it("still steers Copilot turns", async () => {
    const f = setup("copilot");
    await f.app.handle(f.message("Перше"));
    await until(() => f.commands.some((command) => command.kind === "send"));
    await f.app.handle(f.message("Друге"));
    await until(() => f.commands.some((command) => command.kind === "steer"));
  });
  it("shows the session engine in /status", async () => {
    const f = setup("claude-code");
    await f.app.handle(f.command("status"));
    await f.app.drain();
    expect(texts(f).some((text) => text.includes("Рушій: Claude Code"))).toBe(true);
  });
});
