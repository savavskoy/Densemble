import { randomUUID } from "node:crypto";
import type {
  ProactiveItem,
  ProactiveKind,
  ProactiveOccurrence,
  ProactiveOccurrenceOutcome,
  ProactiveSchedule,
  ProactiveStatus,
} from "../domain.js";
import type { ProactivityStore } from "../ports.js";
import { Connection, StateError, type Row } from "./database.js";

const proactiveKinds = ["oneoff", "recurring", "silent"] as const;
const proactiveStatuses = ["active", "paused", "cancelled", "done"] as const;
const occurrenceOutcomes = ["pending", "sent", "nothing", "late", "failed", "uncertain"] as const;

function proactiveItemRow(db: Connection, row: Row): ProactiveItem {
  return {
    id: row.id as string,
    scope: db.scope(row.conversation_id as string),
    agentId: row.agent_id as string,
    kind: row.kind as ProactiveKind,
    schedule: JSON.parse(row.schedule as string) as ProactiveSchedule,
    purpose: row.purpose as string,
    initiator: row.initiator as ProactiveItem["initiator"],
    status: row.status as ProactiveStatus,
    nextDueAt: row.next_due_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function proactiveOccurrenceRow(row: Row): ProactiveOccurrence {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    dueAt: row.due_at as number,
    outcome: row.outcome as ProactiveOccurrenceOutcome,
    late: row.late === 1,
    settledAt: row.settled_at as number | null,
    createdAt: row.created_at as number,
  };
}

function assertText(value: string, code: string): void {
  if (!value.trim()) throw new StateError(code);
}

function assertTimestamp(value: number | null, code: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new StateError(code);
}

function assertKind(kind: string): void {
  if (!proactiveKinds.includes(kind as typeof proactiveKinds[number])) throw new StateError("INVALID_PROACTIVE_KIND");
}

function assertStatus(status: string): void {
  if (!proactiveStatuses.includes(status as typeof proactiveStatuses[number])) throw new StateError("INVALID_PROACTIVE_STATUS");
}

function assertOutcome(outcome: string): void {
  if (!occurrenceOutcomes.includes(outcome as typeof occurrenceOutcomes[number])) throw new StateError("INVALID_PROACTIVE_OUTCOME");
}

function assertSchedule(schedule: ProactiveSchedule): void {
  switch (schedule.type) {
    case "once":
      assertTimestamp(schedule.at, "INVALID_PROACTIVE_SCHEDULE");
      return;
    case "interval":
      assertTimestamp(schedule.everyMs, "INVALID_PROACTIVE_SCHEDULE");
      if (schedule.everyMs <= 0) throw new StateError("INVALID_PROACTIVE_SCHEDULE");
      return;
    case "weekly":
      if (!schedule.daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
          !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23 ||
          !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
        throw new StateError("INVALID_PROACTIVE_SCHEDULE");
      }
      return;
    case "monthly":
      if (!schedule.daysOfMonth.every((day) => Number.isInteger(day) && day >= 1 && day <= 31) ||
          !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23 ||
          !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
        throw new StateError("INVALID_PROACTIVE_SCHEDULE");
      }
      return;
  }
}

export function proactivityStore(db: Connection): ProactivityStore {
  const store: ProactivityStore = {
    create(scope, options) {
      assertText(options.agentId, "INVALID_PROACTIVE_AGENT");
      assertKind(options.kind);
      assertSchedule(options.schedule);
      assertText(options.purpose, "INVALID_PROACTIVE_PURPOSE");
      if (!["oleh", "agent"].includes(options.initiator)) throw new StateError("INVALID_PROACTIVE_INITIATOR");
      assertTimestamp(options.nextDueAt, "INVALID_PROACTIVE_NEXT_DUE");
      return db.atomic(() => {
        const now = options.now ?? Date.now();
        const conversationId = db.ensureConversation(scope, now);
        const id = randomUUID();
        db.exec(`INSERT INTO proactive_items(
          id,conversation_id,agent_id,kind,schedule,purpose,initiator,status,next_due_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,'active',?,?,?)`,
        id, conversationId, options.agentId, options.kind, JSON.stringify(options.schedule), options.purpose,
        options.initiator, options.nextDueAt, now, now);
        return proactiveItemRow(db, db.one("SELECT * FROM proactive_items WHERE id=?", id)!);
      });
    },
    get(scope, id) {
      const conversationId = db.conversationId(scope);
      if (!conversationId) return null;
      const row = db.one("SELECT * FROM proactive_items WHERE id=? AND conversation_id=?", id, conversationId);
      return row ? proactiveItemRow(db, row) : null;
    },
    listForScope(scope) {
      const conversationId = db.conversationId(scope);
      if (!conversationId) return [];
      return db.all(`SELECT * FROM proactive_items
        WHERE conversation_id=? AND status IN ('active','paused')
        ORDER BY created_at,id`, conversationId).map((row) => proactiveItemRow(db, row));
    },
    listDue(now) {
      assertTimestamp(now, "INVALID_PROACTIVE_TIME");
      return db.all(`SELECT * FROM proactive_items
        WHERE status='active' AND next_due_at IS NOT NULL AND next_due_at<=?
        ORDER BY next_due_at,id`, now).map((row) => proactiveItemRow(db, row));
    },
    countActive(scope) {
      const conversationId = db.conversationId(scope);
      if (!conversationId) return 0;
      return (db.one("SELECT COUNT(*) AS count FROM proactive_items WHERE conversation_id=? AND status='active'", conversationId)?.count as number | undefined) ?? 0;
    },
    setStatus(scope, id, status, now = Date.now()) {
      assertStatus(status);
      const conversationId = db.conversationId(scope);
      return conversationId ? db.exec("UPDATE proactive_items SET status=?,updated_at=? WHERE id=? AND conversation_id=?",
        status, now, id, conversationId) > 0 : false;
    },
    reschedule(scope, id, nextDueAt, now = Date.now()) {
      assertTimestamp(nextDueAt, "INVALID_PROACTIVE_NEXT_DUE");
      const conversationId = db.conversationId(scope);
      return conversationId ? db.exec("UPDATE proactive_items SET next_due_at=?,updated_at=? WHERE id=? AND conversation_id=?",
        nextDueAt, now, id, conversationId) > 0 : false;
    },
    isAgentPaused(scope) {
      const conversationId = db.conversationId(scope);
      if (!conversationId) return false;
      return db.one("SELECT paused FROM proactivity_state WHERE conversation_id=?", conversationId)?.paused === 1;
    },
    setAgentPaused(scope, paused, now = Date.now()) {
      return db.atomic(() => {
        const conversationId = db.ensureConversation(scope, now);
        const row = db.one("SELECT paused FROM proactivity_state WHERE conversation_id=?", conversationId);
        if (!row) {
          if (!paused) return false;
          db.exec("INSERT INTO proactivity_state(conversation_id,paused,updated_at) VALUES(?,?,?)", conversationId, 1, now);
          return true;
        }
        return db.exec("UPDATE proactivity_state SET paused=?,updated_at=? WHERE conversation_id=? AND paused<>?",
          paused ? 1 : 0, now, conversationId, paused ? 1 : 0) > 0;
      });
    },
    recordOccurrence(itemId, dueAt, late, now = Date.now()) {
      assertTimestamp(dueAt, "INVALID_PROACTIVE_DUE_AT");
      return db.atomic(() => {
        if (!db.one("SELECT 1 FROM proactive_items WHERE id=?", itemId)) throw new StateError("PROACTIVE_NOT_FOUND");
        const id = randomUUID();
        db.exec(`INSERT INTO proactive_occurrences(id,item_id,due_at,late,outcome,settled_at,created_at)
          VALUES(?,?,?,?, 'pending',NULL,?)`,
        id, itemId, dueAt, late ? 1 : 0, now);
        return proactiveOccurrenceRow(db.one("SELECT * FROM proactive_occurrences WHERE id=?", id)!);
      });
    },
    settleOccurrence(id, outcome, now = Date.now()) {
      assertOutcome(outcome);
      return db.exec(`UPDATE proactive_occurrences SET outcome=?,settled_at=?
        WHERE id=? AND settled_at IS NULL AND outcome='pending'`, outcome, now, id) > 0;
    },
    syntheticId(occurrenceId) {
      const row = db.one("SELECT rowid FROM proactive_occurrences WHERE id=?", occurrenceId);
      if (!row) throw new StateError("PROACTIVE_OCCURRENCE_NOT_FOUND");
      const rowid = row.rowid as number;
      if (!Number.isSafeInteger(rowid) || rowid <= 0) throw new StateError("PROACTIVE_ROWID_INVALID");
      return -rowid;
    },
  };
  return store;
}
