import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SessionStore } from "../ports.js";
import { activeStates, Connection, StateError } from "./database.js";
import { attachmentRow } from "./rows.js";

export function sessionStore(db: Connection): SessionStore {
  const store: SessionStore = {
    conversation(scope) {
      const id = db.conversationId(scope);
      if (!id) return null;
      const row = db.one("SELECT * FROM conversations WHERE id=?", id)!;
      return { id, scope, currentSessionId: row.current_session_id as string | null, createdAt: row.created_at as number };
    },
    create(scope, options) {
      if (!options.agentId.trim() || !options.model.trim() || !isAbsolute(options.workspace)) throw new StateError("INVALID_SESSION");
      return db.atomic(() => {
        const now = options.now ?? Date.now();
        const conversationId = db.ensureConversation(scope, now);
        if (db.one(`SELECT id FROM runs WHERE conversation_id=? AND status IN (${activeStates})`, conversationId)) {
          throw new StateError("ACTIVE_RUN");
        }
        const id = randomUUID();
        db.exec(`INSERT INTO sessions(id,conversation_id,agent_id,workspace,applied_model,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`, id, conversationId, options.agentId, options.workspace, options.model, now, now);
        db.exec("UPDATE conversations SET current_session_id=? WHERE id=?", id, conversationId);
        return db.session(scope, id)!;
      });
    },
    current(scope) {
      const id = store.conversation(scope)?.currentSessionId;
      return id ? db.session(scope, id) : null;
    },
    get: (scope, sessionId) => db.session(scope, sessionId),
    list(scope) {
      return db.all("SELECT id FROM sessions WHERE conversation_id=? ORDER BY created_at DESC,id", db.conversationId(scope))
        .map((row) => db.session(scope, row.id as string)!);
    },
    activate(scope, sessionId, now = Date.now()) {
      return db.atomic(() => {
        const session = db.session(scope, sessionId);
        if (!session || db.one(`SELECT id FROM runs WHERE conversation_id=? AND status IN (${activeStates})`, session.conversationId)) return false;
        db.exec("UPDATE conversations SET current_session_id=? WHERE id=?", sessionId, session.conversationId);
        db.exec("UPDATE sessions SET updated_at=? WHERE id=?", now, sessionId);
        return true;
      });
    },
    setProviderSessionId(scope, sessionId, providerSessionId) {
      if (!providerSessionId.trim()) throw new StateError("INVALID_PROVIDER_SESSION_ID");
      return db.exec("UPDATE sessions SET provider_session_id=? WHERE id=? AND conversation_id=? AND (provider_session_id IS NULL OR provider_session_id=?)",
        providerSessionId, sessionId, db.conversationId(scope), providerSessionId) > 0;
    },
    requestModel(scope, sessionId, model, now = Date.now()) {
      if (!model.trim()) throw new StateError("INVALID_MODEL");
      return db.exec("UPDATE sessions SET pending_model=?,updated_at=? WHERE id=? AND conversation_id=?",
        model, now, sessionId, db.conversationId(scope)) > 0;
    },
    applyModel(scope, sessionId, expectedModel, now = Date.now()) {
      return db.exec(`UPDATE sessions SET applied_model=pending_model,pending_model=NULL,updated_at=?
        WHERE id=? AND conversation_id=? AND pending_model=?
        AND NOT EXISTS(SELECT 1 FROM runs WHERE session_id=sessions.id AND status IN (${activeStates}))`,
      now, sessionId, db.conversationId(scope), expectedModel) > 0;
    },
    clearPendingModel(scope, sessionId, expectedModel) {
      return db.exec("UPDATE sessions SET pending_model=NULL WHERE id=? AND conversation_id=? AND pending_model=?",
        sessionId, db.conversationId(scope), expectedModel) > 0;
    },
    delete(scope, sessionId) {
      return db.atomic(() => {
        const session = db.session(scope, sessionId);
        if (!session) return null;
        if (db.one(`SELECT id FROM runs WHERE session_id=? AND status IN (${activeStates})`, sessionId) ||
            db.one("SELECT id FROM outbox WHERE session_id=? AND status='sending'", sessionId) ||
            db.one("SELECT a.id FROM attachments a JOIN attachment_pins p ON p.attachment_id=a.id WHERE a.session_id=?", sessionId)) {
          throw new StateError("SESSION_BUSY");
        }
        const artifacts = db.all("SELECT * FROM attachments WHERE session_id=?", sessionId).map((row) => attachmentRow(db, row));
        db.exec("UPDATE conversations SET current_session_id=NULL WHERE id=? AND current_session_id=?", session.conversationId, sessionId);
        db.exec("DELETE FROM outbox WHERE session_id=?", sessionId);
        db.exec("UPDATE incoming_messages SET payload=NULL WHERE input_id IN(SELECT id FROM inputs WHERE session_id=?)", sessionId);
        db.exec("DELETE FROM sessions WHERE id=?", sessionId);
        return { sessionId, providerSessionId: session.providerSessionId, artifacts };
      });
    },
  };
  return store;
}
