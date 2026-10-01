import { describe, expect, it } from "vitest";
import { createDiagnostics } from "../../src/operations/diagnostics.js";

describe("content-free service diagnostics", () => {
  it("logs fixed codes and approved scalar fields without exception contents or tokens", () => {
    const lines: string[] = [];
    const sink = createDiagnostics({ botIds: ["example-bot"], write: (line) => { lines.push(line); } });
    sink.record("DELIVERY_RETRY", {
      botId: "example-bot", attempt: 2, error: "synthetic-secret-token", document: "private text",
      count: "even a string in a numeric field is excluded", forced: false,
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ code: "DELIVERY_RETRY", botId: "example-bot", attempt: 2, forced: false });
    expect(lines[0]).not.toMatch(/secret|private|document|error|count/);
    sink.record("exception with synthetic-secret-token", { botId: "unregistered-secret-alias" });
    expect(lines[1]).toContain("UNSAFE_DIAGNOSTIC_CODE");
    expect(lines[1]).not.toContain("synthetic-secret-token");
    expect(lines[1]).not.toContain("unregistered-secret-alias");
  });
});
