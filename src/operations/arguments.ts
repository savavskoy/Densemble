export type CommandName = "start" | "doctor" | "backup" | "restore" | "launchd" | "recordings-status" | "modules-status";
export interface CommandLine {
  command: CommandName;
  config: string;
  target?: string;
  json?: boolean;
}

export function parseArguments(args: string[]): CommandLine {
  const explicit = args[0] !== undefined && !args[0].startsWith("--");
  const command = explicit ? args[0]! : "start";
  if (!["start", "doctor", "backup", "restore", "launchd", "recordings-status", "modules-status"].includes(command)) {
    throw new Error("UNKNOWN_COMMAND");
  }
  const options = new Map<string, string>();
  let json = false;
  for (let index = explicit ? 1 : 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (flag === "--json" && (command === "recordings-status" || command === "modules-status") && !json) {
      json = true;
      index--;
      continue;
    }
    const value = args[index + 1];
    if (!["--config", "--target"].includes(flag) || !value || value.startsWith("--") || options.has(flag)) {
      throw new Error("INVALID_COMMAND_ARGUMENTS");
    }
    options.set(flag, value);
  }
  const target = options.get("--target");
  if ((command === "backup" || command === "restore") !== Boolean(target)) throw new Error("COMMAND_TARGET_REQUIRED_OR_UNEXPECTED");
  return { command: command as CommandName, config: options.get("--config") ?? "config.local.json",
    ...(target ? { target } : {}), ...(json ? { json } : {}) };
}
