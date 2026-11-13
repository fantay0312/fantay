const writes = new Map<string, Promise<void>>();

/** Serialize editor compare-and-write across browser tabs and CLI callers. */
export async function withStudioEditorLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => pending);
  writes.set(key, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (writes.get(key) === tail) writes.delete(key); }
}
