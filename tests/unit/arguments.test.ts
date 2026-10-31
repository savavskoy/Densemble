import { describe, expect, it } from "vitest";
import { parseArguments } from "../../src/operations/arguments.js";

describe("explicit service CLI operations", () => {
  it("defaults to foreground start and accepts only explicit config/target paths", () => {
    expect(parseArguments([])).toEqual({ command: "start", config: "config.local.json" });
    expect(parseArguments(["doctor", "--config", "custom.local.json"])).toEqual({
      command: "doctor", config: "custom.local.json",
    });
    expect(parseArguments(["backup", "--target", "/private/backup"])).toEqual({
      command: "backup", config: "config.local.json", target: "/private/backup",
    });
    expect(parseArguments(["recordings-status", "--json", "--config", "c.json"])).toEqual({
      command: "recordings-status", config: "c.json", json: true,
    });
    expect(parseArguments(["recordings-status"])).toEqual({ command: "recordings-status", config: "config.local.json" });
    expect(parseArguments(["modules-status", "--json"])).toEqual({ command: "modules-status", config: "config.local.json", json: true });
    expect(parseArguments(["modules-status"])).toEqual({ command: "modules-status", config: "config.local.json" });
  });
  it.each([
    ["unknown"], ["start", "--config"], ["start", "--config", "--target"],
    ["backup"], ["start", "--target", "/private/backup"], ["doctor", "--verbose"],
    ["doctor", "--config", "a", "--config", "b"], ["doctor", "--json"], ["recordings-status", "--json", "--json"],
    ["recordings-status", "--target", "/x"], ["modules-status", "--json", "--json"], ["modules-status", "--target", "/x"],
  ])("rejects unsupported or incomplete arguments %j", (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });
});
