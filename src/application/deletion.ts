import { mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Attachment, Scope } from "../domain.js";
import { assertScope } from "../domain.js";
import { RuntimeError } from "../agents/contracts.js";

const uuid = z.string().uuid();
const scopeSchema = z.object({
  ownerId: z.number().int().positive(), botId: z.string(), chatId: z.number().int(), topicId: z.number().int().positive().nullable(),
}).strict();
const artifactSchema = z.object({
  id: z.string(), scope: scopeSchema, sessionId: uuid, runId: z.string().nullable(),
  kind: z.enum(["input", "output", "audio"]), relativePath: z.string().refine((path) =>
    !path.startsWith("/") && !path.split(/[\\/]/).some((part) => part === ".." || part === ".")),
  fileName: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative(), createdAt: z.number(),
  expiresAt: z.number().nullable(),
}).strict();
const schema = z.object({
  sessionId: uuid, scope: scopeSchema, providerSessionId: z.string().nullable(), artifacts: z.array(artifactSchema),
}).strict();
export interface DeletionIntent {
  scope: Scope;
  sessionId: string;
  providerSessionId: string | null;
  artifacts: Attachment[];
}
export class DeletionJournal {
  private readonly directory: string;
  constructor(dataPath: string) { this.directory = join(dataPath, "session-deletions"); }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== resolve(this.directory)) throw new RuntimeError("DELETION_JOURNAL_UNSAFE");
  }
  private validate(value: unknown): DeletionIntent {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RuntimeError("DELETION_JOURNAL_INVALID");
    const intent = parsed.data;
    assertScope(intent.scope);
    if (intent.providerSessionId && intent.providerSessionId !== `densemble-${intent.sessionId}`) {
      throw new RuntimeError("DELETION_JOURNAL_INVALID");
    }
    for (const artifact of intent.artifacts) {
      if (artifact.sessionId !== intent.sessionId || JSON.stringify(artifact.scope) !== JSON.stringify(intent.scope)) {
        throw new RuntimeError("DELETION_JOURNAL_INVALID");
      }
    }
    return intent;
  }
  async save(intent: DeletionIntent): Promise<void> {
    this.validate(intent);
    await this.prepare();
    const path = join(this.directory, `${intent.sessionId}.json`);
    const staging = `${path}.next`;
    await writeFile(staging, JSON.stringify(intent), { mode: 0o600, flag: "wx", flush: true });
    await rename(staging, path);
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async pending(): Promise<DeletionIntent[]> {
    await this.prepare();
    const intents: DeletionIntent[] = [];
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9-]{36}\.json\.next$/.test(name)) {
        const path = join(this.directory, name);
        if (await realpath(path) !== path) throw new RuntimeError("DELETION_JOURNAL_UNSAFE");
        await unlink(path);
        continue;
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(this.directory, name);
      if (await realpath(path) !== path) throw new RuntimeError("DELETION_JOURNAL_UNSAFE");
      const intent = this.validate(JSON.parse(await readFile(path, "utf8")));
      if (name !== `${intent.sessionId}.json`) throw new RuntimeError("DELETION_JOURNAL_INVALID");
      intents.push(intent);
    }
    return intents;
  }
  async remove(intent: DeletionIntent): Promise<void> {
    this.validate(intent);
    await unlink(join(this.directory, `${intent.sessionId}.json`));
  }
}
