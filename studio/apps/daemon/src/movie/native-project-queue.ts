const pending = new Map<string, Promise<void>>();

/** Serialize one bound document without blocking other projects. */
export async function withNativeProject<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, tail);
  await before;
  try { return await work(); }
  finally { release(); if (pending.get(key) === tail) pending.delete(key); }
}
