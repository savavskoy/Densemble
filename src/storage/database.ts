import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { RunIdentity, Scope, Session } from "../domain.js";
import { assertScope, scopeKey } from "../domain.js";

export class StateError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "StateError"; }
}
export type Row = Record<string, unknown>;
export type SqlValue = string | number | null;
export const activeStates = "'preparing','running','waiting','cancelling'";
export const liveStates = "'preparing','running','waiting'";

const migrations = [`
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE,
 owner_id INTEGER NOT NULL, bot_id TEXT NOT NULL, chat_id INTEGER NOT NULL,
 topic_id INTEGER NOT NULL DEFAULT 0 CHECK(topic_id >= 0),
 current_session_id TEXT, created_at INTEGER NOT NULL,
 UNIQUE(owner_id,bot_id,chat_id,topic_id),
 FOREIGN KEY(current_session_id,id) REFERENCES sessions(id,conversation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 agent_id TEXT NOT NULL, workspace TEXT NOT NULL, provider_session_id TEXT UNIQUE,
 applied_model TEXT NOT NULL, pending_model TEXT,
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(id,conversation_id)
);
CREATE TABLE inputs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
 run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','reserved','completed','cancelled','interrupted')),
 album_id TEXT, ready_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(conversation_id,album_id),
 FOREIGN KEY(session_id,conversation_id) REFERENCES sessions(id,conversation_id) ON DELETE CASCADE
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
 input_id TEXT NOT NULL UNIQUE REFERENCES inputs(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL CHECK(generation > 0),
 status TEXT NOT NULL CHECK(status IN (${activeStates},'succeeded','failed','cancelled','interrupted')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(session_id,generation), UNIQUE(id,session_id),
 FOREIGN KEY(session_id,conversation_id) REFERENCES sessions(id,conversation_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_active_run_scope ON runs(conversation_id) WHERE status IN (${activeStates});
CREATE UNIQUE INDEX one_active_run_session ON runs(session_id) WHERE status IN (${activeStates});
CREATE TABLE incoming_updates (
 bot_id TEXT NOT NULL, update_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('message','control','ignored')), created_at INTEGER NOT NULL,
 PRIMARY KEY(bot_id,update_id)
);
CREATE TABLE incoming_messages (
 bot_id TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
 topic_id INTEGER NOT NULL DEFAULT 0, input_id TEXT REFERENCES inputs(id) ON DELETE SET NULL,
 payload TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(bot_id,chat_id,message_id)
);
CREATE TABLE incoming_albums (
 conversation_id TEXT NOT NULL REFERENCES conversations(id), album_id TEXT NOT NULL,
 input_id TEXT REFERENCES inputs(id) ON DELETE SET NULL, PRIMARY KEY(conversation_id,album_id)
);
CREATE TABLE controls (
 bot_id TEXT NOT NULL, callback_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(bot_id,callback_id)
);
CREATE TABLE polling_offsets (bot_id TEXT PRIMARY KEY, next_offset INTEGER NOT NULL);
CREATE TABLE requests (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL,
 run_id TEXT NOT NULL, generation INTEGER NOT NULL,
 payload TEXT NOT NULL, answer TEXT, draft TEXT NOT NULL DEFAULT '{}', prompt_message_id INTEGER,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','resolved','cancelled','invalidated','expired')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(session_id,conversation_id) REFERENCES sessions(id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) ON DELETE CASCADE
);
CREATE TABLE attachments (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('input','output','audio')),
 relative_path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), created_at INTEGER NOT NULL, expires_at INTEGER,
 FOREIGN KEY(session_id,conversation_id) REFERENCES sessions(id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) ON DELETE CASCADE
);
CREATE TABLE attachment_pins (
 attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE, pin_id TEXT NOT NULL,
 PRIMARY KEY(attachment_id,pin_id)
);
CREATE TABLE outbox (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT,
 dedup_key TEXT NOT NULL, payload TEXT NOT NULL, reply_to_message_id INTEGER,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
 attempts INTEGER NOT NULL DEFAULT 0, retry_base INTEGER NOT NULL DEFAULT 0, retry_after INTEGER, error_code TEXT,
 remote_message_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(conversation_id,dedup_key),
 FOREIGN KEY(session_id,conversation_id) REFERENCES sessions(id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) ON DELETE CASCADE
);
CREATE TABLE outbox_attachments (
 outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
 attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
 PRIMARY KEY(outbox_id,attachment_id)
);
CREATE INDEX inputs_queue ON inputs(status,ready_at);
CREATE INDEX requests_run ON requests(run_id,status);
CREATE INDEX outbox_queue ON outbox(status,retry_after,created_at);
`];

export class Connection {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version > migrations.length) throw new StateError("SCHEMA_TOO_NEW");
      this.atomic(() => {
        for (let index = version; index < migrations.length; index++) {
          this.db.exec(migrations[index]!);
          this.db.pragma(`user_version = ${index + 1}`);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  one(sql: string, ...values: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...values) as Row | undefined;
  }
  all(sql: string, ...values: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...values) as Row[];
  }
  exec(sql: string, ...values: SqlValue[]): number {
    return this.db.prepare(sql).run(...values).changes;
  }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  conversationId(scope: Scope): string | null {
    return this.one("SELECT id FROM conversations WHERE scope_key=?", scopeKey(scope))?.id as string | undefined ?? null;
  }
  ensureConversation(scope: Scope, now: number): string {
    assertScope(scope);
    const existing = this.conversationId(scope);
    if (existing) return existing;
    const id = randomUUID();
    this.exec("INSERT INTO conversations(id,scope_key,owner_id,bot_id,chat_id,topic_id,created_at) VALUES(?,?,?,?,?,?,?)",
      id, scopeKey(scope), scope.ownerId, scope.botId, scope.chatId, scope.topicId ?? 0, now);
    return id;
  }
  scope(conversationId: string): Scope {
    const row = this.one("SELECT owner_id,bot_id,chat_id,topic_id FROM conversations WHERE id=?", conversationId);
    if (!row) throw new StateError("CONVERSATION_NOT_FOUND");
    return { ownerId: row.owner_id as number, botId: row.bot_id as string, chatId: row.chat_id as number,
      topicId: row.topic_id === 0 ? null : row.topic_id as number };
  }
  session(scope: Scope, sessionId: string): Session | null {
    const row = this.one("SELECT * FROM sessions WHERE id=? AND conversation_id=?", sessionId, this.conversationId(scope));
    return row ? {
      id: row.id as string, conversationId: row.conversation_id as string, scope,
      agentId: row.agent_id as string, workspace: row.workspace as string,
      providerSessionId: row.provider_session_id as string | null, appliedModel: row.applied_model as string,
      pendingModel: row.pending_model as string | null, generation: row.generation as number,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number,
    } : null;
  }
  live(identity: RunIdentity): boolean {
    return !!this.one(`SELECT r.id FROM runs r JOIN sessions s ON s.id=r.session_id
      JOIN conversations c ON c.id=r.conversation_id
      WHERE r.id=? AND r.session_id=? AND r.generation=? AND r.conversation_id=?
      AND s.generation=r.generation AND c.current_session_id=r.session_id AND r.status IN (${liveStates})`,
    identity.runId, identity.sessionId, identity.generation, this.conversationId(identity.scope));
  }
}
