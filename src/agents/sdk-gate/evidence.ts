import type { PermissionHandler, PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { GateError } from "./contracts.js";

export type SafeEvent = {
  type: SessionEvent["type"];
  agentId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  success?: boolean;
  messageId?: string;
  originatingMessageId?: string;
  delivery?: string;
  model?: string;
  content?: string;
};

// Only synthetic answer text is retained in memory. Reasoning, errors and tool arguments
// never enter the event journal or terminal report.
export class Journal {
  readonly events: SafeEvent[] = [];
  readonly models = new Set<string>();
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;

  accept(event: SessionEvent): void {
    const item: SafeEvent = { type: event.type, ...(event.agentId ? { agentId: event.agentId } : {}) };
    switch (event.type) {
      case "assistant.message":
        item.content = event.data.content;
        item.messageId = event.data.messageId;
        if (event.data.originatingMessageId) item.originatingMessageId = event.data.originatingMessageId;
        if (event.data.model) item.model = event.data.model;
        if (event.data.parentToolCallId) item.parentToolCallId = event.data.parentToolCallId;
        break;
      case "user.message":
        if (event.data.messageId) item.messageId = event.data.messageId;
        if (event.data.delivery) item.delivery = event.data.delivery;
        break;
      case "tool.execution_start":
        item.toolCallId = event.data.toolCallId;
        item.toolName = event.data.toolName;
        if (event.data.parentToolCallId) item.parentToolCallId = event.data.parentToolCallId;
        break;
      case "tool.execution_complete":
        item.toolCallId = event.data.toolCallId;
        item.success = event.data.success;
        break;
      case "subagent.started":
      case "subagent.completed":
        item.toolCallId = event.data.toolCallId;
        break;
      case "session.model_change":
        item.model = event.data.newModel;
        break;
      case "assistant.usage":
        this.models.add(event.data.model);
        this.inputTokens += event.data.inputTokens ?? 0;
        this.outputTokens += event.data.outputTokens ?? 0;
        this.calls++;
        break;
      default:
        break;
    }
    this.events.push(item);
  }

  root(type: SafeEvent["type"], after = 0): SafeEvent[] {
    return this.events.slice(after).filter((event) => event.type === type && !event.agentId && !event.parentToolCallId);
  }

  toolSucceeded(toolName: string, delegated = false): boolean {
    return this.events.some((start) => start.type === "tool.execution_start" && start.toolName === toolName &&
      (!delegated || Boolean(start.agentId || start.parentToolCallId)) &&
      this.events.some((end) => end.type === "tool.execution_complete" &&
        end.toolCallId === start.toolCallId && end.success));
  }
}

export type PermissionRecord = { kind: PermissionRequest["kind"]; allowed: boolean; toolCallId?: string };

export class ExactPolicy {
  readonly records: PermissionRecord[] = [];
  readonly shell = new Set<string>();
  readonly reads = new Set<string>();
  readonly custom = new Set<string>();
  mcp: { server: string; tool: string; nonce: string } | undefined;
  revoked = false;

  allows(request: PermissionRequest): boolean {
    if (this.revoked || request.managedApprovalRequired) return false;
    switch (request.kind) {
      case "shell":
        return !request.requestSandboxBypass && !request.requestSandboxPermissive &&
          !request.sandboxPathGrant && this.shell.has(request.fullCommandText);
      case "read":
        return !request.requestSandboxBypass && !request.sandboxPathGrant &&
          this.reads.has(request.path) && (!request.resolvedPath || this.reads.has(request.resolvedPath));
      case "custom-tool":
        return this.custom.has(request.toolName) &&
          request.args !== null && typeof request.args === "object" &&
          !Array.isArray(request.args) && Object.keys(request.args).length === 0;
      case "mcp":
        return Boolean(this.mcp && request.serverName === this.mcp.server && request.toolName === this.mcp.tool &&
          JSON.stringify(request.args) === JSON.stringify({ nonce: this.mcp.nonce }));
      default:
        return false;
    }
  }

  readonly handler: PermissionHandler = (request) => {
    const allowed = this.allows(request);
    this.records.push({
      kind: request.kind, allowed,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
    });
    return { kind: allowed ? "approve-once" : "reject" };
  };
}

export async function until(predicate: () => boolean, code: string, timeout = 45_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new GateError(code);
    await delay(25);
  }
}

export function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new GateError(code);
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
