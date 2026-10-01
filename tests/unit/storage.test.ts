import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, RequestPayload, Run, Scope, Session } from "../../src/domain.js";
import { scopeKey } from "../../src/domain.js";
import type { StateStore } from "../../src/ports.js";
import { openStore, StateError, validAnswer } from "../../src/storage/index.js";

let root: string;
let path: string;
let store: StateStore;
const scope: Scope = { ownerId: 101, botId: "bot-one", chatId: 101, topicId: null };
function session(target = scope, now = 1): Session {
  return store.sessions.create(target, { agentId: "synthetic-agent", workspace: join(root, "workspace"), model: "model-one", now });
}
function message(target = scope, id = 1): IncomingMessage {
  return { kind: "message", scope: target, chatKind: target.topicId === null ? "private" : "forum",
    updateId: id, messageId: id, receivedAt: 10, text: "Synthetic input", attachments: [] };
}
function start(target = scope, id = 1): Run {
  const current = store.sessions.current(target) ?? session(target);
  return store.inbox.admit(message(target, id), { sessionId: current.id, reserveRun: true, now: 10 }).run!;
}
const question: RequestPayload = { kind: "question", fields: [
  { id: "first", prompt: "Choose", choices: ["A", "B"], multiple: true, allowFreeform: false },
  { id: "second", prompt: "Explain", choices: [], multiple: false, allowFreeform: true },
] };
const answer = { kind: "question" as const, answers: { first: ["A", "B"], second: ["Synthetic answer"] } };
beforeEach(() => {
  root = resolve(".cache", `storage-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "workspace"));
  path = join(root, "state.sqlite");
  store = openStore({ path });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("real SQLite migrations and scope isolation", () => {
  it("uses WAL, foreign keys, durable migrations and reopen without dropping data", () => {
    const created = session();
    store.close();
    const raw = new Database(path);
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    raw.close();
    store = openStore({ path });
    expect(store.sessions.current(scope)?.id).toBe(created.id);
  });
  it("normalizes null topics and separates owners, bots, chats and forum topics", () => {
    const scopes = [scope, { ...scope, ownerId: 102 }, { ...scope, botId: "bot-two" },
      { ...scope, chatId: 102 }, { ...scope, chatId: -201, topicId: 1 }, { ...scope, chatId: -201, topicId: 2 }];
    const sessions = scopes.map((candidate) => session(candidate));
    expect(new Set(sessions.map((item) => item.conversationId)).size).toBe(6);
    for (let index = 0; index < scopes.length; index++) {
      expect(store.sessions.list(scopes[index]!)).toHaveLength(1);
      expect(store.sessions.get(scopes[index]!, sessions[(index + 1) % scopes.length]!.id)).toBeNull();
    }
    expect(() => scopeKey({ ...scope, topicId: 0 })).toThrow("INVALID_SCOPE");
    expect(() => scopeKey({ ...scope, ownerId: Number.MAX_SAFE_INTEGER + 1 })).toThrow("INVALID_SCOPE");
  });
  it("rejects future schema versions rather than overwriting state", () => {
    const otherPath = join(root, "future.sqlite");
    const raw = new Database(otherPath);
    raw.pragma("user_version = 999");
    raw.close();
    expect(() => openStore({ path: otherPath })).toThrow("SCHEMA_TOO_NEW");
  });
  it("rejects symlink database paths", () => {
    const link = join(root, "link.sqlite");
    symlinkSync(path, link);
    expect(() => openStore({ path: link })).toThrow("UNSAFE_DATABASE_PATH");
    const dangling = join(root, "dangling.sqlite");
    symlinkSync(join(root, "missing.sqlite"), dangling);
    expect(() => openStore({ path: dangling })).toThrow("UNSAFE_DATABASE_PATH");
    const unsafeSidecar = join(root, "sidecar.sqlite");
    symlinkSync(join(root, "outside-wal"), `${unsafeSidecar}-wal`);
    expect(() => openStore({ path: unsafeSidecar })).toThrow("UNSAFE_DATABASE_PATH");
  });
});

describe("durable ingress, albums, offsets and run reservation", () => {
  it("isolates active runs across bots/chats/topics while deduplicating topic-rewritten messages", () => {
    const targets = [scope, { ...scope, botId: "bot-two" }, { ...scope, chatId: 102 },
      { ...scope, chatId: -201, topicId: 1 }, { ...scope, chatId: -201, topicId: 2 }];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!;
      const current = session(target);
      const incoming = { ...message(target, index + 1), messageId: target.topicId === null ? 1 : index + 1 };
      expect(store.inbox.admit(incoming, { sessionId: current.id, reserveRun: true }).accepted).toBe(true);
    }
    expect(new Set(targets.map((target) => store.runs.active(target)?.runId)).size).toBe(5);
    const wrongTopic = targets[4]!;
    const duplicate = store.inbox.admit({ ...message(wrongTopic, 6), messageId: 4 },
      { sessionId: store.sessions.current(wrongTopic)!.id, reserveRun: true });
    expect(duplicate).toMatchObject({ accepted: false, input: null, run: null });
  });
  it("accepts once atomically and deduplicates updates AND message IDs", () => {
    const current = session();
    const accepted = store.inbox.admit(message(), { sessionId: current.id, reserveRun: true, now: 10 });
    expect(accepted.accepted).toBe(true);
    expect(accepted.run?.status).toBe("preparing");
    expect(accepted.input?.status).toBe("reserved");
    expect(store.inbox.admit(message(), { sessionId: current.id, reserveRun: true }).accepted).toBe(false);
    expect(store.inbox.admit({ ...message(), updateId: 2 }, { sessionId: current.id, reserveRun: true }).run?.runId).toBe(accepted.run?.runId);
    expect(store.inbox.acknowledge(scope.botId, 2)).toBe(3);
    expect(store.inbox.acknowledge(scope.botId, 1)).toBe(3);
    expect(store.inbox.offset("bot-two")).toBe(0);
    expect(() => store.inbox.acknowledge(scope.botId, 3)).toThrow("UPDATE_NOT_DURABLE");
  });
  it("rolls admission back if reservation fails and permits a safe retry", () => {
    const current = session();
    const raw = new Database(path);
    raw.exec("CREATE TRIGGER reject_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'synthetic-fault'); END;");
    expect(() => store.inbox.admit(message(), { sessionId: current.id, reserveRun: true, now: 10 })).toThrow("synthetic-fault");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM incoming_updates").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM inputs").get()).toEqual({ n: 0 });
    expect(store.sessions.current(scope)?.generation).toBe(0);
    raw.exec("DROP TRIGGER reject_run");
    raw.close();
    expect(store.inbox.admit(message(), { sessionId: current.id, reserveRun: true }).accepted).toBe(true);
  });
  it("keeps a second input queued without reserving another run", () => {
    const first = start();
    const second = store.inbox.admit(message(scope, 2), { sessionId: first.sessionId, reserveRun: true, now: 11 });
    expect(second.run).toBeNull();
    expect(second.input?.status).toBe("queued");
    expect(store.inbox.reserve(scope, second.input!.id, 12)).toBeNull();
    expect(store.runs.finish(first, "succeeded")).toBe(true);
    const next = store.inbox.reserve(scope, second.input!.id, 13)!;
    expect(next.generation).toBe(first.generation + 1);
    expect(store.runs.isLive(first)).toBe(false);
    expect(store.runs.isLive(next)).toBe(true);
  });
  it("attaches steering exactly once to a live generation and completes it with the root", () => {
    const run = start();
    const input = store.inbox.admit(message(scope, 2), { sessionId: run.sessionId, now: 20 }).input!;
    expect(store.inbox.attachToRun({ ...run, generation: 999 }, input.id, 20)).toBeNull();
    expect(store.inbox.attachToRun(run, input.id, 20)).toMatchObject({ runId: run.runId, status: "reserved" });
    expect(store.inbox.attachToRun(run, input.id, 20)).toBeNull();
    expect(store.runs.finish(run, "succeeded", 30)).toBe(true);
    expect(store.inbox.get(scope, input.id)).toMatchObject({ status: "completed", messages: [] });
  });
  it("does not let later text overtake a collecting album in the same session", () => {
    const current = session();
    const album = store.inbox.admit({ ...message(), mediaGroupId: "album" }, { sessionId: current.id, now: 10, albumDelayMs: 100 }).input!;
    const text = store.inbox.admit(message(scope, 2), { sessionId: current.id, reserveRun: true, now: 20 }).input!;
    expect(store.runs.active(scope)).toBeNull();
    expect(store.inbox.reserve(scope, text.id, 110)).toBeNull();
    expect(store.inbox.reserve(scope, album.id, 110)).not.toBeNull();
  });
  it("enforces active uniqueness in SQLite itself, including a second connection", () => {
    const first = start();
    const raw = new Database(path);
    expect(() => raw.prepare(`INSERT INTO runs SELECT 'other',conversation_id,session_id,input_id,99,'running',1,1 FROM runs WHERE id=?`)
      .run(first.runId)).toThrow(/UNIQUE constraint failed/);
    raw.close();
    const second = openStore({ path });
    try { expect(second.inbox.reserve(scope, first.inputId)).toBeNull(); }
    finally { second.close(); }
  });
  it("aggregates an album with caption once, dedups parts and explicitly rejects late parts", () => {
    const current = session();
    const first = { ...message(), mediaGroupId: "synthetic-album", attachments: [{ kind: "photo" as const, fileId: "file-one" }] };
    const accepted = store.inbox.admit(first, { sessionId: current.id, reserveRun: true, albumDelayMs: 50, now: 10 });
    expect(accepted.run).toBeNull();
    const second = store.inbox.admit({ ...first, updateId: 2, messageId: 2, text: "", attachments: [{ kind: "photo", fileId: "file-two" }] },
      { sessionId: current.id, albumDelayMs: 50, now: 20 });
    expect(second.input?.id).toBe(accepted.input?.id);
    expect(second.input?.messages.map((part) => part.text)).toEqual(["Synthetic input", ""]);
    expect(store.inbox.reserve(scope, second.input!.id, 69)).toBeNull();
    expect(store.inbox.reserve(scope, second.input!.id, 70)).not.toBeNull();
    expect(store.inbox.admit({ ...first, updateId: 3, messageId: 3 }, { sessionId: current.id, now: 80 }).disposition).toBe("late-album");
    expect(store.inbox.get(scope, second.input!.id)?.messages).toHaveLength(2);
  });
  it("makes callbacks and message controls separately idempotent", () => {
    const callback = { kind: "callback" as const, scope, chatKind: "private" as const, updateId: 1, messageId: 1,
      callbackId: "opaque-callback", receivedAt: 10, data: "opaque-request" };
    expect(store.inbox.recordControl(callback)).toBe(true);
    expect(store.inbox.recordControl({ ...callback, updateId: 2 })).toBe(false);
    expect(store.inbox.acknowledge(scope.botId, 2)).toBe(3);
    expect(store.inbox.recordControl(message(scope, 3))).toBe(true);
    expect(store.inbox.recordControl({ ...message(scope, 3), updateId: 4 })).toBe(false);
    expect(store.inbox.recordIgnored(scope.botId, 5)).toBe(true);
    expect(store.inbox.acknowledge(scope.botId, 5)).toBe(6);
  });
  it("retains album tombstones after explicit session deletion", () => {
    const current = session();
    store.inbox.admit({ ...message(), mediaGroupId: "album" }, { sessionId: current.id, now: 10 });
    store.sessions.delete(scope, current.id);
    const next = session();
    const late = store.inbox.admit({ ...message(scope, 2), mediaGroupId: "album" }, { sessionId: next.id, now: 20 });
    expect(late).toMatchObject({ accepted: false, disposition: "late-album", input: null });
    expect(store.inbox.queued()).toEqual([]);
  });
  it("does not accept a new input into an inactive session", () => {
    const old = session();
    session(scope, 2);
    expect(() => store.inbox.admit(message(), { sessionId: old.id })).toThrow("SESSION_NOT_CURRENT");
    expect(() => store.inbox.acknowledge(scope.botId, 1)).toThrow("UPDATE_NOT_DURABLE");
  });
});

describe("pending requests and lifecycle guards", () => {
  it("rejects malformed and schema-incompatible answers without throwing", () => {
    for (const candidate of [null, {}, [], { kind: "permission", approved: "yes" },
      { kind: "question", answers: null }, { kind: "question", answers: { first: ["A"], second: ["text"], extra: [] } }]) {
      expect(validAnswer(question, candidate)).toBe(false);
    }
    expect(validAnswer({ kind: "permission", action: "Example", parameters: {} }, { kind: "permission", approved: false })).toBe(true);
  });
  it("atomically claims the first valid answer only, including across store connections", () => {
    const run = start();
    const request = store.requests.create(run, question, { expiresAt: 100, now: 10 });
    expect(request.id.length).toBeLessThanOrEqual(40);
    expect(store.requests.claim(run, request.id, { kind: "question", answers: { first: ["invalid"] } }, 20)).toBeNull();
    expect(store.requests.saveDraft(run, request.id, { first: ["A"] }, 20)).toBe(true);
    expect(store.requests.setPrompt(scope, request.id, 99)).toBe(true);
    expect(store.requests.get(scope, request.id)?.draft).toEqual({ first: ["A"] });
    expect(store.requests.claim(run, request.id, answer, 20)?.status).toBe("claimed");
    const second = openStore({ path });
    try { expect(second.requests.claim(run, request.id, answer, 20)).toBeNull(); }
    finally { second.close(); }
    expect(store.requests.resolve(run, request.id)).toBe(true);
    expect(store.requests.resolve(run, request.id)).toBe(false);
  });
  it("rejects another owner, scope, session, run or generation and expired responses", () => {
    const run = start();
    const request = store.requests.create(run, question, { expiresAt: 100, now: 10 });
    for (const identity of [
      { ...run, scope: { ...scope, ownerId: 999 } }, { ...run, scope: { ...scope, chatId: -201, topicId: 1 } },
      { ...run, sessionId: "other" }, { ...run, runId: "other" }, { ...run, generation: run.generation + 1 },
    ]) expect(store.requests.claim(identity, request.id, answer, 20)).toBeNull();
    expect(store.requests.claim(run, request.id, answer, 100)).toBeNull();
    expect(store.requests.expire(100)).toBe(1);
    expect(store.requests.get(scope, request.id)?.status).toBe("expired");
  });
  it("invalidates pending answers and queued steering immediately on cancelling", () => {
    const run = start();
    const request = store.requests.create(run, { kind: "permission", action: "synthetic action", parameters: { amount: 1 } }, { now: 10, expiresAt: 100 });
    const queued = store.inbox.admit(message(scope, 2), { sessionId: run.sessionId, now: 20 });
    expect(store.runs.cancel(run, 30)).toBe(true);
    expect(store.runs.isLive(run)).toBe(false);
    expect(store.requests.claim(run, request.id, { kind: "permission", approved: true }, 40)).toBeNull();
    expect(store.requests.get(scope, request.id)?.status).toBe("invalidated");
    expect(store.inbox.get(scope, queued.input!.id)?.status).toBe("cancelled");
    expect(store.runs.finish(run, "succeeded")).toBe(false);
    expect(store.runs.finish(run, "cancelled")).toBe(true);
  });
  it("denies callbacks after completion and preserves isolation of a neighboring run", () => {
    const run = start();
    const other = start({ ...scope, botId: "bot-two" });
    const request = store.requests.create(run, question, { now: 10, expiresAt: 100 });
    store.runs.finish(run, "failed");
    expect(store.requests.claim(run, request.id, answer, 20)).toBeNull();
    expect(store.runs.isLive(other)).toBe(true);
  });
});

describe("session models, ownership and deletion", () => {
  it("keeps requested models pending until a successful boundary application", () => {
    const current = session();
    expect(store.sessions.requestModel(scope, current.id, "model-two")).toBe(true);
    expect(store.sessions.current(scope)).toMatchObject({ appliedModel: "model-one", pendingModel: "model-two" });
    const run = start();
    expect(store.sessions.applyModel(scope, current.id, "model-two")).toBe(false);
    store.runs.finish(run, "succeeded");
    expect(store.sessions.applyModel(scope, current.id, "model-stale")).toBe(false);
    expect(store.sessions.applyModel(scope, current.id, "model-two")).toBe(true);
    expect(store.sessions.current(scope)).toMatchObject({ appliedModel: "model-two", pendingModel: null });
    store.sessions.requestModel(scope, current.id, "model-three");
    store.sessions.clearPendingModel(scope, current.id, "model-stale");
    expect(store.sessions.current(scope)?.pendingModel).toBe("model-three");
    store.sessions.clearPendingModel(scope, current.id, "model-three");
    expect(store.sessions.current(scope)?.appliedModel).toBe("model-two");
  });
  it("creates a clean default model while preserving scoped old-session resume", () => {
    const old = session();
    store.sessions.setProviderSessionId(scope, old.id, "provider-synthetic");
    store.sessions.requestModel(scope, old.id, "model-two");
    store.sessions.applyModel(scope, old.id, "model-two");
    const newer = session(scope, 2);
    expect(store.sessions.current(scope)?.appliedModel).toBe("model-one");
    expect(store.sessions.activate(scope, old.id)).toBe(true);
    expect(store.sessions.current(scope)).toMatchObject({ appliedModel: "model-two", providerSessionId: "provider-synthetic" });
    const run = start();
    expect(store.sessions.activate(scope, newer.id)).toBe(false);
    expect(() => session()).toThrow("ACTIVE_RUN");
    expect(store.sessions.setProviderSessionId(scope, old.id, "different-provider")).toBe(false);
    store.runs.finish(run, "cancelled");
  });
  it("guards deletion, returns only owned artifacts and never deletes workspace files", () => {
    const run = start();
    const workspaceFile = join(root, "workspace/keep.txt");
    writeFileSync(workspaceFile, "keep");
    const file = store.attachments.add({
      scope, sessionId: run.sessionId, runId: run.runId, kind: "input", relativePath: "synthetic/file.txt",
      fileName: "example.txt", mimeType: "text/plain", sizeBytes: 1, expiresAt: 100,
    });
    expect(store.sessions.delete({ ...scope, chatId: 999 }, run.sessionId)).toBeNull();
    expect(() => store.sessions.delete(scope, run.sessionId)).toThrow("SESSION_BUSY");
    store.runs.finish(run, "cancelled");
    const deletion = store.sessions.delete(scope, run.sessionId);
    expect(deletion?.artifacts).toEqual([file]);
    expect(store.sessions.current(scope)).toBeNull();
    expect(store.sessions.list(scope)).toEqual([]);
    expect(readFileSync(workspaceFile, "utf8")).toBe("keep");
    const replacement = session();
    expect(store.inbox.admit(message(), { sessionId: replacement.id }).accepted).toBe(false);
  });
  it("deletes pending delivery references before their owned attachments, preserving neighboring sessions", () => {
    const current = session();
    const neighboring = session({ ...scope, botId: "bot-two" });
    const attachment = store.attachments.add({ scope, sessionId: current.id, runId: null, kind: "output",
      relativePath: "synthetic/file.txt", fileName: "file.txt", mimeType: "text/plain", sizeBytes: 1 });
    store.outbox.enqueue({ scope, sessionId: current.id, dedupKey: "file", payload: { kind: "file", attachmentId: attachment.id } });
    expect(store.sessions.delete(scope, current.id)?.artifacts).toEqual([attachment]);
    expect(store.outbox.list(scope)).toEqual([]);
    expect(store.sessions.current(neighboring.scope)?.id).toBe(neighboring.id);
  });
});

describe("outbox persistence, pinning and recovery", () => {
  it("commits results before delivery and atomically completes live runs only", () => {
    const run = start();
    const payload = { kind: "text" as const, text: "Synthetic result" };
    const items = store.runs.complete(run, [{ dedupKey: "result", payload }], 20)!;
    expect(items[0]?.status).toBe("pending");
    expect(store.runs.get(scope, run.runId)?.status).toBe("succeeded");
    expect(store.runs.complete(run, [{ dedupKey: "other", payload }])).toBeNull();
    expect(store.outbox.enqueue({ scope, sessionId: run.sessionId, runId: run.runId, dedupKey: "result", payload }).id).toBe(items[0]?.id);
    expect(() => store.outbox.enqueue({ scope, sessionId: run.sessionId, dedupKey: "result", payload })).toThrow("DELIVERY_KEY_CONFLICT");
    const delivery = store.outbox.claim({ now: 30 })!;
    expect(delivery.attempts).toBe(1);
    expect(store.outbox.settle(delivery.id, 1, { status: "sent", remoteMessageIds: [99] }, 40)).toBe(true);
    expect(store.outbox.settle(delivery.id, 1, { status: "uncertain" }, 41)).toBe(false);
  });
  it("rolls back completion if any result cannot be persisted", () => {
    const run = start();
    expect(() => store.runs.complete(run, [
      { dedupKey: "one", payload: { kind: "text", text: "one" } },
      { dedupKey: "two", payload: { kind: "file", attachmentId: "missing" } },
    ])).toThrow("ATTACHMENT_NOT_FOUND");
    expect(store.outbox.list(scope)).toEqual([]);
    expect(store.runs.isLive(run)).toBe(true);
  });
  it("marks crash-sending uncertain, keeps queued inputs, invalidates callbacks, never replays interrupted runs", () => {
    const run = start();
    const request = store.requests.create(run, question, { now: 10, expiresAt: 100 });
    const queued = store.inbox.admit(message(scope, 2), { sessionId: run.sessionId, now: 20 }).input!;
    const item = store.outbox.enqueue({ scope, sessionId: run.sessionId, runId: run.runId, dedupKey: "progress", payload: { kind: "text", text: "Synthetic progress" } });
    store.outbox.claim();
    store.close();
    store = openStore({ path });
    const recovery = store.recover(30);
    expect(recovery.interruptedRuns.map((item) => item.runId)).toEqual([run.runId]);
    expect(recovery.queuedInputs.map((item) => item.id)).toEqual([queued.id]);
    expect(recovery.invalidatedRequests).toBe(1);
    expect(recovery.uncertainDeliveries).toBe(1);
    expect(store.requests.get(scope, request.id)?.status).toBe("invalidated");
    expect(store.inbox.reserve(scope, run.inputId)).toBeNull();
    expect(store.outbox.claim()).toBeNull();
    expect(store.outbox.retry(scope, item.id)).toBe(false);
    expect(store.outbox.retry(scope, item.id, { allowUncertain: true })).toBe(true);
    expect(store.outbox.claim()?.attempts).toBe(2);
    expect(store.recover().interruptedRuns).toEqual([]);
  });
  it("honors bounded retries and retryAfter while allowing explicit retry without resetting attempt identity", () => {
    const current = session();
    const item = store.outbox.enqueue({ scope, sessionId: current.id, dedupKey: "retry", payload: { kind: "text", text: "Result" }, now: 10 });
    const first = store.outbox.claim({ now: 10, maxAttempts: 1 })!;
    store.outbox.settle(item.id, first.attempts, { status: "failed", errorCode: "RATE_LIMIT", retryAfter: 50 }, 20);
    expect(store.outbox.claim({ now: 40, maxAttempts: 2 })).toBeNull();
    const second = store.outbox.claim({ now: 50, maxAttempts: 2 })!;
    expect(second.attempts).toBe(2);
    store.outbox.settle(item.id, second.attempts, { status: "failed", errorCode: "RATE_LIMIT", retryAfter: 70 }, 60);
    expect(store.outbox.claim({ now: 70, maxAttempts: 2 })).toBeNull();
    expect(store.outbox.get(scope, item.id)).toMatchObject({ status: "failed", retryAfter: null, errorCode: "RETRY_EXHAUSTED" });
    expect(store.outbox.retry(scope, item.id)).toBe(true);
    expect(store.outbox.claim({ maxAttempts: 2 })?.attempts).toBe(3);
    expect(store.outbox.settle(item.id, first.attempts, { status: "sent" })).toBe(false);
  });
  it("accepts an already elapsed retryAfter as ready rather than losing delivery state", () => {
    const current = session();
    const item = store.outbox.enqueue({ scope, sessionId: current.id, dedupKey: "elapsed", payload: { kind: "text", text: "Result" }, now: 10 });
    store.outbox.claim({ now: 20 });
    expect(store.outbox.settle(item.id, 1, { status: "failed", retryAfter: 25 }, 30)).toBe(true);
    expect(store.outbox.claim({ now: 30 })?.attempts).toBe(2);
  });
  it("pins expiring artifacts until terminal delivery or explicit discard", () => {
    const current = session();
    const attachment = store.attachments.add({ scope, sessionId: current.id, runId: null, kind: "output",
      relativePath: "synthetic/file.txt", fileName: "../untrusted-name.txt", mimeType: "text/plain", sizeBytes: 1, createdAt: 1, expiresAt: 10 });
    const item = store.outbox.enqueue({ scope, sessionId: current.id, dedupKey: "file", payload: { kind: "file", attachmentId: attachment.id } });
    expect(store.outbox.pinnedAttachmentIds()).toEqual([attachment.id]);
    expect(store.attachments.expired(100)).toEqual([]);
    expect(store.attachments.removeExpired(attachment.id, 100)).toBeNull();
    const sending = store.outbox.claim()!;
    expect(() => store.sessions.delete(scope, current.id)).toThrow("SESSION_BUSY");
    store.outbox.settle(item.id, sending.attempts, { status: "uncertain" });
    expect(store.attachments.expired(100)).toEqual([]);
    store.outbox.discard(scope, item.id);
    expect(store.attachments.expired(100).map((file) => file.id)).toEqual([attachment.id]);
    expect(store.attachments.removeExpired(attachment.id, 100)?.relativePath).toBe("synthetic/file.txt");
    expect(() => store.outbox.retry(scope, item.id)).toThrow("ATTACHMENT_EXPIRED");
  });
  it("supports independent processing pins and safe attachment references", () => {
    const current = session();
    const input = { scope, sessionId: current.id, runId: null, kind: "input" as const, relativePath: "synthetic/file.txt",
      fileName: "file.txt", mimeType: "text/plain", sizeBytes: 1, createdAt: 1, expiresAt: 10 };
    for (const relativePath of ["../outside", "/absolute", "x/../file", "x\\file", "./file"]) {
      expect(() => store.attachments.add({ ...input, relativePath })).toThrow("INVALID_ATTACHMENT");
    }
    const attachment = store.attachments.add(input);
    expect(store.attachments.pin({ ...scope, ownerId: 102 }, attachment.id, "pin")).toBe(false);
    expect(store.attachments.pin(scope, attachment.id, "pin")).toBe(true);
    expect(() => store.sessions.delete(scope, current.id)).toThrow("SESSION_BUSY");
    expect(store.attachments.expired(100)).toEqual([]);
    expect(store.attachments.unpin("pin")).toBe(1);
    expect(store.attachments.removeExpired(attachment.id, 100)).not.toBeNull();
  });
  it("defaults input retention to seven days and audio expiry to immediate cleanup", () => {
    const current = session();
    const input = { scope, sessionId: current.id, runId: null, kind: "input" as const, relativePath: "synthetic/file.txt",
      fileName: "file.txt", mimeType: "text/plain", sizeBytes: 1, createdAt: 1 };
    expect(store.attachments.add(input).expiresAt).toBe(1 + 7 * 24 * 60 * 60 * 1000);
    expect(store.attachments.add({ ...input, kind: "audio", relativePath: "synthetic/voice.ogg" }).expiresAt).toBe(1);
    expect(() => store.attachments.add({ ...input, expiresAt: null })).toThrow("INVALID_ATTACHMENT");
  });
  it("releases abandoned processing pins at recovery but retains uncertain delivery artifacts", () => {
    const run = start();
    const artifact = { scope, sessionId: run.sessionId, runId: run.runId,
      fileName: "file.txt", mimeType: "text/plain", sizeBytes: 1, createdAt: 1, expiresAt: 10 };
    const audio = store.attachments.add({ ...artifact, kind: "audio", relativePath: "synthetic/voice.wav" });
    const output = store.attachments.add({ ...artifact, kind: "output", relativePath: "synthetic/output.txt" });
    store.attachments.pin(scope, audio.id, "abandoned-asr");
    store.attachments.pin(scope, output.id, "abandoned-export");
    store.outbox.enqueue({ scope, sessionId: run.sessionId, dedupKey: "file",
      payload: { kind: "file", attachmentId: output.id } });
    store.outbox.claim();
    store.close();
    store = openStore({ path });
    store.recover(100);
    expect(store.attachments.expired(100).map((item) => item.id)).toEqual([audio.id]);
    expect(store.outbox.pinnedAttachmentIds()).toEqual([output.id]);
    expect(store.attachments.unpin("abandoned-asr")).toBe(0);
    expect(store.sessions.delete(scope, run.sessionId)?.sessionId).toBe(run.sessionId);
  });
  it("backs up SQLite safely and keeps compact dedup after payload cleanup", async () => {
    const run = start();
    store.runs.complete(run, [{ dedupKey: "result", payload: { kind: "text", text: "Synthetic result" } }], 20);
    const delivery = store.outbox.claim({ now: 30 })!;
    store.outbox.settle(delivery.id, delivery.attempts, { status: "sent" }, 40);
    const backup = join(root, "backup.sqlite");
    const copying = store.backup(backup);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    await copying;
    const restored = openStore({ path: backup });
    try {
      expect(restored.sessions.current(scope)?.id).toBe(run.sessionId);
      expect(restored.outbox.get(scope, delivery.id)?.status).toBe("sent");
    } finally { restored.close(); }
    await expect(store.backup(backup)).rejects.toThrow("BACKUP_DESTINATION_EXISTS");
    expect(store.cleanup({ before: 100 }).outbox).toBe(1);
    expect(store.inbox.admit(message(), { sessionId: run.sessionId }).accepted).toBe(false);
    expect(store.inbox.get(scope, run.inputId)?.messages).toEqual([]);
  });
  it("removes only its own incomplete backup when SQLite rejects copying", async () => {
    const backup = join(root, "failed-backup.sqlite");
    store.close();
    try {
      await expect(store.backup(backup)).rejects.toThrow();
      expect(existsSync(backup)).toBe(false);
    } finally {
      store = openStore({ path });
    }
  });
  it("exposes only sanitized fixed error codes", () => {
    expect(new StateError("EXAMPLE").message).toBe("EXAMPLE");
    const current = session();
    const item = store.outbox.enqueue({ scope, sessionId: current.id, dedupKey: "result", payload: { kind: "text", text: "Result" } });
    store.outbox.claim();
    expect(() => store.outbox.settle(item.id, 1, { status: "failed", errorCode: "secret text and arguments" })).toThrow("INVALID_ERROR_CODE");
  });
});
