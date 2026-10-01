import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireProcessLock } from "../../src/storage/process-lock.js";
import type { ProcessLock } from "../../src/storage/process-lock.js";

let root: string;
const held: ProcessLock[] = [];
beforeEach(() => {
  mkdirSync(resolve(".cache"), { recursive: true });
  root = mkdtempSync(resolve(".cache", "lock-test-"));
});
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  rmSync(root, { recursive: true });
});

describe("single service process ownership", () => {
  it("excludes another connection and permits ownership after idempotent release", () => {
    const first = acquireProcessLock(root);
    held.push(first);
    expect(() => acquireProcessLock(root)).toThrow("SERVICE_ALREADY_RUNNING");
    expect(statSync(join(root, "instance.sqlite")).mode & 0o777).toBe(0o600);
    first.release();
    first.release();
    held.push(acquireProcessLock(root));
  });

  it("rejects symlinked lock artifacts without touching their targets", () => {
    const outside = join(root, "do-not-change");
    writeFileSync(outside, "synthetic foreign file", { mode: 0o644 });
    symlinkSync(outside, join(root, "instance.sqlite"));
    expect(() => acquireProcessLock(root)).toThrow("UNSAFE_LOCK_PATH");
    expect(readFileSync(outside, "utf8")).toBe("synthetic foreign file");
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("releases the OS lock after an owning process crashes without PID-file recovery", async () => {
    const script = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { timeout: 0 });
      db.pragma('locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE; CREATE TABLE owner(id INTEGER PRIMARY KEY,pid INTEGER)');
      process.stdout.write('LOCKED\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script, join(root, "instance.sqlite")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "close");
    try {
      const ready = await Promise.race([
        once(child.stdout, "data").then(([data]) => String(data)),
        exited.then(() => { throw new Error("LOCK_CHILD_EXITED_EARLY"); }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("LOCK_CHILD_TIMEOUT")), 5_000).unref()),
      ]);
      expect(ready).toContain("LOCKED");
      expect(() => acquireProcessLock(root)).toThrow("SERVICE_ALREADY_RUNNING");
      child.kill("SIGKILL");
      await exited;
      held.push(acquireProcessLock(root));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
});
