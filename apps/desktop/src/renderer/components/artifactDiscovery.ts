export const ARTIFACT_HIGHLIGHT_MS = 10_000;

/** Tracks paths across snapshots, not counts. A missing session invalidates hydration. */
export function createArtifactDiscovery(onDiscover: () => void, onHighlight: (active: boolean) => void) {
  let baseline: { sessionId: string; seen: Set<string> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  return {
    update(sessionId: string, paths: readonly string[] | null) {
      if (paths === null || baseline?.sessionId !== sessionId) {
        clear();
        baseline = paths === null ? undefined : { sessionId, seen: new Set(paths.map(path => path.toLowerCase())) };
        onHighlight(false);
        return;
      }
      let discovered = false;
      for (const path of paths) {
        const key = path.toLowerCase();
        if (!baseline.seen.has(key)) {
          baseline.seen.add(key);
          discovered = true;
        }
      }
      if (!discovered) return;
      clear();
      onDiscover();
      onHighlight(true);
      timer = setTimeout(() => {
        timer = undefined;
        onHighlight(false);
      }, ARTIFACT_HIGHLIGHT_MS);
    },
    dispose() {
      clear();
      baseline = undefined;
    },
  };
}
