import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { LoadedConfig } from "../../src/config/index.js";
import type { RuntimeEvent, Session } from "../../src/domain.js";
import { createCopilotRuntime } from "../../src/agents/copilot.js";
import { RuntimeError } from "../../src/agents/contracts.js";
import { scope } from "./session-runtime-fixtures.js";

it.skipIf(process.env.DENSEMBLE_RUNTIME_SMOKE !== "1")(
  "opens, confirms, reopens an empty real SDK session and deletes it without inference",
  async () => {
    const home = process.env.DENSEMBLE_RUNTIME_HOME;
    if (!home || !isAbsolute(home)) throw new Error("EXPLICIT_SERVICE_RUNTIME_HOME_REQUIRED");
    const root = resolve(".cache", `runtime-sdk-smoke-${randomUUID()}`);
    const workspace = join(root, "workspace");
    const data = join(root, "data");
    await mkdir(workspace, { recursive: true });
    await mkdir(data);
    const canonical = join(workspace, "AGENT.md");
    await writeFile(canonical, "Synthetic lifecycle fixture. Do not use tools or access external services.");
    const config: LoadedConfig = {
      config: {
        workspacePath: workspace, agentDefinitionsPath: workspace, agentLaunchersPath: workspace,
        runtimeDataPath: data, runtimeHomePath: home, secretsPath: join(root, "secrets.local.json"),
        skillDirectories: [workspace], ownerId: scope.ownerId,
        bots: [{ id: scope.botId, agentId: "synthetic-agent", tokenRef: "unused" }],
        bindings: [{ botId: scope.botId, chatId: scope.chatId, topicId: null, kind: "private" }], mcp: { mode: "none" },
      },
      agents: [{ id: "synthetic-agent", defaultModel: "not-selected", description: "Synthetic lifecycle fixture",
        userInvocable: true, canonicalPath: canonical, launcherPath: canonical, tools: [] }],
      resolveSecret: () => { throw new Error("NO_SECRETS_IN_SYNTHETIC_FIXTURE"); },
      tokenForBot: () => { throw new Error("NO_TELEGRAM_IN_SYNTHETIC_FIXTURE"); },
    };
    const runtime = createCopilotRuntime({ config, diagnostics: { record: () => undefined } });
    const id = randomUUID();
    const provider = `densemble-${id}`;
    const events: RuntimeEvent[] = [];
    let stage = "recovery";
    try {
      await runtime.recoverOwnedProcesses();
      stage = "models";
      const models = await runtime.models(scope, id);
      expect(models.length).toBeGreaterThan(0);
      const model = models[0]!.id;
      config.agents[0]!.defaultModel = model;
      const session: Session = { id, conversationId: randomUUID(), scope, workspace, agentId: "synthetic-agent",
        providerSessionId: null, appliedModel: model, pendingModel: null, generation: 0, createdAt: Date.now(), updatedAt: Date.now() };
      stage = "open";
      const opened = await runtime.open({ session, onEvent: (event) => events.push(event) });
      expect(opened.providerSessionId).toBe(provider);
      await runtime.disconnect(scope, id);
      stage = "resume";
      const resumed = await runtime.open({ session: { ...session, providerSessionId: provider }, onEvent: (event) => events.push(event) });
      expect(resumed.providerSessionId).toBe(provider);
      expect(events).toEqual([]);
    } catch (error) {
      const indicators = ["not found", "does not exist", "missing", "empty", "invalid", "unknown", "permission", "model", "agent", "tool", "session"]
        .filter((word) => error instanceof Error && error.message.toLowerCase().includes(word)).map((word) => word.replaceAll(" ", "_"));
      throw new Error(`SYNTHETIC_RUNTIME_${stage.toUpperCase()}_${error instanceof RuntimeError ? error.code : indicators.join("_") || "FAILED"}`);
    } finally {
      try {
        await runtime.disconnect(scope, id);
        await runtime.deleteSession(scope, id, provider);
      } finally {
        try { await runtime.shutdown(); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  }, 90_000,
);
