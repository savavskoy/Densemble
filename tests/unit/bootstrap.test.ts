import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";
import Database from "better-sqlite3";
import { Bot } from "grammy";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

describe("bootstrap", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "-p", "tsconfig.build.json"], {
      timeout: 30_000, stdio: "pipe",
    });
  }, 35_000);
  it("fails explicitly instead of starting an unconfigured service", () => {
    const entrypoint = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
    const result = spawnSync(process.execPath, [entrypoint], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Densemble is not configured");
    expect(result.stderr).toContain("config.local.json");
    expect(result.stderr).toContain("secrets.local.json");
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
