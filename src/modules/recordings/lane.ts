/** One transcription at a time across the folder worker and `transcribeMedia` (whisper and diarization are heavy). */
export type Lane = <T>(task: () => Promise<T>) => Promise<T>;

export function createLane(): Lane {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}
