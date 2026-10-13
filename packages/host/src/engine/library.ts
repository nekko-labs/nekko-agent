import { mlxSupported, readMlxModel, type MlxModelInfo } from './mlx.js';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import type {
  EngineLoadPreset,
  LocalModel,
  ModelFolder,
  ModelFolderProviderId,
  ModelFolderStatus,
} from '@nekko-agent/shared';
import { modelModality } from '@nekko-agent/shared';
import { readGgufMetadata } from './gguf.js';
import { listOllamaModels } from './ollama.js';
import { companionsDir } from './companions.js';

/**
 * The models on this machine.
 *
 * The index is a cache, not the truth: the files are the truth. Every read
 * reconciles the two, so a GGUF dropped into the folder by hand appears without
 * an import step and a file deleted outside the app disappears without a stale
 * row. That is deliberate, because a model directory is something people manage
 * with a file manager as much as with an app.
 *
 * There is more than one directory. The folder we download into is ours, and the
 * rest belong to whatever else on this machine runs models: Ollama, LM Studio,
 * Jan, a Hugging Face cache. Those are read, never written, so a model listed
 * from LM Studio's folder can be loaded here but cannot be deleted from here.
 *
 * Geometry comes from each file's own GGUF header, which is what lets the fit
 * planner give an exact answer for a model we hold rather than the partial one it
 * has to give for LM Studio.
 */

const INDEX_FILE = 'library.json';

/** The folder downloads land in. Its models keep bare, unprefixed ids. */
export const PRIMARY_FOLDER_ID = 'primary';

interface IndexFile {
  models: Record<string, StoredModel>;
}

type StoredModel = Omit<LocalModel, 'path' | 'sizeBytes'> & { file: string };

/** One folder to scan, resolved from settings. */
interface Root {
  id: string;
  path: string;
  provider?: ModelFolderProviderId;
  /** Only the primary folder is ours to write to. */
  managed: boolean;
}

export interface LibraryDeps {
  /** Where GGUF files live, and where downloads land. */
  modelsDir: () => string;
  /** Other folders to read, from the engine settings. */
  folders?: () => ModelFolder[];
  /** Whether MLX rows can run here; defaults to this machine (`mlxSupported`). */
  mlxRunnable?: () => boolean;
}

