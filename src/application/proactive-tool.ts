import type { ProactiveItem, ProactiveSchedule, Scope } from "../domain.js";
import type { StateStore } from "../ports.js";
import type { ProactivityItemSummary, ProactivityRequest, ProactivityResponse } from "../agents/contracts.js";
import { nextOccurrence } from "../scheduling/rrule.js";

export interface ProactivityGuardrails {
  maxActiveItemsPerAgent: number;
  minIntervalMs: number;
  timezone: string;
}

function summary(item: ProactiveItem): ProactivityItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    schedule: item.schedule,
    purpose: item.purpose,
    initiator: item.initiator,
    status: item.status,
    nextDueAt: item.nextDueAt,
  };
}

function failure(action: ProactivityRequest["action"], code: string, message: string): ProactivityResponse {
  return { ok: false, action, code, message };
}

function firstOccurrence(schedule: ProactiveSchedule, now: number, timezone: string): { dueAt: number } | { code: string; message: string } {
  const dueAt = nextOccurrence(schedule, now, timezone);
  return dueAt === null
    ? { code: "PROACTIVITY_SCHEDULE_IN_PAST", message: "Proactive items must be scheduled in the future." }
    : { dueAt };
}

function sameAgent(item: ProactiveItem, agentId: string): boolean {
  return item.agentId === agentId;
}

function ownActiveItems(store: StateStore, scope: Scope, agentId: string): ProactiveItem[] {
  return store.proactivity.listForScope(scope).filter((item) => item.status === "active" && sameAgent(item, agentId));
}

/**
 * On resume, items that became due while paused must be pushed to their next future occurrence
 * instead of being left due (FR-020: resuming must drop missed items, not trigger an immediate
 * catch-up burst). Shared by the `/proactive resume` oversight command and this agent tool.
 */
export function reconcileOverdueOnResume(store: StateStore, items: ProactiveItem[], now: number, timezone: string): void {
  for (const item of items) {
    if (item.status !== "active" || item.nextDueAt === null || item.nextDueAt > now) continue;
    const next = nextOccurrence(item.schedule, now, timezone);
    if (next === null) store.proactivity.setStatus(item.scope, item.id, "done", now);
    else store.proactivity.reschedule(item.scope, item.id, next, now);
  }
}

function validateScheduleForKind(kind: ProactiveItem["kind"], schedule: ProactiveSchedule): { ok: true } | { code: string; message: string } {
  if (kind === "oneoff" && schedule.type !== "once") {
    return { code: "PROACTIVITY_KIND_SCHEDULE_MISMATCH", message: "One-off items require a once schedule." };
  }
  if (kind !== "oneoff" && schedule.type === "once") {
    return { code: "PROACTIVITY_KIND_SCHEDULE_MISMATCH", message: "Recurring and silent items require a repeating schedule." };
  }
  return { ok: true };
}

export function handleProactivityRequest(
  store: StateStore,
  guardrails: ProactivityGuardrails,
  scope: Scope,
  agentId: string,
  request: ProactivityRequest,
  now = Date.now(),
): ProactivityResponse {
  switch (request.action) {
    case "schedule": {
      const purpose = request.purpose.trim();
      if (!purpose) return failure(request.action, "INVALID_PROACTIVE_PURPOSE", "Purpose must not be empty.");
      const scheduleCheck = validateScheduleForKind(request.kind, request.schedule);
      if ("code" in scheduleCheck) return failure(request.action, scheduleCheck.code, scheduleCheck.message);
      const isRepeating = request.kind !== "oneoff";
      if (isRepeating && request.schedule.type === "interval" && request.schedule.everyMs < guardrails.minIntervalMs) {
        return failure(
          request.action,
          "PROACTIVITY_GUARDRAIL_MIN_INTERVAL",
          `Intervals shorter than ${guardrails.minIntervalMs}ms are not allowed.`,
        );
      }
      if (store.proactivity.countActive(scope) >= guardrails.maxActiveItemsPerAgent) {
        return failure(
          request.action,
          "PROACTIVITY_GUARDRAIL_MAX_ITEMS",
          `This agent already has the maximum ${guardrails.maxActiveItemsPerAgent} active proactive items in this scope.`,
        );
      }
      const first = firstOccurrence(request.schedule, now, guardrails.timezone);
      if ("code" in first) return failure(request.action, first.code, first.message);
      if (isRepeating && first.dueAt - now < guardrails.minIntervalMs) {
        return failure(
          request.action,
          "PROACTIVITY_GUARDRAIL_MIN_INTERVAL",
          `The first occurrence must be at least ${guardrails.minIntervalMs}ms in the future.`,
        );
      }
      const conflict = ownActiveItems(store, scope, agentId)
        .filter((item) => item.kind !== "oneoff")
        .find((item) => item.nextDueAt !== null && Math.abs(item.nextDueAt - first.dueAt) < guardrails.minIntervalMs);
      if (conflict) {
        return failure(
          request.action,
          "PROACTIVITY_GUARDRAIL_NEAR_EXISTING",
          `Another active proactive item (${conflict.id}) is already due too close to that time.`,
        );
      }
      const item = store.proactivity.create(scope, {
        agentId,
        kind: request.kind,
        schedule: request.schedule,
        purpose,
        initiator: "agent",
        nextDueAt: first.dueAt,
        now,
      });
      return {
        ok: true,
        action: request.action,
        item: summary(item),
        message: `Scheduled proactive item ${item.id}.`,
      };
    }
    case "list": {
      const items = store.proactivity.listForScope(scope).filter((item) => sameAgent(item, agentId)).map(summary);
      const paused = store.proactivity.isAgentPaused(scope);
      return {
        ok: true,
        action: request.action,
        items,
        paused,
        message: items.length ? `Found ${items.length} proactive item(s).` : "No proactive items found.",
      };
    }
    case "cancel": {
      const item = store.proactivity.get(scope, request.id);
      if (!item) return failure(request.action, "PROACTIVITY_NOT_FOUND", `No proactive item exists for id ${request.id}.`);
      if (!sameAgent(item, agentId)) {
        return failure(request.action, "PROACTIVITY_NOT_OWNED", "Agents may only cancel their own proactive items.");
      }
      if (!store.proactivity.setStatus(scope, request.id, "cancelled", now)) {
        return failure(request.action, "PROACTIVITY_CANCEL_FAILED", `Could not cancel proactive item ${request.id}.`);
      }
      return {
        ok: true,
        action: request.action,
        id: request.id,
        status: "cancelled",
        message: `Cancelled proactive item ${request.id}.`,
      };
    }
    case "pause": {
      const changed = store.proactivity.setAgentPaused(scope, true, now);
      return {
        ok: true,
        action: request.action,
        paused: true,
        changed,
        message: changed ? "Paused proactive activity for this scope." : "Proactive activity was already paused for this scope.",
      };
    }
    case "resume": {
      reconcileOverdueOnResume(store, ownActiveItems(store, scope, agentId), now, guardrails.timezone);
      const changed = store.proactivity.setAgentPaused(scope, false, now);
      return {
        ok: true,
        action: request.action,
        paused: false,
        changed,
        message: changed ? "Resumed proactive activity for this scope." : "Proactive activity was already active for this scope.",
      };
    }
  }
}
