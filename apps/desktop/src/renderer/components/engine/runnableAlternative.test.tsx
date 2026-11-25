import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModelDetail, CatalogQuant, LocalModel } from '@nekko-agent/shared';
import { clearCatalogDetails, loadCatalogDetail } from './catalogDetails.js';
import { groupModelFamilies, type LibraryModel } from './modelFamilies.js';
import { ModelDownloadButton } from './ModelDownloadButton.js';
import { OfferView } from './RunnableAlternativeOffer.js';
import { loadableFiles, offerText, updateBuildId, runnableAlternative, wantsAlternative } from './runnableAlternative.js';

const repo = 'prism-ml/Ternary-Bonsai-2-27B-gguf';
const GB = 1e9;
const quant = (label: string, size: number, stock: boolean, file = `Ternary-Bonsai-2-27B-${label}.gguf`): CatalogQuant => ({ label, file, sizeBytes: size * GB, extraFiles: ['Ternary-Bonsai-2-27B-mmproj-BF16.gguf'], stock });
/** The real repo's builds, as the daemon's catalog answers for it. */
const bonsai = (quants: CatalogQuant[] = [quant('F16', 53.8, true), quant('PQ2_0', 7.21, false), quant('PTQ1_0', 5.95, false), quant('Q2_0', 7.63, true)]): CatalogModelDetail =>
  ({ id: repo, name: 'Ternary Bonsai 2 27B', owner: 'prism-ml', tags: ['chat'], quants });
const blocked: Partial<LocalModel> = { loadCheck: { level: 'blocked', cause: 'weightFormat', reason: 'It needs a modified build of llama.cpp.' }, minEngineBuild: 11556 };
const row = (extra: Partial<LocalModel> = {}): LocalModel => ({
  id: 'lmstudio/prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf', name: 'Ternary-Bonsai-2-27B-PTQ1_0',
  path: 'C:\\Users\\Asus\\.lmstudio\\models\\prism-ml\\Ternary-Bonsai-2-27B-gguf\\Ternary-Bonsai-2-27B-PTQ1_0.gguf', sizeBytes: 5.95 * GB, addedAt: 0,
  sourceRepo: repo, ...blocked, ...extra,
});

