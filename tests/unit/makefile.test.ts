import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
let home: string;
let bin: string;
let log: string;
let plist: string;
const makefile = resolve("Makefile");

beforeEach(() => {
  root = resolve(".cache", `make-unit-${randomUUID()}`);
  home = join(root, "home with spaces");
  bin = join(root, "bin");
  log = join(root, "commands.log");
  plist = join(home, "Library/LaunchAgents/dev.densemble.agent.plist");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, "Makefile"), readFileSync(makefile));
  for (const name of ["npm", "node", "plutil", "launchctl"]) {
    writeFileSync(join(bin, name), `#!/bin/sh
printf '%s %s\\n' '${name}' "$*" >> "$COMMAND_LOG"
if [ "\${FAIL_COMMAND:-}" = '${name}' ]; then exit 23; fi
${name === "node" ? "printf '%s\\n' '<plist version=\"1.0\"><dict/></plist>'" : ""}
`, { mode: 0o700 });
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function make(target: string, failure = "") {
  return spawnSync("make", [target, "CONFIG=synthetic config.json"], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      COMMAND_LOG: log, FAIL_COMMAND: failure, MAKEFLAGS: "" },
  });
}
function commands(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

it("shows help without building, installing or starting a service", () => {
  const result = make("help");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("make restart");
  expect(commands()).toEqual([]);
  expect(existsSync(plist)).toBe(false);
});

it("installs atomically with spaced paths without starting launchd", () => {
  expect(make("install").status).toBe(0);
  expect(readFileSync(plist, "utf8")).toContain("<plist");
  expect(commands().map((line) => line.split(" ")[0])).toEqual(["npm", "node", "plutil"]);
  expect(commands()[1]).toBe("node dist/main.js launchd --config synthetic config.json");
  expect(readdirSync(join(home, "Library/LaunchAgents"))).toEqual(["dev.densemble.agent.plist"]);
});

it("retains an existing plist and removes the temporary file if generation fails", () => {
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(plist, "existing");
  expect(make("install", "node").status).not.toBe(0);
  expect(readFileSync(plist, "utf8")).toBe("existing");
  expect(readdirSync(join(home, "Library/LaunchAgents"))).toEqual(["dev.densemble.agent.plist"]);
  expect(commands().some((line) => line.startsWith("launchctl"))).toBe(false);
});

it("requires installation before starting and bootstraps only the installed plist", () => {
  expect(make("start").status).not.toBe(0);
  expect(commands()).toEqual([]);
  expect(make("install").status).toBe(0);
  expect(make("start").status).toBe(0);
  expect(commands().at(-1)).toBe(`launchctl bootstrap gui/${process.getuid!()} ${plist}`);
});

it("stops before rebuilding and restarting, and never proceeds after a stop failure", () => {
  expect(make("restart", "launchctl").status).not.toBe(0);
  expect(commands()).toEqual([`launchctl bootout gui/${process.getuid!()}/dev.densemble.agent`]);
  writeFileSync(log, "");
  expect(make("restart").status).toBe(0);
  expect(commands().map((line) => line.split(" ")[0])).toEqual(["launchctl", "npm", "node", "plutil", "launchctl"]);
  expect(commands()[1]).toBe("npm run build");
  expect(commands().at(-1)).toContain("launchctl bootstrap");
});
