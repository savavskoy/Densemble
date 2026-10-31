import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ProactiveItem, ProactiveOccurrenceOutcome } from "../../src/domain.js";
import { fixture, scope, until } from "./session-runtime-fixtures.js";

function occurrenceOutcomes(root: string, itemId: string): ProactiveOccurrenceOutcome[] {
  const db = new Database(`${root}/state.sqlite`, { readonly: true });
  try {
    return (db.prepare("SELECT outcome FROM proactive_occurrences WHERE item_id=? ORDER BY rowid")
      .all(itemId) as Array<{ outcome: ProactiveOccurrenceOutcome }>)
      .map((row) => row.outcome);
  } finally {
    db.close();
  }
}

function occurrenceCount(root: string): number {
  const db = new Database(`${root}/state.sqlite`, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM proactive_occurrences").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function createItem(f: ReturnType<typeof fixture>, options: Partial<Pick<ProactiveItem, "kind" | "purpose" | "schedule" | "nextDueAt">> = {}) {
  const nextDueAt = options.nextDueAt ?? Date.now();
  return f.store.proactivity.create(scope, {
    agentId: "synthetic-agent",
    kind: options.kind ?? "oneoff",
    schedule: options.schedule ?? { type: "once", at: nextDueAt },
    purpose: options.purpose ?? "Нагадати про синтетичну задачу",
    initiator: "oleh",
    nextDueAt,
    now: nextDueAt,
  });
}

async function startFixture() {
  const f = fixture();
  await f.app.start(f.store.recover());
  return f;
}

describe("proactive runtime integration", () => {
  it("triggers a oneoff proactive run, delivers one message, and settles the occurrence as sent", async () => {
    const f = await startFixture();
    try {
      const item = createItem(f, { purpose: "Нагадати про звіт" });
      expect(await f.app.triggerProactive(item)).toBe(true);
      await until(() => f.commands.some((command) => command.kind === "send"));
      const command = f.commands.at(-1);
      expect(command?.kind).toBe("send");
      if (!command || command.kind !== "send") throw new Error("EXPECTED_SEND_COMMAND");
      expect(command.input.text).toContain("Нагадати про звіт");

      f.emit({ ...command.identity, kind: "completed", text: "Готово: звіт нагадаю." });
      await f.app.drain();

      const textDeliveries = f.delivered.filter((item) => item.payload.kind === "text");
      expect(textDeliveries).toHaveLength(1);
      expect(textDeliveries[0]?.payload).toEqual({ kind: "text", text: "Готово: звіт нагадаю." });
      expect(occurrenceOutcomes(f.root, item.id)).toEqual(["sent"]);
    } finally {
      await f.close();
    }
  });

  it("refuses proactive triggering while a normal run is already active and leaves storage untouched", async () => {
    const f = await startFixture();
    try {
      await f.app.handle(f.message("Звичайний хід"));
      await until(() => f.commands.some((command) => command.kind === "send"));
      const item = createItem(f, {
        kind: "recurring",
        purpose: "Перевірити стан черги",
        schedule: { type: "interval", everyMs: 3_600_000 },
      });

      expect(await f.app.triggerProactive(item)).toBe(false);
      expect(f.commands.filter((command) => command.kind === "send")).toHaveLength(1);
      expect(occurrenceCount(f.root)).toBe(0);
      expect(f.store.proactivity.get(scope, item.id)).toMatchObject({ nextDueAt: item.nextDueAt, status: "active" });
    } finally {
      await f.close();
    }
  });

  it("batches same-scope due items into one run and advances sibling schedules immediately", async () => {
    const f = await startFixture();
    try {
      const now = Date.now();
      const first = createItem(f, {
        kind: "recurring",
        purpose: "Перший огляд",
        schedule: { type: "interval", everyMs: 3_600_000 },
        nextDueAt: now,
      });
      const second = createItem(f, {
        kind: "recurring",
        purpose: "Другий огляд",
        schedule: { type: "interval", everyMs: 3_600_000 },
        nextDueAt: now,
      });

      expect(await f.app.triggerProactive(first)).toBe(true);
      await until(() => f.commands.some((command) => command.kind === "send"));
      const command = f.commands.at(-1);
      expect(command?.kind).toBe("send");
      if (!command || command.kind !== "send") throw new Error("EXPECTED_SEND_COMMAND");
      expect(command.input.text).toContain("Перший огляд");
      expect(command.input.text).toContain("Другий огляд");
      expect(occurrenceCount(f.root)).toBe(2);

      const updatedSecond = f.store.proactivity.get(scope, second.id);
      expect(updatedSecond?.nextDueAt).toBeGreaterThan(second.nextDueAt!);

      expect(await f.app.triggerProactive(second)).toBe(false);
      expect(occurrenceCount(f.root)).toBe(2);

      f.emit({ ...command.identity, kind: "completed", text: "Обидва огляди виконано." });
      await f.app.drain();

      expect(f.delivered.filter((item) => item.payload.kind === "text")).toHaveLength(1);
      expect(occurrenceOutcomes(f.root, first.id)).toEqual(["sent"]);
      expect(occurrenceOutcomes(f.root, second.id)).toEqual(["sent"]);
    } finally {
      await f.close();
    }
  });

  it.each(["NO_PROACTIVE_MESSAGE", "  no_proactive_message  "])(
    "suppresses delivery for a silent sentinel reply (%s) and settles the occurrence as nothing",
    async (reply) => {
      const f = await startFixture();
      try {
        const item = createItem(f, {
          kind: "silent",
          purpose: "Тихо перевірити, чи є що сказати",
          schedule: { type: "interval", everyMs: 3_600_000 },
        });

        expect(await f.app.triggerProactive(item)).toBe(true);
        await until(() => f.commands.some((command) => command.kind === "send"));
        const command = f.commands.at(-1);
        expect(command?.kind).toBe("send");
        if (!command || command.kind !== "send") throw new Error("EXPECTED_SEND_COMMAND");

        f.emit({ ...command.identity, kind: "completed", text: reply });
        await f.app.drain();

        expect(f.delivered).toEqual([]);
        expect(occurrenceOutcomes(f.root, item.id)).toEqual(["nothing"]);
      } finally {
        await f.close();
      }
    },
  );

  it("sends a oneoff fallback notification on runtime failure and settles the occurrence as failed", async () => {
    const f = await startFixture();
    try {
      const item = createItem(f, { purpose: "Нагадати про борг до вечора" });
      expect(await f.app.triggerProactive(item)).toBe(true);
      await until(() => f.commands.some((command) => command.kind === "send"));
      const command = f.commands.at(-1);
      expect(command?.kind).toBe("send");
      if (!command || command.kind !== "send") throw new Error("EXPECTED_SEND_COMMAND");

      f.emit({ ...command.identity, kind: "failed", code: "MODEL_EXECUTION_FAILED" });
      await f.app.drain();

      const textDeliveries = f.delivered.filter((entry) => entry.payload.kind === "text");
      expect(textDeliveries.some((entry) =>
        entry.payload.kind === "text" &&
        entry.payload.text.includes("⏰ Нагадування не вдалося виконати через агента (одноразове): Нагадати про борг до вечора"),
      )).toBe(true);
      expect(occurrenceOutcomes(f.root, item.id)).toEqual(["failed"]);
    } finally {
      await f.close();
    }
  });

  it("admits negative synthetic ids and deduplicates them exactly once", async () => {
    const f = fixture();
    try {
      const session = f.store.sessions.create(scope, {
        agentId: "synthetic-agent",
        workspace: f.config.config.workspacePath,
        model: "model-one",
      });
      const ingress = f.message("Синтетичний проактивний тригер", scope, {
        updateId: -77,
        messageId: -77,
      });

      const first = f.store.inbox.admit(ingress, { sessionId: session.id, reserveRun: true, now: Date.now() });
      const duplicate = f.store.inbox.admit(ingress, { sessionId: session.id, reserveRun: true, now: Date.now() });

      expect(first.accepted).toBe(true);
      expect(first.run).not.toBeNull();
      expect(duplicate).toMatchObject({ accepted: false, disposition: "duplicate" });
      expect(duplicate.run?.runId).toBe(first.run?.runId);
    } finally {
      await f.close();
    }
  });
});