describe('the build that runs, offered on a blocked row', () => {
  it('offers the smallest stock build that is not full precision, from a repo that lists this very file', () => {
    const alt = runnableAlternative(row(), bonsai());
    expect(alt).toMatchObject({ repo, quant: { label: 'Q2_0' }, engineTooOld: false });
    expect(offerText(alt!)).toBe('A build that runs here is in the same repo: Q2_0, 7.1 GB.');
  });

  it('picks the smallest of several, and a full-precision one only when nothing else will run', () => {
    const many = bonsai([quant('PTQ1_0', 5.95, false), quant('Q4_K_M', 16, true), quant('Q2_K', 9.5, true), quant('BF16', 54, true), quant('Q8_0', 28, true)]);
    expect(runnableAlternative(row(), many)?.quant.label).toBe('Q2_K');
    const onlyFull = bonsai([quant('PTQ1_0', 5.95, false), quant('F16', 53.8, true), quant('BF16', 53.9, true)]);
    expect(runnableAlternative(row(), onlyFull)?.quant.label).toBe('F16');
  });

  it('offers nothing when the repo has no stock build, or the stock build is already on this machine', () => {
    expect(runnableAlternative(row(), bonsai([quant('PTQ1_0', 5.95, false), quant('PQ2_0', 7.21, false)]))).toBeNull();
    // Any stock build already here ends the offer, not just the one it would have picked.
    expect(runnableAlternative(row(), bonsai(), ['Ternary-Bonsai-2-27B-Q2_0.gguf'])).toBeNull();
    expect(runnableAlternative(row(), bonsai(), ['Unrelated-Q4_K_M.gguf'])?.quant.label).toBe('Q2_0');
  });

  it('counts only the files the engine can load as already here', () => {
    const blocked = { level: 'blocked', cause: 'engineAge', reason: 'too old' } as const;
    const m = (path: string, extra = {}) => ({ id: path, name: path, path, ...extra }) as LocalModel;
    expect(loadableFiles([m('/a/ok.gguf'), m('/a/old.gguf', { loadCheck: blocked }), m('/a/img.gguf', { modality: 'image', loadCheck: blocked })])).toEqual(['ok.gguf', 'img.gguf']);
  });

  it('still has a build to update with when the engine card stays quiet', () => {
    const outdated = { buildId: 'win-x64-cuda', installed: 'b12400', pinned: 'b12436', message: 'x', notify: false };
    expect(updateBuildId({ install: { outdated } })).toBe('win-x64-cuda');
    expect(updateBuildId({ install: { outdated: { ...outdated, notify: true } } })).toBe('win-x64-cuda');
    expect(updateBuildId({ install: {} })).toBeUndefined();
  });

  describe('trust', () => {
    it('needs a source repo', () => {
      expect(runnableAlternative(row({ sourceRepo: undefined }), bonsai())).toBeNull();
    });
    it('needs the repo to list a file with exactly this name', () => {
      // A folder named for one model that holds another: the repo has no such file.
      expect(runnableAlternative(row({ path: '/m/prism-ml/Ternary-Bonsai-2-27B-gguf/Underdog-Saluki-27B-IQ2-mix.gguf' }), bonsai())).toBeNull();
      expect(runnableAlternative(row({ path: '/m/ternary-bonsai-2-27b-ptq1_0.gguf' }), bonsai())).toBeNull();
      expect(runnableAlternative(row({ path: '/m/x/Ternary-Bonsai-2-27B-PTQ1_0.gguf.bak' }), bonsai())).toBeNull();
    });
    it('reads the file name from a POSIX or a Windows path, and a repo file in a subfolder by its name', () => {
      expect(runnableAlternative(row({ path: '/home/me/.lmstudio/models/prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf' }), bonsai())).not.toBeNull();
      expect(runnableAlternative(row(), bonsai([quant('PTQ1_0', 5.95, false, 'sub/Ternary-Bonsai-2-27B-PTQ1_0.gguf'), quant('Q2_0', 7.63, true)]))).not.toBeNull();
    });
    it('needs the page to be the row’s own repo', () => {
      expect(runnableAlternative(row(), { ...bonsai(), id: 'someone/else-gguf' })).toBeNull();
      expect(runnableAlternative(row(), null)).toBeNull();
      expect(runnableAlternative(row(), undefined)).toBeNull();
    });
  });

  describe('which rows', () => {
    it('only a weight-format block; not a warning, an engine-age block, or a model that runs', () => {
      expect(wantsAlternative(row())).toBe(true);
      expect(wantsAlternative(row({ loadCheck: { level: 'warning', cause: 'weightFormat', reason: 'r' } }))).toBe(false);
      expect(wantsAlternative(row({ loadCheck: { level: 'blocked', cause: 'engineAge', reason: 'r' } }))).toBe(false);
      expect(wantsAlternative(row({ loadCheck: undefined }))).toBe(false);
      expect(runnableAlternative(row({ loadCheck: undefined }), bonsai())).toBeNull();
    });
  });

  describe('the engine’s age', () => {
    it('says the engine must be updated too, from what the engine reported on the row', () => {
      const alt = runnableAlternative(row({ engineMeetsMinBuild: false }), bonsai())!;
      expect(alt).toMatchObject({ engineTooOld: true, minBuild: 11556 });
      expect(offerText(alt)).toBe('A build that runs here is in the same repo: Q2_0, 7.1 GB. It needs llama.cpp b11556 or newer, so update the engine first.');
    });
    it('stays quiet about it when the engine meets the build, or its age is not known', () => {
      expect(offerText(runnableAlternative(row({ engineMeetsMinBuild: true }), bonsai())!)).not.toContain('update');
      expect(offerText(runnableAlternative(row({ engineMeetsMinBuild: undefined }), bonsai())!)).not.toContain('update');
    });
  });
});

