import type { ModelLoadCheck } from '@nekko-agent/shared';

/**
 * Reading a build of a repo on demand. Opening a repo's page asks the engine only for
 * what it already knows (`engineCatalogChecks(repo)` fetches nothing), so the list keeps its
 * size-based fit; the header of one build is read when the person opens it or presses
 * Download, once ever per file content (the daemon keeps it under the file's hash).
 *
 * `done` holds the files already asked about, so opening a build twice asks once.
 */
export async function openBuild(
  modelId: string,
  file: string,
  current: Record<string, ModelLoadCheck>,
  done: Set<string>,
): Promise<Record<string, ModelLoadCheck>> {
  if (done.has(file) || !window.nekko.engineCatalogChecks) return current;
  try {
    const answer = await window.nekko.engineCatalogChecks(modelId, file);
    done.add(file);
    return { ...current, ...(answer ?? {}) };
  } catch {
    // Not final: the next open tries again.
    return current;
  }
}

/** Why a Download should not start: the engine in use will not run this build. A warning lets it through. */
export function downloadRefusal(check: ModelLoadCheck | undefined): string | undefined {
  return check?.level === 'blocked' ? check.reason : undefined;
}
