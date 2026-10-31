import { lstat, mkdir, rmdir, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The standalone launchd transcriber that Densemble replaces (research R13). */
export const LEGACY_PLIST = join(homedir(), "Library/LaunchAgents/com.openclaw-jazz.transcribe-recordings.plist");
/** The old script's own lock; holding it makes the old script exit without work. */
export const LEGACY_LOCK = "/tmp/transcribe-new-recordings.lock";

export async function legacyJobInstalled(plist = LEGACY_PLIST): Promise<boolean> {
  try { await lstat(plist); return true; } catch { return false; }
}

/** Takes the shared lock for one recording; undefined while the old script holds it. Only our own lock is removed. */
export async function acquireLegacyLock(path = LEGACY_LOCK): Promise<(() => Promise<void>) | undefined> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const own = await lstat(path);
  // The old script treats a lock older than 6 h as stale; keep ours fresh during long recordings.
  const refresh = setInterval(() => { void utimes(path, new Date(), new Date()).catch(() => undefined); }, 10 * 60_000);
  refresh.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(refresh);
    try {
      const current = await lstat(path);
      if (current.ino === own.ino && current.dev === own.dev) await rmdir(path);
    } catch { /* Already gone. */ }
  };
}
