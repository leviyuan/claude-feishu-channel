/** Track a promise without creating an unhandled rejecting `.finally()` tail. */
export function trackWork<T>(set: Set<Promise<unknown>>, work: Promise<T>): Promise<T> {
  set.add(work)
  void work.then(
    () => { set.delete(work) },
    () => { set.delete(work) },
  )
  return work
}

/** Drain a dynamically changing work set. Work already being awaited may add
 * follow-ups (for example a fast card-action ACK spawning a callback phase),
 * so a one-time array snapshot is insufficient. */
export async function drainDynamicWork(
  snapshot: () => Iterable<Promise<unknown>>,
): Promise<void> {
  while (true) {
    const pending = [...snapshot()]
    if (pending.length === 0) return
    await Promise.allSettled(pending)
  }
}
