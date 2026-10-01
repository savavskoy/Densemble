import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApplication } from "../../src/application/index.js";
import { createMediaPipeline } from "../../src/media/index.js";
import { fixture, scope } from "./session-runtime-fixtures.js";

it("joins real SQLite/media admission to initial and queued steering without dropping run ownership", async () => {
  const f = fixture();
  const data = join(f.root, "media-data");
  await mkdir(data);
  f.config.config.runtimeDataPath = data;
  const download = vi.fn(async () => { throw new Error("NO_DOWNLOAD_EXPECTED"); });
  const media = createMediaPipeline({ config: f.config, store: f.store, diagnostics: f.diagnostics, download });
  const release = vi.spyOn(media, "releaseRun");
  const app = createApplication({ config: f.config, store: f.store, runtime: f.runtime, media,
    delivery: f.delivery, diagnostics: f.diagnostics, refreshAgents: false });
  try {
    await app.handle(f.message("Перший запит")); await app.drain();
    const run = f.store.runs.active(scope)!;
    await app.handle(f.message("Уточнення")); await app.drain();
    expect(f.commands.map((entry) => entry.kind)).toEqual(["send", "steer"]);
    expect(f.commands.at(-1)).toMatchObject({ identity: { runId: run.runId }, input: { text: "Уточнення" } });
    f.emit({ ...run, kind: "completed", text: "Готово" }); await app.drain();
    expect(f.store.runs.get(scope, run.runId)?.status).toBe("succeeded");
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
    expect(download).not.toHaveBeenCalled();
  } finally {
    await app.shutdown();
    await f.close();
  }
});

it("exports an authorized workspace artifact through real media and releases processing pins after atomic completion", async () => {
  const f = fixture();
  const data = join(f.root, "media-data");
  await mkdir(data);
  f.config.config.runtimeDataPath = data;
  await writeFile(join(f.config.config.workspacePath, "synthetic.txt"), "Synthetic generated result");
  await writeFile(join(f.root, "outside.txt"), "Outside the configured workspace");
  const media = createMediaPipeline({ config: f.config, store: f.store, diagnostics: f.diagnostics,
    download: async () => { throw new Error("NO_DOWNLOAD_EXPECTED"); } });
  const app = createApplication({ config: f.config, store: f.store, runtime: f.runtime, media,
    delivery: f.delivery, diagnostics: f.diagnostics, refreshAgents: false });
  try {
    await app.handle(f.message()); await app.drain();
    const run = f.store.runs.active(scope)!;
    const bridge = f.hooks.get(run.sessionId)!.exportFile!;
    await expect(bridge(run, join(f.root, "outside.txt"), new AbortController().signal)).rejects.toThrow("MEDIA_PATH_UNSAFE");
    const artifact = await bridge(run, "synthetic.txt", new AbortController().signal);
    expect(f.store.outbox.list(scope).some((item) => item.payload.kind === "file")).toBe(false);
    f.emit({ ...run, kind: "completed", text: "Файл готовий" }); await app.drain(); await f.flushDeliveries();
    expect(f.store.outbox.list(scope).find((item) => item.payload.kind === "file")?.payload)
      .toEqual({ kind: "file", attachmentId: artifact.id });
    expect((await media.resolveAttachment(scope, artifact.id)).sizeBytes).toBe(26);
    // The state deletion guard would reject any leaked media processing pin.
    expect(f.store.sessions.delete(scope, run.sessionId)?.sessionId).toBe(run.sessionId);
    await media.removeArtifacts([artifact]);
  } finally {
    await app.shutdown();
    await f.close();
  }
});
