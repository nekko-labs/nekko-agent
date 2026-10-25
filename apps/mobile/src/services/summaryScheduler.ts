/** Coalesce list invalidations, including ones arriving while a request is pending. */
export function createSummaryScheduler<T>(fetch: () => Promise<T>, apply: (value: T) => void, delay = 600) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let dirty = false;
  let revision = 0;
  let generation = 0;

  function schedule(): void {
    dirty = true;
    revision++;
    if (timer || pending) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch(() => {});
    }, delay);
  }

  function refresh(): Promise<void> {
    if (pending) {
      schedule();
      return pending;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    dirty = false;
    const started = revision;
    const owner = generation;
    pending = Promise.resolve().then(fetch).then((value) => {
      if (generation === owner && revision === started) apply(value);
    }).finally(() => {
      if (generation === owner) {
        pending = undefined;
        // Only a new invalidation, not a failed request, schedules another fetch.
        if (dirty) schedule();
      }
    });
    return pending;
  }

  function reset(): void {
    generation++;
    revision++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
    dirty = false;
  }

  return { schedule, refresh, reset };
}
