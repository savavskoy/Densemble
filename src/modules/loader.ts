import { MODULE_ID, type ModuleDefinition } from "./contract.js";

/** Finds a module's definition by id; undefined means `MODULE_UNKNOWN`. Injectable for tests. */
export type ModuleLoader = (id: string) => Promise<ModuleDefinition | undefined>;

/** Same folder under vitest (`.ts`) and `dist/` (`.js`). */
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";

/** Imports `./<id>/index.(js|ts)` and accepts its `module` export only when `module.id` equals the folder. Never throws. */
export const loadModule: ModuleLoader = async (id) => {
  if (!MODULE_ID.test(id)) return undefined;
  try {
    const exported = await import(new URL(`./${id}/index.${extension}`, import.meta.url).href) as { module?: unknown };
    return isDefinition(exported.module) && exported.module.id === id ? exported.module : undefined;
  } catch { return undefined; }
};

function isDefinition(value: unknown): value is ModuleDefinition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof ModuleDefinition, unknown>>;
  return typeof candidate.id === "string" && typeof candidate.version === "string" &&
    typeof candidate.start === "function" && typeof candidate.settings === "object" && candidate.settings !== null;
}
