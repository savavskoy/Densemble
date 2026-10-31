import { readFile } from "node:fs/promises";
import { MODULE_ID, type ModuleDefinition } from "../../../src/modules/contract.js";
import type { ModuleLoader } from "../../../src/modules/loader.js";

/**
 * The production loader's folder convention (`./<id>/index.ts` exporting `module` whose id equals the folder),
 * rooted at this fixtures folder so test-only modules never live in `src/modules/`.
 */
export const fixtureFolderLoader: ModuleLoader = async (id) => {
  if (!MODULE_ID.test(id)) return undefined;
  try {
    const exported = await import(new URL(`./${id}/index.ts`, import.meta.url).href) as { module?: ModuleDefinition };
    return exported.module?.id === id ? exported.module : undefined;
  } catch { return undefined; }
};

/** `INSTRUCTIONS.md` of a fixture module folder, like `instructionsReader()` for `src/modules/<id>/`. */
export async function fixtureInstructions(id: string): Promise<string | undefined> {
  if (!MODULE_ID.test(id)) return undefined;
  try { return await readFile(new URL(`./${id}/INSTRUCTIONS.md`, import.meta.url), "utf8"); } catch { return undefined; }
}
