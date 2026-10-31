import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionWorkspace, parseWorkspaceCommand, workspaceListText, workspaceRequiredText,
} from "../../src/application/workspace-commands.js";
import type { Scope, Session } from "../../src/domain.js";
import { fixture } from "./session-runtime-fixtures.js";

const ownerScope: Scope = { ownerId: 101, botId: "synthetic-bot", chatId: 101, topicId: null };
const sonyaScope: Scope = { ownerId: 202, botId: "synthetic-bot", chatId: 202, topicId: null };
const session = (scope: Scope, workspace: string): Session => ({
  id: "session", conversationId: "conversation", scope, agentId: "synthetic-agent", engine: "copilot", workspace,
  providerSessionId: null, appliedModel: "model-one", pendingModel: null, generation: 0,
  createdAt: 1, updatedAt: 1,
});

describe("/workspace command helpers", () => {
  it("parses only a list or a valid workspace selector", () => {
    expect(parseWorkspaceCommand("")).toEqual({ kind: "list" });
    expect(parseWorkspaceCommand(" team-notes_1 ")).toEqual({ kind: "select", id: "team-notes_1" });
    expect(parseWorkspaceCommand("status")).toEqual({ kind: "usage" });
    expect(parseWorkspaceCommand("../private")).toEqual({ kind: "usage" });
    expect(parseWorkspaceCommand("team notes")).toEqual({ kind: "usage" });
  });

  it("lists only authorized workspace names and never exposes filesystem paths", () => {
    const config = {
      ownerId: 101, workspacePath: "/service/instructions", runtimeDataPath: "/service/data",
      bots: [{ id: "synthetic-bot", agentId: "synthetic-agent" }],
      users: [{ telegramUserId: 202, allowedBotIds: ["synthetic-bot"] }],
      workspaces: [
        { id: "shared", name: "Shared notes", access: "shared" as const, ownerUserId: 101,
          memberUserIds: [202], path: "/knowledge/shared", agentIds: ["synthetic-agent"] },
        { id: "sonya-private", name: "Private notes", access: "private" as const, ownerUserId: 202,
          path: "/knowledge/private", agentIds: ["synthetic-agent"] },
        { id: "hidden", name: "Hidden notes", access: "private" as const, ownerUserId: 303,
          path: "/knowledge/hidden", agentIds: ["synthetic-agent"] },
      ],
    };
    const output = workspaceListText(config, session(sonyaScope, "/knowledge/shared"));
    expect(output).toContain("Shared notes");
    expect(output).toContain("Private notes");
    expect(output).not.toContain("Hidden notes");
    expect(output).not.toContain("/knowledge/");
    expect(workspaceRequiredText(config, session(sonyaScope, "/runtime/lobby"))).toContain("sonya-private");
  });

  it("starts the owner in the service workspace and a multi-workspace user in an empty lobby", () => {
    const root = join(".cache", "workspace-commands-default-test");
    mkdirSync(root, { recursive: true });
    try {
      const config = {
        ownerId: 101, workspacePath: join(root, "service"), runtimeDataPath: join(root, "data"),
        bots: [{ id: "synthetic-bot", agentId: "synthetic-agent" }],
        users: [{ telegramUserId: 202, allowedBotIds: ["synthetic-bot"] }],
        workspaces: [
          { id: "one", name: "One", access: "shared" as const, ownerUserId: 101, memberUserIds: [202],
            path: join(root, "one"), agentIds: ["synthetic-agent"] },
          { id: "two", name: "Two", access: "shared" as const, ownerUserId: 101, memberUserIds: [202],
            path: join(root, "two"), agentIds: ["synthetic-agent"] },
        ],
      };
      expect(defaultSessionWorkspace(config, ownerScope)).toBe(config.workspacePath);
      expect(defaultSessionWorkspace(config, sonyaScope)).toBe(join(config.runtimeDataPath, "lobby"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles listing, access denial, and switching to a fresh authorized workspace session", async () => {
    const f = fixture();
    try {
      const first = join(f.root, "workspace-one");
      const second = join(f.root, "workspace-two");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      const secret = join(f.root, "workspace-secret");
      mkdirSync(secret, { recursive: true });
      f.config.config.users = [{ telegramUserId: 202, displayName: "Sonya", allowedBotIds: ["synthetic-bot"] }];
      f.config.config.bindings.push({ botId: "synthetic-bot", chatId: 202, topicId: null, kind: "private" });
      f.config.config.workspaces = [
        { id: "team", name: "Team notes", access: "shared", ownerUserId: 101, memberUserIds: [202],
          path: first, agentIds: ["synthetic-agent"] },
        { id: "private", name: "Private notes", access: "private", ownerUserId: 202,
          path: second, agentIds: ["synthetic-agent"] },
        { id: "secret", name: "Secret notes", access: "private", ownerUserId: 303,
          path: secret, agentIds: ["synthetic-agent"] },
      ];
      const command = async (name: string, args: string) => {
        await f.app.handle(f.message(`/${name} ${args}`, sonyaScope, {
          command: { name, arguments: args },
        }));
        await f.app.drain();
      };

      await command("workspace", "");
      const listed = f.store.outbox.list(sonyaScope).at(-1);
      expect(listed?.payload.kind === "text" && listed.payload.text).toContain("Private notes");
      expect(JSON.stringify(listed?.payload)).not.toContain("Secret notes");
      const previousSessionId = f.store.sessions.current(sonyaScope)?.id;

      await command("workspace", "secret");
      const denied = f.store.outbox.list(sonyaScope).at(-1);
      expect(denied?.payload.kind === "text" && denied.payload.text).toBe("Цей workspace недоступний.");

      await command("workspace", "private");
      const selected = f.store.sessions.current(sonyaScope);
      expect(selected?.workspace).toBe(second);
      expect(selected?.id).not.toBe(previousSessionId);
      expect(f.runtime.open).toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
