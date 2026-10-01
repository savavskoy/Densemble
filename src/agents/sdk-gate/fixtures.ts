import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function fixtures(workspace: string) {
  const nonce = randomUUID();
  const script = join(workspace, "action.mjs");
  const mcp = join(workspace, "mcp.mjs");
  const skills = join(workspace, "skills");
  const skillFile = join(skills, "gate-synthetic", "SKILL.md");
  const skillToken = `SKILL_${nonce}`;
  mkdirSync(join(skills, "gate-synthetic"), { recursive: true, mode: 0o700 });
  writeFileSync(skillFile, `---
name: gate-synthetic
description: Synthetic SDK gate skill. Invoke only when the user requests gate-synthetic.
---
Reply with exactly ${skillToken}. Do not run tools or read other files.
`, { mode: 0o600 });
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
if (!["native", "delegated", "hold"].includes(mode)) process.exit(2);
if (mode === "hold") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(join(root, "hold.json"), JSON.stringify({ pid: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
} else {
  writeFileSync(join(root, mode + ".marker"), ${JSON.stringify(nonce)}, { flag: "wx", mode: 0o600 });
  console.log("SYNTHETIC_ACTION_COMPLETE");
}
`, { mode: 0o600 });
  writeFileSync(mcp, `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const nonce = ${JSON.stringify(nonce)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result = {};
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gate", version: "1" } };
      break;
    case "tools/list":
      result = { tools: [{ name: "gate_mark", description: "Write one synthetic marker in the owned SDK fixture.", inputSchema: { type: "object", properties: { nonce: { type: "string", enum: [nonce] } }, required: ["nonce"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }] };
      break;
    case "tools/call":
      if (request.params.name !== "gate_mark" || JSON.stringify(request.params.arguments) !== JSON.stringify({ nonce })) {
        result = { isError: true, content: [{ type: "text", text: "DENIED" }] };
      } else {
        appendFileSync(join(root, "mcp.marker"), nonce + "\\n", { mode: 0o600 });
        result = { content: [{ type: "text", text: "GATE_MCP_COMPLETE" }] };
      }
      break;
    case "resources/list": result = { resources: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
  }
  send({ jsonrpc: "2.0", id: request.id, result });
});
`, { mode: 0o600 });
  return {
    nonce, skills, skillFile, skillToken, mcp,
    nativeMarker: join(workspace, "native.marker"),
    delegatedMarker: join(workspace, "delegated.marker"),
    holdMarker: join(workspace, "hold.json"),
    mcpMarker: join(workspace, "mcp.marker"),
    command: (mode: "native" | "delegated" | "hold") => `${quote(process.execPath)} ${quote(script)} ${mode}`,
    commands: (mode: "native" | "delegated" | "hold") => {
      const executables = [quote(process.execPath), `"${process.execPath}"`, process.execPath, "node"];
      const scripts = [quote(script), `"${script}"`, script];
      return executables.flatMap((exe) => scripts.map((path) => `${exe} ${path} ${mode}`));
    },
  };
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A 64x64 opaque green PNG, generated locally without an image service.
export function greenPng(): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + 1] = 255;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