export function createLibrary(deps: LibraryDeps) {
  /** Path of the index, kept beside the models it describes. */
  const indexPath = () => join(deps.modelsDir(), INDEX_FILE);

  /**
   * Every folder to read, primary first.
   *
   * Duplicates are dropped by resolved path, because two rows can legitimately
   * point at the same place: vLLM serves out of the Hugging Face cache, so its
   * row and the cache's row are the same directory under two names.
   */
  function roots(): Root[] {
    const out: Root[] = [
      { id: PRIMARY_FOLDER_ID, path: resolve(deps.modelsDir()), provider: 'nekko', managed: true },
    ];
    const seen = new Set([out[0].path.toLowerCase()]);
    for (const folder of deps.folders?.() ?? []) {
      if (!folder.enabled || !folder.path?.trim()) continue;
      const path = resolve(folder.path);
      const key = path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: folder.id, path, provider: folder.provider, managed: false });
    }
    return out;
  }

  async function readIndex(): Promise<IndexFile> {
    try {
      const parsed = JSON.parse(await readFile(indexPath(), 'utf8')) as IndexFile;
      return parsed?.models ? parsed : { models: {} };
    } catch {
      return { models: {} };
    }
  }

  async function writeIndex(index: IndexFile): Promise<void> {
    await mkdir(deps.modelsDir(), { recursive: true });
    await writeFile(indexPath(), JSON.stringify(index, null, 2), 'utf8');
  }

  /**
   * Every `.gguf` under one folder.
   *
   * Deeper for a borrowed folder than for ours: a Hugging Face cache files a
   * model at `models--org--repo/snapshots/<commit>/model.gguf`, which is already
   * three levels before the file, and LM Studio's publisher/repo nesting is two.
   */
  async function scanFolder(root: Root): Promise<string[]> {
    const maxDepth = root.managed ? 3 : 5;
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        // Ollama's blobs are read from its manifests instead, and a Hugging Face
        // cache's blobs are the same bytes as the snapshot entries beside them.
        if (entry.isDirectory() && entry.name === 'blobs') continue;
        // Our own sidecar store: its files belong to a model row, they are not
        // rows themselves.
        if (entry.isDirectory() && entry.name === '.companions') continue;
        if (entry.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) out.push(full);
      }
    };
    await walk(root.path, 0);
    return out;
  }

  /**
   * The library, reconciled against disk.
   *
   * A file already indexed is returned from the index (reading a GGUF header is
   * cheap but not free, and this runs on a poll). A file that is new gets read
   * once and written back.
   */
  async function list(): Promise<LocalModel[]> {
    const index = await readIndex();
    const byFile = new Map<string, StoredModel>();
    for (const stored of Object.values(index.models)) byFile.set(stored.file, stored);

    const out: LocalModel[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    let dirty = false;

    /** Fold one file into the list, reusing its indexed description when we have one. */
    const add = async (root: Root, path: string, name?: string): Promise<void> => {
      if (seenPaths.has(path.toLowerCase())) return;
      const size = await stat(path)
        .then((s) => s.size)
        .catch(() => 0);
      if (size === 0) return;
      seenPaths.add(path.toLowerCase());

      let stored = byFile.get(path);
      if (!stored || stored.folderId !== root.id) {
        stored = await describe(root, path, name);
        dirty = true;
      }
      // A borrowed folder can collide with ours (two copies of one repo), and a
      // model id is also an API model name, so it has to stay unique.
      let id = stored.id;
      for (let n = 2; seenIds.has(id); n += 1) id = `${stored.id}-${n}`;
      if (id !== stored.id) stored = { ...stored, id };
      seenIds.add(id);

      index.models[id] = stored;
      out.push({ ...stored, path, sizeBytes: size, managed: root.managed, folderId: root.id, folderProvider: root.provider });
    };

    // Directories holding a multimodal projector. Gathered across the whole
    // scan rather than checked per model, so the answer is the truth on disk
    // at this instant rather than a flag that went stale in the index. The
    // nekko-side companions dir counts too: it is where fetched projectors
    // land for models in folders we do not write to.
    const projectorDirs = new Set<string>();
    const companionIds = new Set<string>();
    for (const root of roots()) {
      for (const path of root.provider === 'ollama' ? [] : await scanFolder(root)) {
        if (/mmproj/i.test(basename(path))) projectorDirs.add(dirname(path).toLowerCase());
      }
    }
    try {
      const fetched = join(deps.modelsDir(), '.companions');
      for (const key of await readdir(fetched)) {
        const files = await readdir(join(fetched, key)).catch(() => [] as string[]);
        if (files.some((f) => /mmproj/i.test(f) && f.toLowerCase().endsWith('.gguf'))) companionIds.add(key);
      }
    } catch {
      /* no companions dir yet */
    }

    for (const root of roots()) {
      // Ollama names its files by content hash, so its manifests are the only
      // place the model's name exists. Every other layout is a directory walk.
      if (root.provider === 'ollama') {
        for (const model of await listOllamaModels(root.path)) await add(root, model.path, model.name);
        continue;
      }
      for (const path of await scanFolder(root)) {
        // A shard past the first is part of another model, not a model.
        if (/-\d{5}-of-\d{5}\.gguf$/i.test(path) && !/-00001-of-\d{5}\.gguf$/i.test(path)) continue;
        if (/mmproj/i.test(basename(path))) continue;
        await add(root, path);
      }
    }

    // MLX model folders: rows of their own, served by mlx_lm.server on an
    // Apple Silicon Mac and explained as not runnable anywhere else.
    const mlxRunnable = deps.mlxRunnable ? deps.mlxRunnable() : mlxSupported();
    for (const root of roots()) {
      if (root.provider === 'ollama') continue;
      for (const { dir, info } of await scanMlxFolder(root)) {
        if (seenPaths.has(dir.toLowerCase())) continue;
        seenPaths.add(dir.toLowerCase());
        let stored = byFile.get(dir);
        if (!stored || stored.folderId !== root.id) {
          stored = {
            id: idFor(root, dir),
            name: basename(dir),
            file: dir,
            format: 'mlx',
            folderId: root.id,
            folderProvider: root.provider,
            architecture: info.architecture,
            quantization: info.quantization,
            maxContext: info.maxContext,
            readable: true,
            addedAt: Date.now(),
          };
          dirty = true;
        }
        let id = stored.id;
        for (let n = 2; seenIds.has(id); n += 1) id = `${stored.id}-${n}`;
        if (id !== stored.id) stored = { ...stored, id };
        seenIds.add(id);
        index.models[id] = stored;
        out.push({
          ...stored,
          path: dir,
          sizeBytes: info.sizeBytes,
          managed: root.managed,
          folderId: root.id,
          folderProvider: root.provider,
          modality: info.vision ? 'vision' : 'chat',
          hasProjector: info.vision,
          mlxRunnable,
        });
      }
    }

    // Fold live modality facts onto the rows: what kind of model this is and
    // whether a vision model's projector is actually there.
    const compKey = (id: string) => basename(companionsDir(deps.modelsDir(), id));
    for (const model of out) {
      if (model.format === 'mlx') continue;
      model.hasProjector =
        projectorDirs.has(dirname(model.path).toLowerCase()) || companionIds.has(compKey(model.id));
      model.modality = modelModality({
        architecture: model.architecture,
        name: `${model.id} ${model.name}`,
        hasProjector: model.hasProjector,
        readable: model.readable,
      });
    }

    // Drop rows whose file is gone, so a model deleted in Explorer stops showing.
    // Rows for a folder that is merely switched off are kept: the file is still
    // there, and re-reading every header on the way back is a poll's worth of
    // work for nothing.
    for (const [id, stored] of Object.entries(index.models)) {
      if (seenIds.has(id)) continue;
      // The same file under a different id is a row this scan has replaced (a
      // folder moved, or an id that had to be disambiguated), so it goes too.
      if (!seenPaths.has(stored.file.toLowerCase()) && (await exists(stored.file))) continue;
      delete index.models[id];
      dirty = true;
    }
    if (dirty) await writeIndex(index);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * MLX model folders under one root (a `config.json` beside `.safetensors`
   * weights, see `readMlxModel`). A folder that is a model is not descended
   * into; its weights are its own.
   */
  async function scanMlxFolder(root: Root): Promise<Array<{ dir: string; info: MlxModelInfo }>> {
    const maxDepth = root.managed ? 3 : 5;
    const out: Array<{ dir: string; info: MlxModelInfo }> = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === 'config.json')) {
        const info = await readMlxModel(dir);
        if (info) {
          out.push({ dir, info });
          return;
        }
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'blobs' || entry.name === '.companions') continue;
        await walk(join(dir, entry.name), depth + 1);
      }
    };
    await walk(root.path, 0);
    return out;
  }

  /** Read one file's header into a library row. */
  async function describe(root: Root, path: string, name?: string): Promise<StoredModel> {
    const meta = await readGgufMetadata(path);
    const file = basename(path);
    return {
      // A named model is named by its folder's own scheme (Ollama's manifests),
      // and the name is the only part of it a person or another tool can type.
      // The path is a content hash, which would be a stable id nobody could use.
      id: name ? `${root.id}/${name}` : idFor(root, path),
      name: name || meta?.name?.trim() || file.replace(/\.gguf$/i, ''),
      file: path,
      sourceRepo: root.managed && /^(chat|vision|embedding|image|audio|draft|unknown)$/.test(relative(root.path, path).split(sep)[0]) ? repoFromTypedPath(root.path, path) : undefined,
      folderId: root.id,
      folderProvider: root.provider,
      quantization: meta?.quantization,
      parameterSize: meta?.parameterSize,
      architecture: meta?.architecture,
      layers: meta?.layers,
      kvHeads: meta?.kvHeads,
      headDim: meta?.headDim,
      maxContext: meta?.maxContext,
      hasChatTemplate: Boolean(meta?.chatTemplate),
      // False only when the header would not read at all: an old GGML file
      // renamed .gguf, a truncated download. Absent on rows indexed before the
      // flag existed, where it reads as true.
      readable: meta !== null,
      addedAt: Date.now(),
    };
  }

  /**
   * A stable id: the path below its folder, slashes normalized, prefixed with
   * the folder for everything outside our own.
   *
   * It doubles as the model id served over the API, so it has to be stable across
   * restarts and safe in a URL, and it has to survive the models dir moving. Our
   * own models keep bare ids so every id that has ever been saved in a preset or
   * typed into another tool still resolves.
   */
  function idFor(root: Root, path: string): string {
    const full = resolve(path);
    const prefix = root.path.endsWith(sep) ? root.path : root.path + sep;
    const rel = full.toLowerCase().startsWith(prefix.toLowerCase()) ? full.slice(prefix.length) : basename(full);
    const clean = rel.replace(/\\/g, '/').replace(/\.gguf$/i, '');
    return root.id === PRIMARY_FOLDER_ID ? clean : `${root.id}/${clean}`;
  }

  async function find(id: string): Promise<LocalModel | undefined> {
    return (await list()).find((m) => m.id === id);
  }

  /** Adopt a GGUF that lives somewhere else, without copying it. */
  async function importFile(path: string): Promise<{ ok: boolean; message: string; model?: LocalModel }> {
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    if (!size) return { ok: false, message: 'That file does not exist.' };
    if (!path.toLowerCase().endsWith('.gguf')) {
      return { ok: false, message: 'Nekko Agent runs GGUF files. Convert or download a GGUF build of this model.' };
    }
    const meta = await readGgufMetadata(path);
    if (!meta) return { ok: false, message: "That file isn't a readable GGUF." };

    const index = await readIndex();
    const primary = roots()[0];
    const stored = await describe(primary, path);
    index.models[stored.id] = stored;
    await writeIndex(index);
    return { ok: true, message: `Added ${stored.name}.`, model: { ...stored, path, sizeBytes: size, managed: true } };
  }

  /** Delete the file and its row. Shards and projectors go with it. */
  async function remove(id: string): Promise<{ ok: boolean; message: string }> {
    const model = await find(id);
    if (!model) return { ok: false, message: 'That model is not in the library.' };
    // Deleting out of someone else's folder would break their app, and nothing
    // in this window says which app that is. Refuse and say where it lives.
    if (model.managed === false) {
      return {
        ok: false,
        message: `${model.name} lives in a folder Nekko Agent only reads. Delete it in the app that downloaded it.`,
      };
    }

    const primary = roots()[0];
    const companions = (await scanFolder(primary)).filter((p) => isCompanionOf(p, model.path));
    for (const path of [model.path, ...companions]) await rm(path, { force: true });
    // Sidecars we fetched for it live under our own dir, so they go too.
    await rm(companionsDir(deps.modelsDir(), id), { recursive: true, force: true });

    const index = await readIndex();
    delete index.models[id];
    await writeIndex(index);
    return { ok: true, message: `Deleted ${model.name}.` };
  }

  /** Save per-model load settings, so a model loads the same way every time. */
  async function savePreset(id: string, preset: EngineLoadPreset): Promise<void> {
    const index = await readIndex();
    const stored = index.models[id];
    if (!stored) return;
    stored.preset = preset;
    await writeIndex(index);
  }

  /** Total bytes the library occupies, for the disk-use line. */
  async function diskUsage(): Promise<number> {
    return (await list()).reduce((n, m) => n + m.sizeBytes, 0);
  }

  /**
   * What each configured folder actually holds, for the folder list.
   *
   * Counted from the same scan `list` uses rather than from a cheaper estimate,
   * so the number beside a folder is the number of models it contributes.
   */
  async function folderReport(): Promise<ModelFolderStatus[]> {
    const models = await list();
    return Promise.all(
      [
        { id: PRIMARY_FOLDER_ID, path: deps.modelsDir(), provider: 'nekko' as const, enabled: true, primary: true },
        ...(deps.folders?.() ?? []),
      ].map(async (folder) => {
        const mine = models.filter((m) => m.folderId === folder.id);
        return {
          ...folder,
          exists: await exists(folder.path),
          modelCount: mine.length,
          sizeBytes: mine.reduce((n, m) => n + m.sizeBytes, 0),
        } satisfies ModelFolderStatus;
      }),
    );
  }

  /** How many models a folder would contribute, before anyone adds it. */
  async function probe(path: string, provider?: ModelFolderProviderId): Promise<{ modelCount: number; sizeBytes: number }> {
    const root: Root = { id: 'probe', path: resolve(path), provider, managed: false };
    const files =
      provider === 'ollama'
        ? (await listOllamaModels(root.path)).map((m) => m.path)
        : (await scanFolder(root)).filter(
            (p) => !(/-\d{5}-of-\d{5}\.gguf$/i.test(p) && !/-00001-of-\d{5}\.gguf$/i.test(p)) && !/mmproj/i.test(basename(p)),
          );
    let sizeBytes = 0;
    for (const file of files) sizeBytes += await stat(file).then((s) => s.size).catch(() => 0);
    return { modelCount: files.length, sizeBytes };
  }

  return { list, find, importFile, remove, savePreset, diskUsage, folderReport, probe, idFor, roots };
}

