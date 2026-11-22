import { mainCheckoutPath } from './artifactPaths.js';
import { DESIGNS_FOLDER, readProjectDesignFolders } from './artifactsIndex.js';

/**
 * Finding a file that is not where a link or a saved window says it is (#3210):
 * its git worktree was removed after merging, or a reply named it by its bare
 * name and the link guessed the chat folder. Listings only: nothing is opened.
 */

export type ListDir = (path: string) => Promise<Array<{ name: string; path: string; dir: boolean }>>;

function split(path: string): [string, string] {
  const p = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const slash = p.lastIndexOf('/');
  return slash < 0 ? ['', p] : [p.slice(0, slash), p.slice(slash + 1)];
}

/** True when the file's folder lists it, false when it doesn't or the folder is gone, null when it has no folder. */
export async function fileListed(path: string, listDir: ListDir): Promise<boolean | null> {
  const [dir, name] = split(path);
  if (!dir || !name) return null;
  try {
    const listed = await listDir(dir);
    return Array.isArray(listed) && listed.some((e) => String(e?.name ?? '').toLowerCase() === name.toLowerCase());
  } catch {
    return false;
  }
}

/** Pages, pictures and documents a chat makes: the files worth looking for by name in a designs folder. */
const MADE_FILE = /\.(?:html?|svg|png|jpe?g|gif|webp|avif|pdf|md)$/i;

/** The project a path belongs to for the designs search: the folder, or the one above its designs folder. */
function projectOf(dir: string): string {
  const parts = dir.split('/');
  const at = parts.findIndex((p) => p.toLowerCase() === DESIGNS_FOLDER);
  return at > 0 ? parts.slice(0, at).join('/') : dir;
}

/**
 * Where a missing file is now, or null:
 * 1. the same place in the repo's main checkout, when it was in a git worktree;
 * 2. for a page, picture or document, a file of the same name in the designs
 *    folder of its folder or of a project one level inside it (a chat folder
 *    is often the parent of many repos, each with its own `nekko-designs/`).
 */
export async function locateMovedFile(path: string, listDir: ListDir): Promise<string | null> {
  const main = mainCheckoutPath(path);
  if (main && (await fileListed(main, listDir))) return main;
  const [dir, name] = split(path);
  if (!dir || !MADE_FILE.test(name)) return null;
  const roots = [...new Set([projectOf(dir), ...(main ? [projectOf(split(main)[0])] : [])])];
  for (const root of roots) {
    const folders = await readProjectDesignFolders(listDir, { name: '', path: root });
    for (const folder of folders) {
      const hit = folder.files.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (hit) return hit.path.replaceAll('\\', '/');
    }
  }
  return null;
}
