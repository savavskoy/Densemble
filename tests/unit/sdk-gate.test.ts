import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  bounded, CLI_VERSION, completeChecks, GateError, parseGateArgs,
  REQUIRED_CONTRACTS, safeError, SDK_VERSION, summarize,
} from "../../src/agents/sdk-gate/contracts.js";
import type { Check } from "../../src/agents/sdk-gate/contracts.js";
import {
  descendants, parseProcessList, pinnedCli, processes, sameProcess, signalOwned,
} from "../../src/agents/sdk-gate/runtime.js";
import type { ProcessIdentity } from "../../src/agents/sdk-gate/runtime.js";

const root: ProcessIdentity = {
  pid: 10, parent: 5, started: "Thu Oct  1 23:00:00 2026",
  command: "/synthetic/runtime", state: "S",
};

describe("SDK gate bookkeeping (offline, not runtime contract evidence)", () => {
  it("requires explicit real opt-in", () => {
    expect(parseGateArgs([])).toEqual({ real: false, readinessOnly: false });
    expect(parseGateArgs(["--readiness"])).toEqual({ real: false, readinessOnly: true });
    expect(parseGateArgs(["--real", "--readiness"])).toEqual({ real: true, readinessOnly: true });
    expect(() => parseGateArgs(["--approve-all"])).toThrow("UNKNOWN_GATE_ARGUMENT");
  });

  it("checks the actually installed pinned packages without starting the CLI", () => {
    expect(SDK_VERSION).toBe("1.0.16");
    expect(CLI_VERSION).toBe("1.0.91");
    expect(existsSync(pinnedCli())).toBe(true);
  });

  it("does not turn missing, blocked, or skipped contracts into passes", () => {
    for (const status of ["BLOCKED", "SKIPPED"] as const) {
      const checks = completeChecks([], status, "AUTHENTICATION_REQUIRED");
      expect(checks).toHaveLength(REQUIRED_CONTRACTS.length);
      expect(checks.every((check) => check.status === status)).toBe(true);
      expect(summarize(checks)).toBe("BLOCKED");
    }
    expect(summarize([])).toBe("BLOCKED");
  });

  it("requires exactly one passing result for every required contract", () => {
    const checks: Check[] = REQUIRED_CONTRACTS.map((contract) =>
      ({ contract, status: "PASS", evidence: "synthetic-test-only" }));
    expect(summarize(checks)).toBe("PASS");
    expect(summarize(checks.slice(1))).toBe("BLOCKED");
    expect(summarize([...checks, checks[0]!])).toBe("BLOCKED");
    expect(summarize([...checks, { contract: "cleanup", status: "FAIL", evidence: "test" }])).toBe("FAIL");
  });

  it("preserves observed failures when completing the matrix", () => {
    const observed: Check[] = [{ contract: "cleanup", status: "FAIL", evidence: "OWNED_PROCESS_SURVIVED_CLEANUP" }];
    const complete = completeChecks(observed, "BLOCKED", "AUTHENTICATION_REQUIRED");
    expect(observed).toHaveLength(1);
    expect(complete.find((check) => check.contract === "cleanup")).toEqual(observed[0]);
    expect(summarize(complete)).toBe("FAIL");
  });

  it("withholds all upstream error contents, paths, and credentials", () => {
    const secret = "synthetic-sensitive-value";
    expect(safeError(new Error(`token=${secret} /private/example/config`))).toBe("UPSTREAM_ERROR_REDACTED");
    expect(safeError(secret)).toBe("UPSTREAM_ERROR_REDACTED");
    expect(safeError({ code: secret, message: secret })).toBe("UPSTREAM_ERROR_REDACTED");
    expect(safeError(new GateError("AUTH_TIMEOUT"))).toBe("AUTH_TIMEOUT");
  });

  it("returns successful bounded results and propagates immediate failures", async () => {
    await expect(bounded(Promise.resolve(42), 100, "TIMEOUT")).resolves.toBe(42);
    await expect(bounded(Promise.reject(new GateError("REJECTED")), 100, "TIMEOUT")).rejects.toThrow("REJECTED");
  });

  it("times out an unresolved RPC without treating the timeout as completion", async () => {
    await expect(bounded(new Promise<never>(() => {}), 5, "RPC_TIMEOUT")).rejects.toThrow("RPC_TIMEOUT");
  });

  it("keeps late rejection handled after timing out (timeout does not cancel work)", async () => {
    let rejectLate: (error: Error) => void = () => {};
    const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    await expect(bounded(pending, 5, "RPC_TIMEOUT")).rejects.toThrow("RPC_TIMEOUT");
    rejectLate(new Error("synthetic late failure"));
    await delay(1);
  });
});

