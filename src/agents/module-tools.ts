import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { defineTool, type Tool, type ToolInvocation } from "@github/copilot-sdk";
import { z } from "zod";
import type { DiagnosticSink } from "../ports.js";
import type { AbilityCall, AbilityResult } from "../modules/contract.js";
import type { ModuleHost } from "../modules/host.js";
import type { SessionAbility } from "../modules/instructions.js";

/** Engine-side context for module tools of one session. */
export interface ModuleToolGuard {
  host: ModuleHost;
  diagnostics: DiagnosticSink;
  /**
   * The call context of the live turn this invocation belongs to, or undefined when no live turn owns it
   * (the engine checks the native session id where it has one).
   */
  call(invocation: { sessionId?: string; signal?: AbortSignal }): AbilityCall | undefined;
}

function refuse(guard: ModuleToolGuard, ability: SessionAbility, code: "MODULE_NOT_PERMITTED" | "MODULE_UNAVAILABLE",
  message: string): AbilityResult {
  guard.diagnostics.record("MODULE_ABILITY_REFUSED", { code, ...(ability.moduleId ? { module: ability.moduleId } : {}) });
  return { ok: false, code, message };
}

/**
 * Host guard before module code: a live turn, the module still ready, the agent listed in `modules.<id>.agents`
 * and the owner. Core abilities (`moduleId === null`) only need the live turn; they apply their own visibility.
 */
export async function invokeGuarded(ability: SessionAbility, args: unknown, guard: ModuleToolGuard,
  invocation: { sessionId?: string; signal?: AbortSignal } = {}): Promise<AbilityResult> {
  const call = guard.call(invocation);
  if (!call) return refuse(guard, ability, "MODULE_NOT_PERMITTED", "This request does not belong to a live run.");
  if (ability.moduleId !== null) {
    const view = guard.host.get(ability.moduleId);
    if (!call.owner || !view?.entry.agents.includes(call.agentId)) {
      return refuse(guard, ability, "MODULE_NOT_PERMITTED", "This agent is not allowed to use this module.");
    }
    if (view.health.state !== "ready") return refuse(guard, ability, "MODULE_UNAVAILABLE", "The module is not ready.");
  }
  try { return await ability.invoke(args, call); }
  catch {
    guard.diagnostics.record("MODULE_ABILITY_FAILED", ability.moduleId ? { module: ability.moduleId } : {});
    return { ok: false, code: "MODULE_FAILED", message: "The module failed to handle the request." };
  }
}

/** JSON Schema for Copilot `parameters`; never throws on a schema the converter cannot represent. */
export function abilityParameters(ability: SessionAbility): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(ability.spec.input, { unrepresentable: "any" }) as Record<string, unknown>;
  return schema;
}

/** Copilot custom tool; read-only abilities skip the permission prompt like `densemble_manage_proactivity`. */
export function copilotModuleTool(ability: SessionAbility, guard: ModuleToolGuard): Tool {
  return defineTool(ability.spec.name, {
    description: ability.spec.description,
    parameters: abilityParameters(ability),
    ...(ability.spec.readOnly ? { skipPermission: true } : {}),
    handler: async (args: unknown, invocation: ToolInvocation) =>
      invokeGuarded(ability, args, guard, { sessionId: invocation.sessionId, ...(invocation.signal ? { signal: invocation.signal } : {}) }),
  });
}

/** Claude tool inside the `densemble` MCP server (`mcp__densemble__<name>`). */
export function claudeModuleTool(ability: SessionAbility, guard: ModuleToolGuard): SdkMcpToolDefinition {
  return tool(ability.spec.name, ability.spec.description, ability.spec.input.shape, async (args) => {
    const result = await invokeGuarded(ability, args, guard);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  }, ability.spec.readOnly ? { annotations: { readOnlyHint: true } } : undefined) as unknown as SdkMcpToolDefinition;
}

export const claudeModuleToolName = (name: string): string => `mcp__densemble__${name}`;
