import type { OutboxStore, RunStore } from "../ports.js";
import { activeStates, Connection, liveStates } from "./database.js";
import { runRow } from "./rows.js";

export function runStore(db: Connection, outbox: OutboxStore): RunStore {
  const store: RunStore = {
    active(scope) {
      const row = db.one(`SELECT * FROM runs WHERE conversation_id=? AND status IN (${activeStates})`, db.conversationId(scope));
      return row ? runRow(db, row) : null;
    },
    get(scope, runId) {
      const row = db.one("SELECT * FROM runs WHERE id=? AND conversation_id=?", runId, db.conversationId(scope));
      return row ? runRow(db, row) : null;
    },
    isLive: (identity) => db.live(identity),
    markRunning(identity, now = Date.now()) {
      return db.atomic(() => db.live(identity) && db.exec(`UPDATE runs SET status='running',updated_at=? WHERE id=? AND status IN (${liveStates})`, now, identity.runId) > 0);
    },
    markWaiting(identity, now = Date.now()) {
      return db.atomic(() => db.live(identity) && db.exec("UPDATE runs SET status='waiting',updated_at=? WHERE id=?", now, identity.runId) > 0);
    },
    cancel(identity, now = Date.now()) {
      return db.atomic(() => {
        if (!db.live(identity)) return false;
        db.exec("UPDATE runs SET status='cancelling',updated_at=? WHERE id=?", now, identity.runId);
        db.exec("UPDATE requests SET status='invalidated' WHERE run_id=? AND status IN ('pending','claimed')", identity.runId);
        db.exec("UPDATE inputs SET status='cancelled' WHERE session_id=? AND status='queued'", identity.sessionId);
        return true;
      });
    },
    finish(identity, status, now = Date.now()) {
      return db.atomic(() => {
        const run = store.get(identity.scope, identity.runId);
        if (!run || run.sessionId !== identity.sessionId || run.generation !== identity.generation ||
            !["preparing", "running", "waiting", "cancelling"].includes(run.status) ||
            (run.status === "cancelling" && status === "succeeded")) return false;
        db.exec("UPDATE runs SET status=?,updated_at=? WHERE id=?", status, now, identity.runId);
        db.exec("UPDATE requests SET status='invalidated' WHERE run_id=? AND status IN ('pending','claimed')", identity.runId);
        db.exec("UPDATE inputs SET status=? WHERE run_id=?", status === "interrupted" ? "interrupted" :
          status === "cancelled" ? "cancelled" : "completed", run.runId);
        if (status !== "interrupted") db.exec("UPDATE incoming_messages SET payload=NULL WHERE input_id IN(SELECT id FROM inputs WHERE run_id=?)", run.runId);
        return true;
      });
    },
    complete(identity, deliveries, now = Date.now()) {
      return db.atomic(() => {
        if (!db.live(identity)) return null;
        const items = deliveries.map((delivery) => outbox.enqueue({
          ...delivery, scope: identity.scope, sessionId: identity.sessionId, runId: identity.runId, now,
        }));
        store.finish(identity, "succeeded", now);
        return items;
      });
    },
  };
  return store;
}
