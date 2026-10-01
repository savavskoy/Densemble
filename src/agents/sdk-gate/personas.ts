import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { GateError } from "./contracts.js";

export type PersonaMetadata = { id: string; model: string; invocable: boolean; skillCount: number };

function scalar(frontmatter: string, key: string): string | undefined {
  const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim();
  return value?.replace(/^["']|["']$/g, "");
}

function inside(root: string, path: string): string {
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (rel.startsWith("..") || isAbsolute(rel) || !statSync(actual).isFile()) {
    throw new GateError("PERSONA_REFERENCE_OUTSIDE_WORKSPACE");
  }
  return actual;
}

// Metadata-only local inspection. Neither authored text nor source paths leave this
// function; only a separate, completely synthetic persona is sent to inference.
export function discoverPersonaMetadata(workspace: string): PersonaMetadata[] {
  const root = realpathSync(workspace);
  const launchers = resolve(root, ".github", "agents");
  const entries = readdirSync(launchers).filter((name) => name.endsWith(".agent.md"));
  return entries.map((name) => {
    const text = readFileSync(inside(root, resolve(launchers, name)), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!frontmatter) throw new GateError("LAUNCHER_FRONTMATTER_MISSING");
    const id = scalar(frontmatter, "name");
    const model = scalar(frontmatter, "model");
    if (!id || !/^[a-z0-9-]+$/.test(id) || !model || !/^[a-z0-9.-]+$/.test(model)) {
      throw new GateError("LAUNCHER_MODEL_OR_ID_INVALID");
    }
    if (name !== `${id}.agent.md`) throw new GateError("LAUNCHER_ID_MISMATCH");
    const invocable = scalar(frontmatter, "user-invocable") !== "false";
    if (!invocable) return { id, model, invocable, skillCount: 0 };
    const reference = `agent/agents/${id}/AGENT.md`;
    if (!text.includes(reference)) throw new GateError("CANONICAL_PERSONA_REFERENCE_MISSING");
    const canonical = inside(root, resolve(root, reference));
    const persona = readFileSync(canonical, "utf8");
    const skills = [...persona.matchAll(/\]\(([^)]+SKILL\.md)\)/g)];
    for (const match of skills) inside(root, resolve(dirname(canonical), match[1]!));
    return { id, model, invocable, skillCount: skills.length };
  });
}
