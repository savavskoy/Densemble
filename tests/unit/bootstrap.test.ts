import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";
import Database from "better-sqlite3";
import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("bootstrap", () => {
  it("fails explicitly instead of starting an unconfigured service", () => {
    const entrypoint = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
    const result = spawnSync(process.execPath, [entrypoint], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Densemble is not configured");
    expect(result.stderr).toContain("Copilot SDK integration gate");
    expect(result.stderr).toContain("not implemented");
  });

  it("loads the runtime dependencies without starting external services", () => {
    expect(typeof CopilotClient).toBe("function");
    expect(typeof Bot).toBe("function");
    expect(z.boolean().parse(false)).toBe(false);
  });

  it("loads the native SQLite binding without creating persistent data", () => {
    const database = new Database(":memory:");

    try {
      expect(database.prepare("SELECT 1 AS ready").get()).toEqual({ ready: 1 });
    } finally {
      database.close();
    }
  });
});