/** The elements of a rendered tree (unrendered: function components are not called). */
function find(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, type, out));
  else if (node && typeof node === 'object' && 'type' in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === type) out.push(el);
    find(el.props.children, type, out);
  }
  return out;
}

describe('the offer on the row', () => {
  const view = (extra: Partial<LocalModel>, canUpdate = true) => {
    const offer = runnableAlternative(row(extra), bonsai())!;
    return { offer, props: { offer, canUpdate, updating: false, onUpdate: vi.fn(), onDownloaded: vi.fn() } };
  };

  it('downloads through the catalog: this repo and this quant', () => {
    const { props } = view({});
    const [button] = find(OfferView(props), ModelDownloadButton);
    expect(button.props).toMatchObject({ modelId: repo, quant: 'Q2_0', variant: 'quiet' });
  });

  it('is plain: the build and its size and a Download, no update with a current engine', () => {
    const html = renderToStaticMarkup(<OfferView {...view({ engineMeetsMinBuild: true }).props} />);
    expect(html).toContain('data-runnable-alternative');
    expect(html).toContain('A build that runs here is in the same repo: Q2_0, 7.1 GB.');
    expect(html).toContain('Download');
    expect(html).not.toContain('Update engine');
    expect(html).not.toContain('first');
  });

  it('with an old engine says so and offers the update beside Download', () => {
    const html = renderToStaticMarkup(<OfferView {...view({ engineMeetsMinBuild: false }).props} />);
    expect(html).toContain('It needs llama.cpp b11556 or newer, so update the engine first.');
    expect(html).toContain('Update engine');
    expect(html).toContain('Download');
  });

  it('without an update to run, still says the engine needs one and leaves the card to do it', () => {
    const html = renderToStaticMarkup(<OfferView {...view({ engineMeetsMinBuild: false }, false).props} />);
    expect(html).toContain('update the engine first');
    expect(html).not.toContain('Update engine');
  });

  it('wires the Update button to the update', () => {
    const { props } = view({ engineMeetsMinBuild: false });
    const button = find(OfferView(props), 'button').find((b) => 'data-update-engine' in (b.props as object))!;
    (button.props as { onClick: () => void }).onClick();
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('the build, once downloaded', () => {
  it('joins the blocked file’s family: the same repo is the same family', () => {
    const lib = (id: string, name: string, extra: Partial<LibraryModel> = {}): LibraryModel => ({ ...row({ id, name, path: `/m/${id}` }), loaded: false, ...extra });
    const blockedRow = lib('lm/PTQ1_0', 'Ternary-Bonsai-2-27B-PTQ1_0');
    // What the library lists for the download: sourceRepo from its `<owner>_<repo>` folder, and a header name of its own.
    const downloaded = lib('prism-ml_Ternary-Bonsai-2-27B-gguf/Q2_0', 'Ternary Bonsai 2 27B', { loadCheck: undefined, minEngineBuild: 11556 });
    const catalog = [{ id: repo, name: 'Ternary Bonsai 2 27B', owner: 'prism-ml', tags: [], quants: [] }];
    for (const c of [[], catalog]) {
      const families = groupModelFamilies([blockedRow, downloaded], c);
      expect(families).toHaveLength(1);
      expect(families[0].local.map((m) => m.id)).toEqual([blockedRow.id, downloaded.id]);
    }
  });
});

describe('the repo page, shared', () => {
  beforeEach(() => clearCatalogDetails());
  const detail = vi.fn(async (id: string) => (id === repo ? bonsai() : null));
  const install = () => { detail.mockClear(); Object.assign(globalThis, { window: { nekko: { engineCatalogDetail: detail } } }); };

  it('is one request for a repo however many places ask, and tries again after a miss', async () => {
    install();
    const [a, b] = await Promise.all([loadCatalogDetail(repo), loadCatalogDetail(repo)]);
    expect(a).toBe(b);
    await loadCatalogDetail(repo);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(await loadCatalogDetail('nobody/none')).toBeNull();
    await loadCatalogDetail('nobody/none');
    expect(detail).toHaveBeenCalledTimes(3);
  });
});
