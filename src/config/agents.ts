import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ConfigError, sourcePath } from "./paths.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const metadataSchema = z.object({
  name: id,
  description: z.string().trim().min(1),
  model: z.string().trim().min(1),
  "user-invocable": z.boolean().optional(),
  infer: z.boolean().optional(),
  tools: z.array(z.string().min(1)).optional(),
}).strict();

export interface AgentDefinition {
  id: string;
  description: string;
  defaultModel: string;
  userInvocable: boolean;
  infer?: boolean;
  tools?: string[];
  launcherPath: string;
  canonicalPath: string;
}
export interface AgentSources {
  workspacePath: string;
  agentDefinitionsPath: string;
  agentLaunchersPath: string;
}

function frontmatter(text: string): { metadata: z.infer<typeof metadataSchema>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") throw new ConfigError("LAUNCHER_FRONTMATTER_MISSING");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new ConfigError("LAUNCHER_FRONTMATTER_INVALID");
  try {
    const document = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true, strict: true });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new ConfigError("LAUNCHER_YAML_INVALID");
    const result = metadataSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!result.success) throw new ConfigError("LAUNCHER_METADATA_INVALID");
    return { metadata: result.data, body: lines.slice(end + 1).join("\n") };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("LAUNCHER_YAML_INVALID");
  }
}

function validateLinks(workspace: string, file: string, text: string): void {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]!;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split("#")[0]!;
    if (!path) continue;
    if (/^[a-z]+:/i.test(path)) throw new ConfigError("SOURCE_LINK_INVALID");
    try {
      sourcePath(workspace, resolve(dirname(file), decodeURIComponent(path)), "any");
    } catch {
      throw new ConfigError("SOURCE_LINK_INVALID");
    }
  }
}

export function discoverAgents(sources: AgentSources): AgentDefinition[] {
  const workspace = sources.workspacePath;
  const launchers = sourcePath(workspace, sources.agentLaunchersPath, "directory");
  const definitions = sourcePath(workspace, sources.agentDefinitionsPath, "directory");
  const result: AgentDefinition[] = [];
  for (const entry of readdirSync(launchers).filter((name) => name.endsWith(".agent.md")).sort()) {
    const launcherPath = sourcePath(workspace, resolve(launchers, entry), "file");
    const text = readFileSync(launcherPath, "utf8");
    const { metadata, body } = frontmatter(text);
    if (entry !== `${metadata.name}.agent.md`) throw new ConfigError("LAUNCHER_ID_MISMATCH");
    validateLinks(workspace, launcherPath, body);
    const references = [...body.matchAll(/`([^`\r\n]+\.md)`/g)].map((match) => match[1]!);
    const canonicalReferences = references.filter((reference) =>
      basename(reference) === "AGENT.md" || reference.startsWith("agent/subagents/"));
    if (canonicalReferences.length !== 1) throw new ConfigError("CANONICAL_REFERENCE_REQUIRED");
    const canonicalPath = sourcePath(workspace, resolve(workspace, canonicalReferences[0]!), "file");
    const userInvocable = metadata["user-invocable"] ?? true;
    if (userInvocable && canonicalPath !== resolve(definitions, metadata.name, "AGENT.md")) {
      throw new ConfigError("CANONICAL_REFERENCE_MISMATCH");
    }
    for (const reference of references) sourcePath(workspace, resolve(workspace, reference), "file");
    const canonical = readFileSync(canonicalPath, "utf8");
    if (!canonical.trim()) throw new ConfigError("CANONICAL_EMPTY");
    validateLinks(workspace, canonicalPath, canonical);
    result.push({
      id: metadata.name, description: metadata.description, defaultModel: metadata.model,
      userInvocable, launcherPath, canonicalPath,
      ...(metadata.infer === undefined ? {} : { infer: metadata.infer }),
      ...(metadata.tools === undefined ? {} : { tools: metadata.tools }),
    });
  }
  if (result.length === 0) throw new ConfigError("NO_AGENTS");
  for (const entry of readdirSync(definitions, { withFileTypes: true })) {
    if (entry.isDirectory() && !result.some((agent) => agent.canonicalPath === resolve(definitions, entry.name, "AGENT.md"))) {
      throw new ConfigError("CANONICAL_WITHOUT_LAUNCHER");
    }
  }
  return result;
}
