import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RequestAnswer, RequestPayload } from "../domain.js";
import type { RequestStore } from "../ports.js";
import { Connection, StateError } from "./database.js";
import { requestRow } from "./rows.js";

const fieldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).refine((id) => !["__proto__", "prototype", "constructor"].includes(id)),
  prompt: z.string().min(1), choices: z.array(z.string().min(1)),
  multiple: z.boolean(), allowFreeform: z.boolean(),
}).strict();
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), action: z.string().min(1), parameters: z.json() }).strict(),
  z.object({ kind: z.literal("question"), fields: z.array(fieldSchema).min(1) }).strict(),
]);
const answerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), approved: z.boolean() }).strict(),
  z.object({ kind: z.literal("question"), answers: z.record(z.string(), z.array(z.string())) }).strict(),
]);
export function validAnswer(payload: RequestPayload, candidate: unknown): candidate is RequestAnswer {
  const parsed = answerSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const answer = parsed.data;
  if (payload.kind === "permission") {
    return answer.kind === "permission" && typeof answer.approved === "boolean" &&
      Object.keys(answer).every((key) => key === "kind" || key === "approved");
  }
  if (answer.kind !== "question" || !answer.answers || typeof answer.answers !== "object" ||
      Array.isArray(answer.answers) || Object.keys(answer).some((key) => key !== "kind" && key !== "answers")) return false;
  if (Object.keys(answer.answers).length !== payload.fields.length) return false;
  return payload.fields.every((field) => {
    if (!Object.hasOwn(answer.answers, field.id)) return false;
    const values = answer.answers[field.id];
    return Array.isArray(values) && values.length > 0 && (field.multiple || values.length === 1) &&
      new Set(values).size === values.length && values.every((value) =>
      typeof value === "string" && value.trim().length > 0 && (field.allowFreeform || field.choices.includes(value)));
  });
}

export function requestStore(db: Connection): RequestStore {
  const store: RequestStore = {
    create(identity, payload, options) {
      return db.atomic(() => {
        const now = options.now ?? Date.now();
        if (!db.live(identity)) throw new StateError("RUN_NOT_LIVE");
        const parsed = payloadSchema.safeParse(payload);
        if (!parsed.success || !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now) {
          throw new StateError("INVALID_REQUEST");
        }
        if (payload.kind === "question" && (new Set(payload.fields.map((field) => field.id)).size !== payload.fields.length ||
            payload.fields.some((field) => !field.allowFreeform && field.choices.length === 0))) throw new StateError("INVALID_REQUEST");
        const id = options.id ?? randomBytes(12).toString("base64url");
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new StateError("INVALID_REQUEST_ID");
        db.exec(`INSERT INTO requests(id,conversation_id,session_id,run_id,generation,payload,status,created_at,expires_at)
          VALUES(?,?,?,?,?,?,'pending',?,?)`, id, db.conversationId(identity.scope), identity.sessionId,
        identity.runId, identity.generation, JSON.stringify(payload), now, options.expiresAt);
        return store.get(identity.scope, id)!;
      });
    },
    get(scope, requestId) {
      const row = db.one("SELECT * FROM requests WHERE id=? AND conversation_id=?", requestId, db.conversationId(scope));
      return row ? requestRow(db, row) : null;
    },
    pending(scope) {
      return db.all("SELECT * FROM requests WHERE conversation_id=? AND status='pending' ORDER BY created_at,id",
        db.conversationId(scope)).map((row) => requestRow(db, row));
    },
    setPrompt(scope, requestId, messageId) {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new StateError("INVALID_MESSAGE_ID");
      return db.exec("UPDATE requests SET prompt_message_id=? WHERE id=? AND conversation_id=? AND status='pending'",
        messageId, requestId, db.conversationId(scope)) > 0;
    },
    saveDraft(identity, requestId, draft, now = Date.now()) {
      return db.atomic(() => {
        if (!db.live(identity)) return false;
        const request = store.get(identity.scope, requestId);
        if (!request || request.runId !== identity.runId || request.generation !== identity.generation ||
            request.status !== "pending" || request.expiresAt <= now || request.payload.kind !== "question") return false;
        const fields = request.payload.fields.filter((field) => Object.hasOwn(draft, field.id));
        if (!validAnswer({ kind: "question", fields }, { kind: "question", answers: draft })) return false;
        return db.exec("UPDATE requests SET draft=? WHERE id=?", JSON.stringify(draft), requestId) > 0;
      });
    },
    claim(identity, requestId, answer, now = Date.now()) {
      return db.atomic(() => {
        if (!db.live(identity)) return null;
        const request = store.get(identity.scope, requestId);
        if (!request || request.sessionId !== identity.sessionId || request.runId !== identity.runId ||
            request.generation !== identity.generation || request.status !== "pending" || request.expiresAt <= now ||
            !validAnswer(request.payload, answer)) return null;
        db.exec("UPDATE requests SET status='claimed',answer=? WHERE id=? AND status='pending'", JSON.stringify(answer), requestId);
        return store.get(identity.scope, requestId);
      });
    },
    resolve(identity, requestId) {
      return db.atomic(() => db.live(identity) && db.exec(`UPDATE requests SET status='resolved'
        WHERE id=? AND conversation_id=? AND run_id=? AND session_id=? AND generation=? AND status='claimed'`,
      requestId, db.conversationId(identity.scope), identity.runId, identity.sessionId, identity.generation) > 0);
    },
    cancel(scope, requestId) {
      return db.exec("UPDATE requests SET status='cancelled' WHERE id=? AND conversation_id=? AND status IN ('pending','claimed')",
        requestId, db.conversationId(scope)) > 0;
    },
    invalidateRun(identity) {
      return db.exec(`UPDATE requests SET status='invalidated' WHERE run_id=? AND session_id=?
        AND generation=? AND conversation_id=? AND status IN ('pending','claimed')`,
      identity.runId, identity.sessionId, identity.generation, db.conversationId(identity.scope));
    },
    expire(now = Date.now()) {
      return db.exec("UPDATE requests SET status='expired' WHERE status='pending' AND expires_at<=?", now);
    },
  };
  return store;
}
