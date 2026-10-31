import { z } from "zod";
import type { ModuleDefinition } from "../../../../src/modules/core-api.js";

/**
 * A trivial module that lives only in tests (US8, SC-003): one folder, one `module` export, no core file
 * mentions it. Enabling it takes a `modules.greeter` config entry and nothing else.
 */
const settings = z.object({ greeting: z.string().min(1).max(40).default("Hello") }).strict();

export const module: ModuleDefinition<z.infer<typeof settings>> = {
  id: "greeter",
  version: "0.1.0",
  settings,
  abilities: [{
    name: "greeter_greet",
    description: "Greets someone by name.",
    input: z.object({ name: z.string().min(1).max(40) }).strict(),
    readOnly: true,
  }],
  reasons: {},
  start: async (ctx) => ({
    status: () => `greeting: ${ctx.settings.greeting}`,
    invoke: async (_name, args) => ({ ok: true, message: `${ctx.settings.greeting}, ${(args as { name: string }).name}!` }),
    stop: async () => undefined,
  }),
};
