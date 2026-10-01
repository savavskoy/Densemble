import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StateStore } from "../ports.js";
import { attachmentStore } from "./attachments.js";
import { activeStates, Connection, StateError } from "./database.js";
import { inboxStore } from "./inbox.js";
import { outboxStore } from "./outbox.js";
import { requestStore } from "./requests.js";
import { runRow } from "./rows.js";
import { runStore } from "./runs.js";
import { sessionStore } from "./sessions.js";

function databasePath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new StateError("UNSAFE_DATABASE_PATH");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (realpathSync(dirname(absolute)) !== dirname(absolute)) throw new StateError("UNSAFE_DATABASE_PATH");
  return absolute;
}

export function openStore(options: { path: string }): StateStore {
  const path = databasePath(options.path);
  for (const suffix of ["-wal", "-shm", "-journal"]) databasePath(`${path}${suffix}`);
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  chmodSync(path, 0o600);
  const db = new Connection(path);
  const inbox = inboxStore(db);
  const outbox = outboxStore(db);
  const store: StateStore = {
    sessions: sessionStore(db), inbox, runs: runStore(db, outbox), requests: requestStore(db),
    outbox, attachments: attachmentStore(db),
    recover(now = Date.now()) {
      return db.atomic(() => {
        const interruptedRuns = db.all(`SELECT * FROM runs WHERE status IN (${activeStates})`).map((row) => runRow(db, row));
        for (const run of interruptedRuns) {
          db.exec("UPDATE runs SET status='interrupted',updated_at=? WHERE id=?", now, run.runId);
          db.exec("UPDATE inputs SET status='interrupted' WHERE run_id=?", run.runId);
          run.status = "interrupted";
          run.updatedAt = now;
        }
        const invalidatedRequests = db.exec("UPDATE requests SET status='invalidated' WHERE status IN ('pending','claimed')");
        const uncertainDeliveries = db.exec("UPDATE outbox SET status='uncertain',retry_after=NULL,error_code='PROCESS_INTERRUPTED',updated_at=? WHERE status='sending'", now);
        // Exclusive startup recovery invalidates process-local work, not durable delivery pins.
        db.exec("DELETE FROM attachment_pins");
        return { interruptedRuns, invalidatedRequests, uncertainDeliveries, queuedInputs: inbox.queued() };
      });
    },
    cleanup(options) {
      return db.atomic(() => {
        const requests = db.exec("DELETE FROM requests WHERE status IN ('resolved','cancelled','invalidated','expired') AND created_at<?", options.before);
        const outbox = db.exec("DELETE FROM outbox WHERE (status='sent' OR (status='failed' AND retry_after IS NULL)) AND updated_at<?", options.before);
        // Keep compact dedup/album tombstones; erase processed message bodies, not runtime history.
        const inputs = db.exec(`UPDATE incoming_messages SET payload=NULL WHERE payload IS NOT NULL AND created_at<?
          AND input_id IN(SELECT id FROM inputs WHERE status IN ('completed','cancelled','interrupted'))`, options.before);
        return { inputs, requests, outbox };
      });
    },
    async backup(destination) {
      const target = databasePath(destination);
      if (target === path || existsSync(target)) throw new StateError("BACKUP_DESTINATION_EXISTS");
      const descriptor = openSync(target, "wx", 0o600);
      const owned = fstatSync(descriptor);
      closeSync(descriptor);
      try {
        await db.db.backup(target);
      } catch (error) {
        const current = lstatSync(target, { throwIfNoEntry: false });
        if (current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(target);
        throw error;
      }
    },
    close() { db.db.close(); },
  };
  return store;
}
export { StateError } from "./database.js";
export { validAnswer } from "./requests.js";
