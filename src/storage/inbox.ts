import { randomUUID } from "node:crypto";
import type { IncomingMessage, Scope } from "../domain.js";
import type { Admission, InboxStore } from "../ports.js";
import { activeStates, Connection, StateError } from "./database.js";
import { inputRow, runRow } from "./rows.js";

function validateId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 0 || id === Number.MAX_SAFE_INTEGER) throw new StateError("INVALID_TELEGRAM_ID");
}

export function inboxStore(db: Connection): InboxStore {
  function duplicate(message: IncomingMessage): Admission {
    const row = db.one(`SELECT i.* FROM incoming_messages m JOIN inputs i ON m.input_id=i.id
      WHERE m.bot_id=? AND m.chat_id=? AND m.message_id=? AND i.conversation_id=?`,
    message.scope.botId, message.scope.chatId, message.messageId, db.conversationId(message.scope));
    if (!row) return { accepted: false, disposition: "duplicate", input: null, run: null };
    const run = db.one("SELECT * FROM runs WHERE input_id=?", row.id as string);
    return { accepted: false, disposition: "duplicate", input: inputRow(db, row), run: run ? runRow(db, run) : null };
  }
  function reserve(scope: Scope, inputId: string, now: number) {
    const conversationId = db.conversationId(scope);
    const row = db.one(`SELECT i.* FROM inputs i JOIN conversations c ON c.id=i.conversation_id
      WHERE i.id=? AND i.conversation_id=? AND i.status='queued' AND i.ready_at<=? AND c.current_session_id=i.session_id
      AND i.id=(SELECT id FROM inputs WHERE session_id=i.session_id AND status='queued' ORDER BY created_at,rowid LIMIT 1)`,
    inputId, conversationId, now);
    if (!row || db.one(`SELECT id FROM runs WHERE conversation_id=? AND status IN (${activeStates})`, conversationId)) return null;
    const sessionId = row.session_id as string;
    db.exec("UPDATE sessions SET generation=generation+1,updated_at=? WHERE id=?", now, sessionId);
    const generation = db.session(scope, sessionId)!.generation;
    const id = randomUUID();
    db.exec(`INSERT INTO runs(id,conversation_id,session_id,input_id,generation,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'preparing',?,?)`, id, conversationId, sessionId, inputId, generation, now, now);
    db.exec("UPDATE inputs SET status='reserved',run_id=? WHERE id=?", id, inputId);
    return runRow(db, db.one("SELECT * FROM runs WHERE id=?", id)!);
  }
  const store: InboxStore = {
    admit(message, options) {
      validateId(message.updateId);
      validateId(message.messageId);
      if (message.messageId === 0) throw new StateError("INVALID_TELEGRAM_ID");
      const now = options.now ?? Date.now();
      const delay = options.albumDelayMs ?? 750;
      if (!Number.isFinite(delay) || delay < 0 || delay > 60_000) throw new StateError("INVALID_ALBUM_DELAY");
      return db.atomic(() => {
        const session = db.session(message.scope, options.sessionId);
        if (!session) throw new StateError("SESSION_NOT_FOUND");
        if (db.one("SELECT 1 FROM incoming_updates WHERE bot_id=? AND update_id=?", message.scope.botId, message.updateId)) return duplicate(message);
        db.exec("INSERT INTO incoming_updates VALUES(?,?,'message',?)", message.scope.botId, message.updateId, now);
        if (db.one("SELECT 1 FROM incoming_messages WHERE bot_id=? AND chat_id=? AND message_id=?",
          message.scope.botId, message.scope.chatId, message.messageId)) return duplicate(message);
        if (db.one("SELECT current_session_id FROM conversations WHERE id=?", session.conversationId)?.current_session_id !== session.id) {
          throw new StateError("SESSION_NOT_CURRENT");
        }
        const albumReceipt = message.mediaGroupId === undefined ? undefined :
          db.one("SELECT * FROM incoming_albums WHERE conversation_id=? AND album_id=?", session.conversationId, message.mediaGroupId);
        if (albumReceipt && albumReceipt.input_id === null) {
          db.exec("INSERT INTO incoming_messages VALUES(?,?,?,?,NULL,NULL,?)", message.scope.botId, message.scope.chatId,
            message.messageId, message.scope.topicId ?? 0, now);
          return { accepted: false, disposition: "late-album", input: null, run: null };
        }
        const album = albumReceipt ? db.one("SELECT * FROM inputs WHERE id=?", albumReceipt.input_id as string) : undefined;
        if (album && (album.status !== "queued" || album.session_id !== session.id)) {
          db.exec("INSERT INTO incoming_messages VALUES(?,?,?,?,?,NULL,?)", message.scope.botId, message.scope.chatId,
            message.messageId, message.scope.topicId ?? 0, album.id as string, now);
          return { accepted: false, disposition: "late-album", input: inputRow(db, album), run: null };
        }
        const id = album?.id as string | undefined ?? randomUUID();
        const readyAt = message.mediaGroupId === undefined ? now : now + delay;
        if (!album) {
          db.exec("INSERT INTO inputs(id,conversation_id,session_id,status,album_id,ready_at,created_at) VALUES(?,?,?,'queued',?,?,?)", id, session.conversationId, session.id,
            message.mediaGroupId ?? null, readyAt, now);
          if (message.mediaGroupId !== undefined) db.exec("INSERT INTO incoming_albums VALUES(?,?,?)", session.conversationId, message.mediaGroupId, id);
        } else {
          db.exec("UPDATE inputs SET ready_at=? WHERE id=?", readyAt, id);
        }
        db.exec("INSERT INTO incoming_messages VALUES(?,?,?,?,?,?,?)", message.scope.botId, message.scope.chatId,
          message.messageId, message.scope.topicId ?? 0, id, JSON.stringify(message), now);
        const run = options.reserveRun ? reserve(message.scope, id, now) : null;
        return { accepted: true, disposition: "accepted", input: inputRow(db, db.one("SELECT * FROM inputs WHERE id=?", id)!), run };
      });
    },
    recordControl(ingress) {
      validateId(ingress.updateId);
      return db.atomic(() => {
        if (db.one("SELECT 1 FROM incoming_updates WHERE bot_id=? AND update_id=?", ingress.scope.botId, ingress.updateId)) return false;
        db.exec("INSERT INTO incoming_updates VALUES(?,?,'control',?)", ingress.scope.botId, ingress.updateId, ingress.receivedAt);
        if (ingress.kind === "callback") {
          if (!ingress.callbackId) throw new StateError("INVALID_CALLBACK");
          return db.exec("INSERT OR IGNORE INTO controls VALUES(?,?,?)", ingress.scope.botId, ingress.callbackId, ingress.receivedAt) > 0;
        }
        validateId(ingress.messageId);
        return db.exec("INSERT OR IGNORE INTO incoming_messages VALUES(?,?,?,?,NULL,NULL,?)",
          ingress.scope.botId, ingress.scope.chatId, ingress.messageId, ingress.scope.topicId ?? 0, ingress.receivedAt) > 0;
      });
    },
    recordIgnored(botId, updateId, now = Date.now()) {
      validateId(updateId);
      return db.exec("INSERT OR IGNORE INTO incoming_updates VALUES(?,?,'ignored',?)", botId, updateId, now) > 0;
    },
    acknowledge(botId, updateId) {
      return db.atomic(() => {
        validateId(updateId);
        if (!db.one("SELECT 1 FROM incoming_updates WHERE bot_id=? AND update_id=?", botId, updateId)) {
          throw new StateError("UPDATE_NOT_DURABLE");
        }
        db.exec(`INSERT INTO polling_offsets VALUES(?,?) ON CONFLICT(bot_id)
          DO UPDATE SET next_offset=MAX(next_offset,excluded.next_offset)`, botId, updateId + 1);
        return store.offset(botId);
      });
    },
    offset(botId) { return db.one("SELECT next_offset FROM polling_offsets WHERE bot_id=?", botId)?.next_offset as number | undefined ?? 0; },
    get(scope, inputId) {
      const row = db.one("SELECT * FROM inputs WHERE id=? AND conversation_id=?", inputId, db.conversationId(scope));
      return row ? inputRow(db, row) : null;
    },
    queued(scope) {
      const rows = scope ? db.all("SELECT * FROM inputs WHERE status='queued' AND conversation_id=? ORDER BY created_at,rowid", db.conversationId(scope)) :
        db.all("SELECT * FROM inputs WHERE status='queued' ORDER BY created_at,rowid");
      return rows.map((row) => inputRow(db, row));
    },
    reserve: (scope, inputId, now = Date.now()) => db.atomic(() => reserve(scope, inputId, now)),
    attachToRun(identity, inputId, now = Date.now()) {
      return db.atomic(() => {
        if (!db.live(identity)) return null;
        const changed = db.exec(`UPDATE inputs SET status='reserved',run_id=? WHERE id=? AND session_id=?
          AND conversation_id=? AND status='queued' AND ready_at<=?`, identity.runId, inputId, identity.sessionId,
        db.conversationId(identity.scope), now);
        return changed ? store.get(identity.scope, inputId) : null;
      });
    },
    cancelQueued(scope, sessionId) {
      return db.exec("UPDATE inputs SET status='cancelled' WHERE conversation_id=? AND session_id=? AND status='queued'",
        db.conversationId(scope), sessionId);
    },
  };
  return store;
}
