import { randomUUID } from "node:crypto";
import type { OutboxStore } from "../ports.js";
import { Connection, StateError } from "./database.js";
import { outboxRow } from "./rows.js";

export function outboxStore(db: Connection): OutboxStore {
  const store: OutboxStore = {
    enqueue(delivery) {
      return db.atomic(() => {
        const session = db.session(delivery.scope, delivery.sessionId);
        if (!session) throw new StateError("SESSION_NOT_FOUND");
        if (!delivery.dedupKey.trim()) throw new StateError("INVALID_DELIVERY_KEY");
        const previous = db.one("SELECT * FROM outbox WHERE conversation_id=? AND dedup_key=?", session.conversationId, delivery.dedupKey);
        if (previous) {
          if (previous.session_id !== delivery.sessionId || previous.run_id !== (delivery.runId ?? null) ||
              previous.payload !== JSON.stringify(delivery.payload)) throw new StateError("DELIVERY_KEY_CONFLICT");
          return outboxRow(db, previous);
        }
        if (delivery.runId && !db.one("SELECT 1 FROM runs WHERE id=? AND session_id=?", delivery.runId, session.id)) {
          throw new StateError("RUN_NOT_FOUND");
        }
        const attachments = new Set(delivery.attachmentIds ?? []);
        if (delivery.payload.kind === "file") attachments.add(delivery.payload.attachmentId);
        for (const attachment of attachments) {
          if (!db.one("SELECT 1 FROM attachments WHERE id=? AND session_id=?", attachment, session.id)) throw new StateError("ATTACHMENT_NOT_FOUND");
        }
        if (delivery.payload.kind === "request" && !db.one("SELECT 1 FROM requests WHERE id=? AND session_id=? AND status='pending'",
          delivery.payload.requestId, session.id)) throw new StateError("REQUEST_NOT_PENDING");
        const id = randomUUID();
        const now = delivery.now ?? Date.now();
        db.exec(`INSERT INTO outbox(id,conversation_id,session_id,run_id,dedup_key,payload,reply_to_message_id,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'pending',?,?)`, id, session.conversationId, session.id, delivery.runId ?? null,
        delivery.dedupKey, JSON.stringify(delivery.payload), delivery.replyToMessageId ?? null, now, now);
        for (const attachment of attachments) db.exec("INSERT INTO outbox_attachments VALUES(?,?)", id, attachment);
        return store.get(delivery.scope, id)!;
      });
    },
    get(scope, id) {
      const row = db.one("SELECT * FROM outbox WHERE id=? AND conversation_id=?", id, db.conversationId(scope));
      return row ? outboxRow(db, row) : null;
    },
    list(scope) {
      return db.all("SELECT * FROM outbox WHERE conversation_id=? ORDER BY created_at,id", db.conversationId(scope)).map((row) => outboxRow(db, row));
    },
    claim(options = {}) {
      return db.atomic(() => {
        const now = options.now ?? Date.now();
        const max = options.maxAttempts ?? 5;
        if (!Number.isSafeInteger(max) || max < 1) throw new StateError("INVALID_MAX_ATTEMPTS");
        db.exec(`UPDATE outbox SET status='failed',retry_after=NULL,error_code='RETRY_EXHAUSTED',updated_at=?
          WHERE (status='pending' OR (status='failed' AND retry_after IS NOT NULL)) AND attempts-retry_base>=?
          AND (? IS NULL OR conversation_id IN(SELECT id FROM conversations WHERE bot_id=?))`,
        now, max, options.botId ?? null, options.botId ?? null);
        db.exec(`DELETE FROM outbox_attachments WHERE outbox_id IN
          (SELECT id FROM outbox WHERE status='failed' AND retry_after IS NULL)`);
        const row = db.one(`SELECT o.* FROM outbox o JOIN conversations c ON c.id=o.conversation_id
          WHERE (o.status='pending' OR (o.status='failed' AND o.retry_after IS NOT NULL))
          AND (o.retry_after IS NULL OR o.retry_after<=?) AND o.attempts-o.retry_base<?
          AND (? IS NULL OR c.bot_id=?) ORDER BY o.created_at,o.id LIMIT 1`,
        now, max, options.botId ?? null, options.botId ?? null);
        if (!row) return null;
        db.exec("UPDATE outbox SET status='sending',attempts=attempts+1,retry_after=NULL,updated_at=? WHERE id=?", now, row.id as string);
        return outboxRow(db, db.one("SELECT * FROM outbox WHERE id=?", row.id as string)!);
      });
    },
    settle(id, attempt, outcome, now = Date.now()) {
      if (outcome.retryAfter !== undefined && (outcome.status !== "failed" || !Number.isSafeInteger(outcome.retryAfter) || outcome.retryAfter < 0)) {
        throw new StateError("INVALID_RETRY_AFTER");
      }
      if (outcome.errorCode !== undefined && !/^[A-Z0-9_]{1,80}$/.test(outcome.errorCode)) throw new StateError("INVALID_ERROR_CODE");
      return db.atomic(() => {
        const changed = db.exec(`UPDATE outbox SET status=?,remote_message_ids=?,retry_after=?,error_code=?,updated_at=?
          WHERE id=? AND status='sending' AND attempts=?`, outcome.status, JSON.stringify(outcome.remoteMessageIds ?? []),
        outcome.retryAfter ?? null, outcome.errorCode ?? null, now, id, attempt);
        if (changed && (outcome.status === "sent" || (outcome.status === "failed" && outcome.retryAfter === undefined))) {
          db.exec("DELETE FROM outbox_attachments WHERE outbox_id=?", id);
        }
        return changed > 0;
      });
    },
    retry(scope, id, options = {}) {
      return db.atomic(() => {
        const item = store.get(scope, id);
        if (!item || (item.status !== "failed" && !(options.allowUncertain && item.status === "uncertain"))) return false;
        if (item.payload.kind === "file") {
          const attachmentId = item.payload.attachmentId;
          if (!db.one("SELECT 1 FROM attachments WHERE id=? AND session_id=?", attachmentId, item.sessionId)) throw new StateError("ATTACHMENT_EXPIRED");
          db.exec("INSERT OR IGNORE INTO outbox_attachments VALUES(?,?)", id, attachmentId);
        }
        return db.exec("UPDATE outbox SET status='pending',retry_base=attempts,retry_after=NULL,error_code=NULL,updated_at=? WHERE id=?", options.now ?? Date.now(), id) > 0;
      });
    },
    discard(scope, id, now = Date.now()) {
      return db.atomic(() => {
        const changed = db.exec("UPDATE outbox SET status='failed',retry_after=NULL,error_code='DISCARDED',updated_at=? WHERE id=? AND conversation_id=? AND status IN ('pending','failed','uncertain')",
          now, id, db.conversationId(scope));
        if (changed) db.exec("DELETE FROM outbox_attachments WHERE outbox_id=?", id);
        return changed > 0;
      });
    },
    pinnedAttachmentIds() {
      return db.all("SELECT DISTINCT attachment_id FROM outbox_attachments ORDER BY attachment_id").map((row) => row.attachment_id as string);
    },
  };
  return store;
}
