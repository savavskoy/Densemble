import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CopilotClient } from "@github/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bounded, CLI_VERSION, completeChecks, GateError, parseGateArgs,
  REQUIRED_CONTRACTS, safeError, SDK_VERSION, summarize,
} from "../../src/agents/sdk-gate/contracts.js";
import type { Check } from "../../src/agents/sdk-gate/contracts.js";
import {
  descendants, IsolatedRuntime, parseProcessList, pinnedCli, processes, runtimeOptions, sameProcess, signalOwned,
} from "../../src/agents/sdk-gate/runtime.js";
import type { ProcessIdentity } from "../../src/agents/sdk-gate/runtime.js";

const root: ProcessIdentity = {
  pid: 10, parent: 5, started: "Thu Oct  1 23:00:00 2026",
  command: "/synthetic/runtime", state: "S",
};

describe("SDK gate bookkeeping (offline, not runtime contract evidence)", () => {
  it("requires explicit real opt-in", () => {
    expect(parseGateArgs([])).toEqual({ real: false, readinessOnly: false, authMode: "token" });
    expect(parseGateArgs(["--readiness"])).toEqual({ real: false, readinessOnly: true, authMode: "token" });
    expect(parseGateArgs(["--real", "--readiness"])).toEqual({ real: true, readinessOnly: true, authMode: "token" });
    expect(() => parseGateArgs(["--approve-all"])).toThrow("UNKNOWN_GATE_ARGUMENT");
  });

  it("selects an auth source explicitly without implying real opt-in", () => {
    expect(parseGateArgs(["--auth=logged-in"])).toEqual({
      real: false, readinessOnly: false, authMode: "logged-in",
    });
    for (const authMode of ["token", "logged-in", "cli-login", "service-login"] as const) {
      expect(parseGateArgs([`--auth=${authMode}`])).toEqual({
        real: false, readinessOnly: false, authMode,
      });
      expect(parseGateArgs(["--real", `--auth=${authMode}`, "--readiness"])).toEqual({
        real: true, readinessOnly: true, authMode,
      });
    }
  });

  it.each(["--auth=", "--auth=auto", "--auth=TOKEN", "--auth=synthetic-sensitive-value"])(
    "rejects invalid auth mode without echoing its contents: %s", (arg) => {
      expect(() => parseGateArgs([arg])).toThrow("INVALID_AUTH_MODE");
    },
  );

  it("rejects conflicting or repeated auth selection rather than using last-wins", () => {
    expect(() => parseGateArgs(["--auth=token", "--auth=logged-in"])).toThrow("DUPLICATE_AUTH_MODE");
    expect(() => parseGateArgs(["--auth=token", "--auth=token"])).toThrow("DUPLICATE_AUTH_MODE");
    expect(() => parseGateArgs(["--auth=service-login", "--auth=cli-login"])).toThrow("DUPLICATE_AUTH_MODE");
    expect(() => parseGateArgs(["--auth=service-login", "--auth=service-login"])).toThrow("DUPLICATE_AUTH_MODE");
    expect(() => parseGateArgs(["--auth", "logged-in"])).toThrow("UNKNOWN_GATE_ARGUMENT");
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

  it("keeps the full gate blocked even if every readiness RPC and cleanup passes", () => {
    const readiness: Check[] = (["runtime-version", "authentication", "model-discovery", "cleanup"] as const).map(
      (contract) => ({ contract, status: "PASS", evidence: "synthetic-test-only" }),
    );
    expect(summarize(completeChecks(readiness, "SKIPPED", "AUTHENTICATED_BEHAVIOR_PROBES_NOT_IMPLEMENTED")))
      .toBe("BLOCKED");
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

describe("SDK auth option isolation (offline, not authentication evidence)", () => {
  const runRoot = "/synthetic/sdk-run";
  const cli = "/synthetic/pinned-cli";
  const source = Object.freeze({
    HOME: "/synthetic/actual-home",
    XDG_CONFIG_HOME: "/synthetic/actual-config",
    XDG_CACHE_HOME: "/synthetic/actual-cache",
    PATH: "/synthetic/untrusted-bin",
    TMPDIR: "/synthetic/ambient-scratch",
    COPILOT_GITHUB_TOKEN: "synthetic-explicit-token",
    COPILOT_SDK_AUTH_TOKEN: "synthetic-other-sdk-token",
    GH_TOKEN: "synthetic-other-gh-token",
    GITHUB_TOKEN: "synthetic-other-github-token",
    COPILOT_HOME: "/synthetic/private-copilot",
    COPILOT_CLI_PATH: "/synthetic/untrusted-cli",
    COPILOT_DISABLE_KEYTAR: "0",
    COPILOT_PROVIDER_API_KEY: "synthetic-provider-key",
    COPILOT_PROVIDER_BASE_URL: "https://example.invalid",
    COPILOT_OFFLINE: "true",
    COPILOT_RUNTIME_PROCESS_FILE_LOGGING: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.invalid",
    NODE_OPTIONS: "--require=/synthetic/untrusted.js",
    NODE_DEBUG: "*",
    BASH_ENV: "/synthetic/untrusted.sh",
    SECRET_UNRELATED: "synthetic-secret",
  });

  it.each(["token", "logged-in", "cli-login"] as const)("preserves safe runtime boundaries in %s mode", (mode) => {
    const options = runtimeOptions(runRoot, cli, mode, source);
    expect(options.mode).toBe(mode === "cli-login" ? "copilot-cli" : "empty");
    expect(options.baseDirectory).toBe(join(runRoot, "copilot"));
    expect(options.workingDirectory).toBe(join(runRoot, "workspace"));
    expect(options.logLevel).toBe("none");
    expect(options.enableRemoteSessions).toBe(false);
    expect(options.connection).toMatchObject({
      kind: "stdio", path: cli,
      args: ["--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--no-remote-export", "--no-bash-env"],
    });
    expect(options.env?.XDG_CONFIG_HOME).toBe(join(runRoot, "home", ".config"));
    expect(options.env?.XDG_CACHE_HOME).toBe(join(runRoot, "home", ".cache"));
    expect(options.env?.TMPDIR).toBe(join(runRoot, "scratch"));
  });

  it("passes only the explicitly selected token and never opts into account fallback", () => {
    const options = runtimeOptions(runRoot, cli, "token", source);
    expect(options.gitHubToken).toBe("synthetic-explicit-token");
    expect(options.useLoggedInUser).toBe(false);
    expect(options.env).toEqual({
      HOME: join(runRoot, "home"),
      XDG_CONFIG_HOME: join(runRoot, "home", ".config"),
      XDG_CACHE_HOME: join(runRoot, "home", ".cache"),
      TMPDIR: join(runRoot, "scratch"),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
    });
  });

  it.each([undefined, ""])("does not fall back when the selected token is absent or empty", (token) => {
    const options = runtimeOptions(runRoot, cli, "token", { ...source, COPILOT_GITHUB_TOKEN: token });
    expect(options.gitHubToken).toBeUndefined();
    expect(options.useLoggedInUser).toBe(false);
    expect(options.env?.GH_TOKEN).toBeUndefined();
    expect(options.env?.GITHUB_TOKEN).toBeUndefined();
  });

  it.each(["logged-in", "cli-login"] as const)("allows only HOME and gh discovery in %s, not ambient tokens/settings", (mode) => {
    const options = runtimeOptions(runRoot, cli, mode, source);
    expect(options.gitHubToken).toBeUndefined();
    expect(options.useLoggedInUser).toBe(true);
    expect(options.env).toEqual({
      HOME: source.HOME,
      GH_CONFIG_DIR: join(source.XDG_CONFIG_HOME, "gh"),
      GH_PROMPT_DISABLED: "1",
      XDG_CONFIG_HOME: join(runRoot, "home", ".config"),
      XDG_CACHE_HOME: join(runRoot, "home", ".cache"),
      TMPDIR: join(runRoot, "scratch"),
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
    });
  });

  it("supports the default or explicit gh auth directory without changing XDG discovery", () => {
    const defaults = runtimeOptions(runRoot, cli, "logged-in", { HOME: source.HOME });
    expect(defaults.env?.GH_CONFIG_DIR).toBe(join(source.HOME, ".config", "gh"));
    const explicit = runtimeOptions(runRoot, cli, "logged-in", {
      ...source, GH_CONFIG_DIR: "/synthetic/custom-gh",
    });
    expect(explicit.env?.GH_CONFIG_DIR).toBe("/synthetic/custom-gh");
    expect(explicit.env?.XDG_CONFIG_HOME).toBe(join(runRoot, "home", ".config"));
  });

  it.each([undefined, "", "relative-home"])("rejects missing/relative logged-in HOME", (HOME) => {
    expect(() => runtimeOptions(runRoot, cli, "logged-in", { HOME })).toThrow("AUTH_HOME_REQUIRED");
  });

  it.each([
    { GH_CONFIG_DIR: "" }, { GH_CONFIG_DIR: "relative-gh" }, { XDG_CONFIG_HOME: "relative-xdg" },
  ])("rejects ambiguous gh config paths", (overrides) => {
    expect(() => runtimeOptions(runRoot, cli, "logged-in", { HOME: source.HOME, ...overrides }))
      .toThrow("AUTH_GH_CONFIG_MUST_BE_ABSOLUTE");
  });

  it("leaves no newly owned run files when auth configuration fails before startup", () => {
    const parent = resolve(".cache", "sdk-contract");
    const before = existsSync(parent) ? readdirSync(parent).sort() : [];
    vi.stubEnv("HOME", "");
    try {
      expect(() => new IsolatedRuntime("logged-in")).toThrow("AUTH_HOME_REQUIRED");
      expect(existsSync(parent) ? readdirSync(parent).sort() : []).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("persistent service login (synthetic owned directories, never actual login state)", () => {
    let project: string;
    const state = "synthetic service state, not credentials or proof of authentication";

    beforeEach(() => {
      project = resolve(".cache", `sdk-service-login-test-${randomUUID()}`);
      mkdirSync(project, { recursive: true, mode: 0o700 });
      vi.spyOn(process, "cwd").mockReturnValue(project);
      vi.stubEnv("HOME", join(project, "auth-home"));
      vi.stubEnv("GH_CONFIG_DIR", join(project, "auth-home", ".config", "gh"));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(project, { recursive: true, force: true });
    });

    function provisionSyntheticHome(): { home: string; marker: string } {
      const home = join(project, "runtime", "copilot");
      const marker = join(home, "service-state", "marker");
      mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
      writeFileSync(marker, state, { mode: 0o600 });
      return { home, marker };
    }

    it("selects the fixed service baseDirectory while retaining per-run isolation and a token-free environment", () => {
      const { home } = provisionSyntheticHome();
      const options = runtimeOptions(runRoot, cli, "service-login", source);
      const transient = runtimeOptions(runRoot, cli, "cli-login", source);
      expect(options).toEqual({ ...transient, baseDirectory: home });
      expect(options.mode).toBe("copilot-cli");
      expect(options.useLoggedInUser).toBe(true);
      expect(options.gitHubToken).toBeUndefined();
      expect(options.workingDirectory).toBe(join(runRoot, "workspace"));
      expect(options.env?.TMPDIR).toBe(join(runRoot, "scratch"));
      expect(options.env?.COPILOT_HOME).toBeUndefined();
      expect(options.env?.COPILOT_DISABLE_KEYTAR).toBeUndefined();
      for (const name of ["COPILOT_GITHUB_TOKEN", "COPILOT_SDK_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
        expect(options.env?.[name]).toBeUndefined();
        expect(JSON.stringify(options)).not.toContain(source[name]);
      }
      expect(source.COPILOT_HOME).toBe("/synthetic/private-copilot");
    });

    it.each([
      ["missing-runtime", "SERVICE_LOGIN_HOME_MISSING"],
      ["missing-home", "SERVICE_LOGIN_HOME_MISSING"],
      ["home-file", "SERVICE_LOGIN_HOME_NOT_DIRECTORY"],
      ["ancestor-file", "SERVICE_LOGIN_HOME_NOT_DIRECTORY"],
      ["home-symlink", "SERVICE_LOGIN_HOME_SYMLINKED"],
      ["dangling-home-symlink", "SERVICE_LOGIN_HOME_SYMLINKED"],
      ["ancestor-symlink", "SERVICE_LOGIN_HOME_SYMLINKED"],
      ["project-symlink", "SERVICE_LOGIN_HOME_SYMLINKED"],
    ])("rejects %s before allocating run files or spawning, without fallback", async (kind, code) => {
      const home = join(project, "runtime", "copilot");
      const target = join(project, "synthetic-target");
      switch (kind) {
        case "missing-runtime":
          break;
        case "missing-home":
          mkdirSync(dirname(home));
          break;
        case "home-file":
          mkdirSync(dirname(home));
          writeFileSync(home, state);
          break;
        case "ancestor-file":
          writeFileSync(dirname(home), state);
          break;
        case "home-symlink":
        case "dangling-home-symlink":
          mkdirSync(dirname(home));
          if (kind === "home-symlink") mkdirSync(target);
          symlinkSync(target, home, "dir");
          break;
        case "ancestor-symlink":
          mkdirSync(join(target, "copilot"), { recursive: true });
          symlinkSync(target, dirname(home), "dir");
          break;
        case "project-symlink": {
          mkdirSync(join(target, "runtime", "copilot"), { recursive: true });
          const alias = join(project, "synthetic-alias");
          symlinkSync(target, alias, "dir");
          vi.mocked(process.cwd).mockReturnValue(alias);
          break;
        }
      }
      const start = vi.spyOn(CopilotClient.prototype, "start").mockRejectedValue(new GateError("UNEXPECTED_SDK_START"));
      let runtime: IsolatedRuntime | undefined;
      try {
        expect(() => runtimeOptions(runRoot, cli, "service-login", source)).toThrow(code);
        await expect(async () => {
          runtime = new IsolatedRuntime("service-login");
          await runtime.start();
        }).rejects.toThrow(code);
        expect(start).not.toHaveBeenCalled();
        expect(existsSync(resolve(".cache"))).toBe(false);
        if (kind.startsWith("missing")) expect(existsSync(home)).toBe(false);
      } finally {
        if (runtime) {
          await runtime.stop(true);
          runtime.removeOwnedFiles();
        }
      }
    });

    it("preserves provisioned state when logged-in environment validation fails", () => {
      const { home, marker } = provisionSyntheticHome();
      vi.stubEnv("HOME", "");
      expect(() => new IsolatedRuntime("service-login")).toThrow("AUTH_HOME_REQUIRED");
      expect(lstatSync(home).isDirectory()).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe(state);
      expect(existsSync(join(project, ".cache"))).toBe(false);
    });

    it.each(["normal", "startup-failure"] as const)("retains service state through %s cleanup", async (kind) => {
      const { home, marker } = provisionSyntheticHome();
      const runtime = new IsolatedRuntime("service-login");
      const start = vi.spyOn(runtime.client, "start").mockRejectedValue(new GateError("SYNTHETIC_START_FAILURE"));
      try {
        expect(runtime.root.startsWith(join(project, ".cache", "sdk-contract"))).toBe(true);
        expect(existsSync(runtime.workspace)).toBe(true);
        expect(existsSync(join(runtime.root, "scratch"))).toBe(true);
        expect(existsSync(join(runtime.root, "copilot"))).toBe(false);
        expect(() => runtime.removeOwnedFiles()).toThrow("REFUSING_CLEANUP_WITH_UNVERIFIED_RUNTIME");
        if (kind === "startup-failure") {
          await expect(runtime.start()).rejects.toThrow("SYNTHETIC_START_FAILURE");
        } else {
          expect(start).not.toHaveBeenCalled();
        }
      } finally {
        expect((await runtime.stop()).issues).toEqual([]);
        runtime.removeOwnedFiles();
      }
      expect(existsSync(runtime.root)).toBe(false);
      expect(lstatSync(home).isDirectory()).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe(state);
    });

    it("deletes only registered gate sessions and never the service home or unrelated history", async () => {
      const { home, marker } = provisionSyntheticHome();
      const runtime = new IsolatedRuntime("service-login");
      const id = `densemble-gate-${randomUUID()}`;
      const directory = join(home, "session-state", id);
      const unrelated = join(home, "session-state", `densemble-gate-${randomUUID()}`);
      mkdirSync(directory, { recursive: true });
      mkdirSync(unrelated, { recursive: true });
      writeFileSync(join(directory, "events.jsonl"), "synthetic");
      runtime.ownSession(id);
      expect(() => runtime.ownSession("../service-state")).toThrow("INVALID_OWNED_SESSION_ID");
      await expect(runtime.deleteOwnedSession("unregistered")).rejects.toThrow("REFUSING_UNOWNED_SESSION_DELETE");
      expect((await runtime.stop(true)).issues).toEqual([]);
      runtime.removeOwnedFiles();
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe(state);
    });

    it("transfers exact session cleanup ownership across a service-runtime restart", async () => {
      const { home, marker } = provisionSyntheticHome();
      const first = new IsolatedRuntime("service-login");
      const second = new IsolatedRuntime("service-login");
      const id = `densemble-gate-${randomUUID()}`;
      const directory = join(home, "session-state", id);
      mkdirSync(directory, { recursive: true });
      first.ownSession(id);
      expect(() => first.transferOwnedSession(id, first)).toThrow("REFUSING_SESSION_OWNERSHIP_TRANSFER");
      first.transferOwnedSession(id, second);
      expect((await first.stop(true)).issues).toEqual([]);
      first.removeOwnedFiles();
      expect(existsSync(directory)).toBe(true);
      expect((await second.stop(true)).issues).toEqual([]);
      second.removeOwnedFiles();
      expect(existsSync(directory)).toBe(false);
      expect(readFileSync(marker, "utf8")).toBe(state);
    });

    it.each(["missing", "symlink", "ancestor-symlink"] as const)("rechecks %s service home immediately before SDK startup", async (kind) => {
      const { home } = provisionSyntheticHome();
      const runtime = new IsolatedRuntime("service-login");
      const start = vi.spyOn(runtime.client, "start").mockRejectedValue(new GateError("UNEXPECTED_SDK_START"));
      const saved = join(project, "saved-service-state");
      let marker: string;
      if (kind === "ancestor-symlink") {
        renameSync(dirname(home), saved);
        symlinkSync(saved, dirname(home), "dir");
        marker = join(saved, "copilot", "service-state", "marker");
      } else {
        renameSync(home, saved);
        if (kind === "symlink") symlinkSync(saved, home, "dir");
        marker = join(saved, "service-state", "marker");
      }
      try {
        await expect(runtime.start()).rejects.toThrow(
          kind === "missing" ? "SERVICE_LOGIN_HOME_MISSING" : "SERVICE_LOGIN_HOME_SYMLINKED",
        );
        expect(start).not.toHaveBeenCalled();
      } finally {
        expect((await runtime.stop()).issues).toEqual([]);
        runtime.removeOwnedFiles();
      }
      expect(existsSync(runtime.root)).toBe(false);
      expect(readFileSync(marker, "utf8")).toBe(state);
      if (kind === "missing") expect(existsSync(home)).toBe(false);
      else expect(lstatSync(kind === "symlink" ? home : dirname(home)).isSymbolicLink()).toBe(true);
    });

    it.each(["normal", "stop-failure"] as const)("retains service state through emergency %s cleanup", async (kind) => {
      const { home, marker } = provisionSyntheticHome();
      // Emergency shutdown is terminal; keep its registry separate from other tests.
      vi.resetModules();
      const isolated = await import("../../src/agents/sdk-gate/runtime.js");
      const runtime = new isolated.IsolatedRuntime("service-login");
      if (kind === "stop-failure") {
        vi.spyOn(runtime.client, "forceStop").mockRejectedValue(new Error("synthetic cleanup failure"));
      }
      const errors = await isolated.emergencyCleanup();
      expect(errors).toEqual(kind === "normal" ? [] :
        ["UPSTREAM_ERROR_REDACTED", "REFUSING_CLEANUP_WITH_UNVERIFIED_RUNTIME"]);
      expect(existsSync(runtime.root)).toBe(kind === "stop-failure");
      expect(lstatSync(home).isDirectory()).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe(state);
    });
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
