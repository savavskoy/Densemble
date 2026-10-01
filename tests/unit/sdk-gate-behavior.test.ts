import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import { ExactPolicy, Journal, requireEvidence } from "../../src/agents/sdk-gate/evidence.js";
import { fixtures, greenPng } from "../../src/agents/sdk-gate/fixtures.js";
import { discoverPersonaMetadata } from "../../src/agents/sdk-gate/personas.js";

describe("Behavior evidence bookkeeping (not real SDK evidence)", () => {
  it("does not confuse delegated messages, deltas or idle with root completion", () => {
    const journal = new Journal();
    const event = (type: string, data: object = {}, agentId?: string) =>
      ({ type, data, ...(agentId ? { agentId } : {}) }) as SessionEvent;
    journal.accept(event("assistant.message_delta", {}, "worker"));
    journal.accept(event("session.idle", {}, "worker"));
    journal.accept(event("assistant.message", { content: "child", messageId: "child" }, "worker"));
    journal.accept(event("assistant.message", { content: "child", messageId: "child2", parentToolCallId: "task1" }));
    expect(journal.root("session.idle")).toHaveLength(0);
    expect(journal.root("assistant.message_delta")).toHaveLength(0);
    expect(journal.root("assistant.message")).toHaveLength(0);
    journal.accept(event("assistant.message", { content: "root", messageId: "root", originatingMessageId: "send1" }));
    journal.accept(event("session.idle"));
    expect(journal.root("assistant.message")[0]?.originatingMessageId).toBe("send1");
    expect(journal.root("session.idle")).toHaveLength(1);
    expect(journal.root("session.idle", journal.events.length)).toHaveLength(0);
  });

  it("requires correlated actual tool completion, not a permission approval alone", () => {
    const journal = new Journal();
    journal.accept({ type: "tool.execution_start", data: { toolName: "bash", toolCallId: "1" } } as SessionEvent);
    expect(journal.toolSucceeded("bash")).toBe(false);
    journal.accept({ type: "tool.execution_complete", data: { toolCallId: "2", success: true } } as SessionEvent);
    expect(journal.toolSucceeded("bash")).toBe(false);
    journal.accept({ type: "tool.execution_complete", data: { toolCallId: "1", success: true } } as SessionEvent);
    expect(journal.toolSucceeded("bash")).toBe(true);
    expect(journal.toolSucceeded("bash", true)).toBe(false);
  });

  it("does not retain reasoning, raw errors or tool arguments", () => {
    const journal = new Journal();
    for (const type of ["assistant.reasoning", "assistant.reasoning_delta", "session.error", "tool.execution_start"]) {
      journal.accept({ type, data: { content: "SECRET", deltaContent: "SECRET", message: "SECRET", arguments: "SECRET" } } as unknown as SessionEvent);
    }
    expect(JSON.stringify(journal.events)).not.toContain("SECRET");
    expect(() => requireEvidence(false, "MISSING_REAL_EVENT")).toThrow("MISSING_REAL_EVENT");
  });

  it("creates a genuine locally encoded PNG fixture", () => {
    const bytes = Buffer.from(greenPng(), "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(64);
    expect(bytes.readUInt32BE(20)).toBe(64);
  });
});

describe("Exact synthetic action policy (offline unit tests)", () => {
  const shell = (command: string, extra = {}): PermissionRequest => ({
    kind: "shell", fullCommandText: command, toolCallId: "call", ...extra,
  }) as PermissionRequest;

  it("denies by default, disallows command variants and revokes stale approvals", () => {
    const policy = new ExactPolicy();
    expect(policy.allows(shell("node fixture.mjs"))).toBe(false);
    policy.shell.add("node fixture.mjs");
    expect(policy.allows(shell("node fixture.mjs"))).toBe(true);
    for (const command of [" node fixture.mjs", "node fixture.mjs; echo extra", "node fixture.mjs &", "node other.mjs"]) {
      expect(policy.allows(shell(command))).toBe(false);
    }
    expect(policy.allows(shell("node fixture.mjs", { requestSandboxBypass: true }))).toBe(false);
    expect(policy.allows(shell("node fixture.mjs", { managedApprovalRequired: true }))).toBe(false);
    policy.revoked = true;
    expect(policy.allows(shell("node fixture.mjs"))).toBe(false);
  });

  it("returns the pinned runtime's input decisions, not its output result variants", () => {
    const policy = new ExactPolicy();
    expect(policy.handler(shell("node fixture.mjs"), { sessionId: "synthetic" })).toEqual({ kind: "reject" });
    policy.shell.add("node fixture.mjs");
    expect(policy.handler(shell("node fixture.mjs"), { sessionId: "synthetic" })).toEqual({ kind: "approve-once" });
    policy.revoked = true;
    expect(policy.handler(shell("node fixture.mjs"), { sessionId: "synthetic" })).toEqual({ kind: "reject" });
  });

  it("matches exact MCP server, tool and argument object; never trusts readOnly", () => {
    const policy = new ExactPolicy();
    policy.mcp = { server: "gate", tool: "gate_mark", nonce: "synthetic" };
    const mcp = (extra = {}): PermissionRequest => ({
      kind: "mcp", serverName: "gate", toolName: "gate_mark", args: { nonce: "synthetic" }, readOnly: false, toolTitle: "synthetic", ...extra,
    }) as PermissionRequest;
    expect(policy.allows(mcp())).toBe(true);
    expect(policy.allows(mcp({ serverName: "real-service", readOnly: true }))).toBe(false);
    expect(policy.allows(mcp({ args: { nonce: "synthetic", path: "other" } }))).toBe(false);
    expect(policy.allows(mcp({ toolName: "other" }))).toBe(false);
  });

  describe("Persona metadata and owned fixtures (no real private inputs)", () => {
    let root: string;

    beforeEach(() => {
      root = resolve(".cache", `sdk-metadata-test-${randomUUID()}`);
      for (const directory of [".github/agents", "agent/agents/example", "agent/skills/example"]) {
        mkdirSync(join(root, directory), { recursive: true });
      }
      writeFileSync(join(root, ".github/agents/example.agent.md"), "---\nname: example\nmodel: synthetic-model\n---\nRead agent/agents/example/AGENT.md.");
      writeFileSync(join(root, ".github/agents/worker.agent.md"), "---\nname: worker\nmodel: synthetic-model\nuser-invocable: false\n---\nPRIVATE_WORKER_TEXT");
      writeFileSync(join(root, "agent/agents/example/AGENT.md"), "PRIVATE_PERSONA_TEXT\n[skill](../../skills/example/SKILL.md)");
      writeFileSync(join(root, "agent/skills/example/SKILL.md"), "PRIVATE_SKILL_TEXT");
    });

    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it("returns only model/ID/invocability/count metadata and does not modify sources", () => {
      const before = readFileSync(join(root, "agent/agents/example/AGENT.md"), "utf8");
      const metadata = discoverPersonaMetadata(root);
      expect(metadata).toEqual([
        { id: "example", model: "synthetic-model", invocable: true, skillCount: 1 },
        { id: "worker", model: "synthetic-model", invocable: false, skillCount: 0 },
      ]);
      expect(JSON.stringify(metadata)).not.toMatch(/PRIVATE_|AGENT\.md|SKILL\.md/);
      expect(readFileSync(join(root, "agent/agents/example/AGENT.md"), "utf8")).toBe(before);
    });

    it("rejects missing canonical references and malformed model metadata", () => {
      writeFileSync(join(root, ".github/agents/example.agent.md"), "---\nname: example\nmodel: synthetic-model\n---\nNo reference.");
      expect(() => discoverPersonaMetadata(root)).toThrow("CANONICAL_PERSONA_REFERENCE_MISSING");
      writeFileSync(join(root, ".github/agents/example.agent.md"), "---\nname: example\nmodel: https://invalid.example\n---");
      expect(() => discoverPersonaMetadata(root)).toThrow("LAUNCHER_MODEL_OR_ID_INVALID");
    });

    it("rejects a symlinked reference escaping the explicit workspace", () => {
      const workspace = join(root, "workspace");
      mkdirSync(join(workspace, ".github/agents"), { recursive: true });
      symlinkSync(join(root, ".github/agents/example.agent.md"), join(workspace, ".github/agents/example.agent.md"));
      expect(() => discoverPersonaMetadata(workspace)).toThrow("PERSONA_REFERENCE_OUTSIDE_WORKSPACE");
    });

    it("bounds equivalent shell commands to one known executable, script and action", () => {
      const fixture = fixtures(root);
      const commands = fixture.commands("delegated");
      expect(commands).toHaveLength(12);
      expect(commands).toContain(fixture.command("delegated"));
      const policy = new ExactPolicy();
      for (const command of commands) policy.shell.add(command);
      for (const command of commands) {
        expect(policy.allows({ kind: "shell", fullCommandText: command } as PermissionRequest)).toBe(true);
        expect(policy.allows({ kind: "shell", fullCommandText: `${command}; echo bad` } as PermissionRequest)).toBe(false);
      }
    });
  });

  it("denies all memory, URL, write, unknown and changed custom-tool requests", () => {
    const policy = new ExactPolicy();
    for (const kind of ["memory", "url", "write", "workflow", "hook"]) {
      expect(policy.allows({ kind } as PermissionRequest)).toBe(false);
    }
    policy.custom.add("gate_barrier");
    expect(policy.allows({ kind: "custom-tool", toolName: "gate_barrier", args: {} } as PermissionRequest)).toBe(true);
    expect(policy.allows({ kind: "custom-tool", toolName: "gate_barrier", toolDescription: "synthetic", args: { unexpected: true } } as PermissionRequest)).toBe(false);
  });
});
