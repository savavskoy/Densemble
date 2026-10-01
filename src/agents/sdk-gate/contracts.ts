export const SDK_VERSION = "1.0.16";
export const CLI_VERSION = "1.0.91";

export const REQUIRED_CONTRACTS = [
  "runtime-version",
  "authentication",
  "model-discovery",
  "persona-discovery",
  "streaming",
  "user-question",
  "native-permission",
  "skill",
  "mcp-permission",
  "native-subagent",
  "delegated-permission",
  "model-switch",
  "immediate-steering",
  "abort-streaming",
  "abort-question",
  "resume-handlers",
  "resume-no-replay",
  "image",
  "process-isolation",
  "owned-tool-cancellation",
  "cleanup",
] as const;

export type Contract = (typeof REQUIRED_CONTRACTS)[number];
export type Status = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";
export type Check = { contract: Contract; status: Status; evidence: string };
export type Observation = { name: string; status: Status; evidence: string };

export class GateError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GateError";
    this.code = code;
  }
}

// Never emit upstream errors: they can contain credentials, prompts, or file paths.
export function safeError(error: unknown): string {
  return error instanceof GateError ? error.code : "UPSTREAM_ERROR_REDACTED";
}

export async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GateError(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function summarize(checks: Check[]): Status {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  return REQUIRED_CONTRACTS.every(
    (contract) => {
      const matches = checks.filter((check) => check.contract === contract);
      return matches.length === 1 && matches[0]?.status === "PASS";
    },
  ) ? "PASS" : "BLOCKED";
}

export function completeChecks(checks: Check[], missingStatus: "BLOCKED" | "SKIPPED", reason: string): Check[] {
  return REQUIRED_CONTRACTS.flatMap((contract) => {
    const matches = checks.filter((check) => check.contract === contract);
    return matches.length ? matches : [{ contract, status: missingStatus, evidence: reason }];
  });
}

export type AuthMode = "token" | "logged-in" | "cli-login";
export type GateOptions = { real: boolean; readinessOnly: boolean; authMode: AuthMode };

export function parseGateArgs(args: string[]): GateOptions {
  let authMode: AuthMode = "token";
  let authSelected = false;
  for (const arg of args) {
    if (arg === "--real" || arg === "--readiness") continue;
    if (!arg.startsWith("--auth=")) throw new GateError("UNKNOWN_GATE_ARGUMENT");
    if (authSelected) throw new GateError("DUPLICATE_AUTH_MODE");
    const value = arg.slice("--auth=".length);
    if (value !== "token" && value !== "logged-in" && value !== "cli-login") {
      throw new GateError("INVALID_AUTH_MODE");
    }
    authMode = value;
    authSelected = true;
  }
  return { real: args.includes("--real"), readinessOnly: args.includes("--readiness"), authMode };
}