export type Library = ReturnType<typeof createLibrary>;

/** What the rest of the engine needs from a library, wherever it lives. */
export type LibraryApi = Pick<Library, 'list' | 'find' | 'importFile' | 'remove' | 'savePreset' | 'diskUsage'>;

/**
 * The library of a host running under the engine daemon, which is the single
 * writer of `library.json` (`crates/nekko-engine` `library`, `NEKKOD_OWNS`
 * `library`): every read and write is the daemon's, so the index is never
 * written by two processes.
 */
export function daemonLibrary(call: <T>(channel: string, ...args: unknown[]) => Promise<T>): LibraryApi {
  const list = () => call<LocalModel[]>('engine:library');
  return {
    list,
    find: async (id: string) => (await list()).find((m) => m.id === id),
    importFile: (path: string) => call('engine:importModel', path),
    remove: (id: string) => call('engine:deleteModel', id),
    savePreset: async (id: string, preset: EngineLoadPreset) => {
      await call('engine:saveModelPreset', id, preset);
    },
    diskUsage: async () => (await list()).reduce((n, m) => n + m.sizeBytes, 0),
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

/**
 * A later shard, the projector, or a template we extracted, belonging to the
 * same model.
 */
function repoFromTypedPath(root: string, path: string): string | undefined {
  const repo = relative(root, path).split(sep)[1] ?? '';
  const i = repo.indexOf('_');
  return i > 0 ? `${repo.slice(0, i)}/${repo.slice(i + 1)}` : undefined;
}

function isCompanionOf(candidate: string, primary: string): boolean {
  if (candidate === primary) return false;
  const stem = primary.replace(/-00001-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '');
  return (
    (candidate.startsWith(stem) && /(-\d{5}-of-\d{5}\.gguf|mmproj.*\.gguf)$/i.test(candidate)) ||
    candidate === `${stem}.chat_template.jinja`
  );
}
