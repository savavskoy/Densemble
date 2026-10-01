import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { AttachmentStore } from "../ports.js";
import { Connection, StateError } from "./database.js";
import { attachmentRow } from "./rows.js";

export const unpinned = `NOT EXISTS(SELECT 1 FROM attachment_pins p WHERE p.attachment_id=attachments.id)
  AND NOT EXISTS(SELECT 1 FROM outbox_attachments o WHERE o.attachment_id=attachments.id)`;
export const INPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function attachmentStore(db: Connection): AttachmentStore {
  const store: AttachmentStore = {
    add(attachment) {
      const path = attachment.relativePath;
      const createdAt = attachment.createdAt ?? Date.now();
      const expiresAt = attachment.expiresAt === undefined ?
        attachment.kind === "input" ? createdAt + INPUT_RETENTION_MS : attachment.kind === "audio" ? createdAt : null :
        attachment.expiresAt;
      if (!path || path.includes("\\") || path.includes("\0") || path.includes(":") || posix.isAbsolute(path) ||
          posix.normalize(path) !== path || path.split("/").some((part) => !part || part === "." || part === "..") ||
          !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || !Number.isSafeInteger(createdAt) ||
          (expiresAt !== null && !Number.isSafeInteger(expiresAt)) ||
          (attachment.kind === "input" && (expiresAt === null || expiresAt > createdAt + INPUT_RETENTION_MS))) throw new StateError("INVALID_ATTACHMENT");
      return db.atomic(() => {
        const session = db.session(attachment.scope, attachment.sessionId);
        if (!session) throw new StateError("SESSION_NOT_FOUND");
        if (attachment.runId && !db.one("SELECT 1 FROM runs WHERE id=? AND session_id=?", attachment.runId, attachment.sessionId)) {
          throw new StateError("RUN_NOT_FOUND");
        }
        const id = attachment.id ?? randomUUID();
        db.exec("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, session.conversationId,
          attachment.sessionId, attachment.runId, attachment.kind, path, attachment.fileName, attachment.mimeType,
          attachment.sizeBytes, createdAt, expiresAt);
        return store.get(attachment.scope, id)!;
      });
    },
    get(scope, id) {
      const row = db.one("SELECT * FROM attachments WHERE id=? AND conversation_id=?", id, db.conversationId(scope));
      return row ? attachmentRow(db, row) : null;
    },
    list(scope, sessionId) {
      return db.all("SELECT * FROM attachments WHERE conversation_id=? AND session_id=? ORDER BY created_at,id",
        db.conversationId(scope), sessionId).map((row) => attachmentRow(db, row));
    },
    pin(scope, id, pinId) {
      if (!pinId.trim()) throw new StateError("INVALID_PIN");
      return db.atomic(() => store.get(scope, id) !== null &&
        db.exec("INSERT OR IGNORE INTO attachment_pins VALUES(?,?)", id, pinId) > 0);
    },
    unpin(pinId) { return db.exec("DELETE FROM attachment_pins WHERE pin_id=?", pinId); },
    expired(now = Date.now()) {
      return db.all(`SELECT * FROM attachments WHERE expires_at<=? AND ${unpinned}`, now).map((row) => attachmentRow(db, row));
    },
    removeExpired(id, now = Date.now()) {
      return db.atomic(() => {
        const row = db.one(`SELECT * FROM attachments WHERE id=? AND expires_at<=? AND ${unpinned}`, id, now);
        if (!row) return null;
        const result = attachmentRow(db, row);
        db.exec("DELETE FROM attachments WHERE id=?", id);
        return result;
      });
    },
  };
  return store;
}