describe("process identity helpers (synthetic snapshots)", () => {
  it("parses identity and stop state while excluding exited zombies", () => {
    const parsed = parseProcessList([
      " 10 5 Thu Oct  1 23:00:00 2026 S /synthetic/runtime",
      " 11 10 Thu Oct  1 23:00:01 2026 T /synthetic/child with spaces",
      " 12 10 Thu Oct  1 23:00:02 2026 Z /synthetic/zombie",
      "",
    ].join("\n"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(root);
    expect(parsed[1]?.state).toBe("T");
    expect(parsed[1]?.command).toBe("/synthetic/child with spaces");
    expect(() => parseProcessList("unrecognized process output")).toThrow("PROCESS_LIST_PARSE_FAILED");
  });

  it("rejects reused PIDs or changed executable identity", () => {
    expect(sameProcess(root, { ...root, started: "different" })).toBe(false);
    expect(sameProcess(root, { ...root, command: "/unrelated/runtime" })).toBe(false);
    expect(sameProcess(root, { ...root, pid: 11 })).toBe(false);
    expect(sameProcess(root, { ...root, parent: 1, state: "T" })).toBe(true);
  });

  it("discovers only descendants, even with an unordered snapshot", () => {
    const child = { ...root, pid: 11, parent: 10 };
    const grandchild = { ...root, pid: 12, parent: 11 };
    const neighbor = { ...root, pid: 20 };
    const snapshot = [grandchild, neighbor, child, root];
    expect(descendants(root, snapshot).map((p) => p.pid)).toEqual([11, 12]);
    expect(descendants(root, [{ ...root, started: "reused" }, child])).toEqual([]);
    expect(descendants(root, [child])).toEqual([]);
  });
});

describe("local subprocess cleanup (real OS, no SDK/model calls)", () => {
  it("kills only the explicitly owned frozen child and leaves a neighbor alive", async () => {
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const neighbor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const victimClosed = once(victim, "close");
    const neighborClosed = once(neighbor, "close");
    try {
      await bounded(Promise.all([once(victim, "spawn"), once(neighbor, "spawn")]), 2_000, "SPAWN_TIMEOUT");
      const identity = processes().find((p) => p.pid === victim.pid);
      expect(identity?.parent).toBe(process.pid);
      if (!identity) throw new Error("synthetic child identity unavailable");
      signalOwned({ ...identity, started: "stale identity" }, "SIGKILL");
      expect(processes().some((p) => sameProcess(identity, p))).toBe(true);
      signalOwned(identity, "SIGSTOP");
      await delay(50);
      expect(processes().find((p) => p.pid === identity.pid)?.state).toContain("T");
      signalOwned(identity, "SIGKILL");
      await bounded(victimClosed, 2_000, "VICTIM_EXIT_TIMEOUT");
      expect(processes().some((p) => sameProcess(identity, p))).toBe(false);
      expect(neighbor.exitCode).toBeNull();
      expect(neighbor.signalCode).toBeNull();
      expect(processes().some((p) => p.pid === neighbor.pid && p.parent === process.pid)).toBe(true);
    } finally {
      for (const child of [victim, neighbor]) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await bounded(Promise.all([victimClosed, neighborClosed]), 2_000, "TEST_CLEANUP_TIMEOUT");
    }
  });
});
