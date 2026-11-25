import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ImageRecommendedOption, Recommendations } from '@nekko-agent/shared';
import { catalogKind, familyKind, groupModelFamilies, setUpPictureModels, shelveCatalog, type LibraryModel } from './modelFamilies.js';
import { KIND_FILTERS, familiesFor, familyLine, isMoreFamily, kindNote, setUpFitText, setUpModelOf } from './ModelsHome.js';
import { durationText, pictureModelBlurb, pictureTimeText } from './pictureModelText.js';
import { RecommendationList, imageFitText } from './RecommendedModels.js';
import { needsOffload } from '../agent-console/imageOffload.js';
import fixture from './recommendations.fixture.json';

const local = (name: string, extra: Partial<LibraryModel> = {}): LibraryModel => ({ id: name, name, path: `/m/${name}`, sizeBytes: 100, addedAt: 0, loaded: false, ...extra });
const catalog = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, name: id.split('/')[1], owner: id.split('/')[0], tags: [], quants: [], ...extra });
const kinds = (l: LibraryModel[], c: CatalogModel[]) => Object.fromEntries(groupModelFamilies(l, c).map(f => [f.name, familyKind(f)]));

describe('what a model family makes', () => {
  it('tells chat, picture and video models apart', () => {
    expect(kinds(
      [local('Qwen3-8B-Q4_K_M.gguf', { modality: 'chat' }), local('z_image_turbo-Q4_K.gguf', { modality: 'image', architecture: 'z-image' })],
      [catalog('leejet/FLUX.2-klein-4B-GGUF'), catalog('QuantStack/Wan2.2-TI2V-5B-GGUF'), catalog('acme/Painter-GGUF', { tags: ['image'] })],
    )).toEqual({
      'Qwen3-8B': 'chat',
      'z-image-turbo': 'image',
      'FLUX.2-klein-4B': 'image',
      'Wan2.2-TI2V-5B': 'video',
      'Painter': 'image',
    });
  });

  it('counts a Wan file on disk as video, though the engine runs it as a picture model', () => {
    expect(kinds([local('wan2.2_ti2v_5B-Q4_K_M.gguf', { modality: 'image', architecture: 'wan' })], [])).toEqual({ 'wan2.2-ti2v-5B': 'video' });
  });

  it('offers All, Chat, Pictures and Video, and says what Video cannot do yet', () => {
    expect(KIND_FILTERS.map(k => k.label)).toEqual(['All', 'Chat', 'Pictures', 'Video']);
    expect(kindNote('video', '', 3)).toContain('Wan 2.2 TI2V 5B makes short clips');
    expect(kindNote('video', '', 3)).not.toContain('listed');
    expect(kindNote('image', '', 0)).toContain('Download one of the picks above');
    expect(kindNote('image', 'flux', 0)).toBeNull();
    expect(kindNote('chat', '', 0)).toBeNull();
  });
});

const option = (o: Partial<ImageRecommendedOption>): ImageRecommendedOption => ({
  modelId: 'z-image-turbo', name: 'Z-Image Turbo', owner: 'Tongyi-MAI', repo: 'leejet/Z-Image-Turbo-GGUF', license: 'Apache-2.0',
  capabilities: ['create'], companionSet: 'z-image', quant: 'Q4_K', downloadLabel: 'Q4_K', files: ['z_image_turbo-Q4_K.gguf'],
  weightsBytes: 3.86e9, companionBytes: 2.83e9, downloadBytes: 6.69e9, memoryBytes: 6e9, headroomBytes: 1e9,
  placement: 'gpu', offloadToCpu: true, fit: 'tight', ...o,
});
const base = (fixture as unknown as Record<'rtx4060', Recommendations>).rtx4060;
const withPictures: Recommendations = {
  ...base,
  imageTasks: [
    { task: 'imageCreate', label: 'Create pictures', capability: 'create', pick: option({}), options: [option({})] },
    { task: 'imageEdit', label: 'Edit photos', capability: 'edit', pick: option({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', files: ['flux-2-klein-4b-Q4_0.gguf'], quant: 'Q4_0', downloadLabel: 'Q4_0', capabilities: ['create', 'edit'], offloadToCpu: false, fit: 'fits' }), options: [] },
  ],
};

describe('picture models in the recommendations', () => {
  it('lists the picture picks beside the chat ones, with no speed and the offload said', () => {
    const html = renderToStaticMarkup(<RecommendationList recs={withPictures} models={[{ path: '/m/flux-2-klein-4b-Q4_0.gguf' }]} onDownload={vi.fn()} onRecheck={vi.fn()} />);
    expect(html).toContain('Create pictures');
    expect(html).toContain('Z-Image Turbo');
    expect(html).toContain('Tight, with offload');
    expect(html).toContain('with its supporting files');
    expect(html.match(/data-image-recommendation/g)).toHaveLength(2);
    // The edit pick is already on disk.
    expect(html).toMatch(/data-recommendation="flux2-klein-4b"[\s\S]*Downloaded/);
    const rows = html.split('data-image-recommendation').slice(1).join('');
    expect(rows).not.toMatch(/tok\/s/);
  });

  it('names the fit honestly', () => {
    expect(imageFitText(option({ offloadToCpu: false, fit: 'fits' })).text).toBe('Fits');
    expect(imageFitText(option({ offloadToCpu: false, fit: 'fits' })).title).toContain('estimate');
    expect(imageFitText(option({ fit: 'fits' })).text).toBe('Fits with offload');
  });

  it('turns on offload only for a model the recommendations say needs it, and only once', () => {
    const recs = withPictures;
    expect(needsOffload({ path: '/models/image/x/z_image_turbo-Q4_K.gguf' }, recs)).toBe(true);
    expect(needsOffload({ path: '/models/image/x/z_image_turbo-Q4_K.gguf', preset: { diffusion: { offloadToCpu: true } } }, recs)).toBe(false);
    expect(needsOffload({ path: '/models/image/x/flux-2-klein-4b-Q4_0.gguf' }, recs)).toBe(false);
    expect(needsOffload({ path: '/models/image/x/someone-elses.gguf' }, recs)).toBe(false);
    expect(needsOffload({ path: '/models/image/x/z_image_turbo-Q4_K.gguf' }, null)).toBe(false);
  });
});

describe('picture and video models are a short list', () => {
  const klein = option({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', repo: 'leejet/FLUX.2-klein-4B-GGUF', files: ['flux-2-klein-4b-Q4_0.gguf'], quant: 'Q4_0', capabilities: ['create', 'edit'] });
  const picks = setUpPictureModels({ imageTasks: [
    { task: 'imageCreate', label: 'Create pictures', capability: 'create', pick: option({}), options: [option({}), klein] },
    { task: 'imageEdit', label: 'Edit photos', capability: 'edit', pick: klein, options: [klein] },
  ] });
  const hf = (id: string, downloads: number, extra: Partial<CatalogModel> = {}) => catalog(id, { tags: ['chat'], downloads, pipelineTag: 'text-to-image', ...extra });
  const search = [
    hf('unsloth/FLUX.2-klein-9B-GGUF', 490506),
    hf('leejet/FLUX.2-klein-4B-GGUF', 220320),
    hf('acme/FLUX.1-dev-remix-GGUF', 64738),
    hf('city96/HiDream-I1-Fast-gguf', 8593),
    hf('someone/flux-test-GGUF', 512),
    hf('acme/Dreamer-GGUF', 90000, { pipelineTag: 'image-to-video' }),
    catalog('unsloth/Qwen3-4B-GGUF', { tags: ['chat'], downloads: 300, pipelineTag: 'text-generation' }),
  ];
  const ids = (l: CatalogModel[]) => l.map(m => m.id);

  it('takes the set-up models from the recommendations, once per repository', () => {
    expect(picks.map(p => p.repo)).toEqual(['leejet/Z-Image-Turbo-GGUF', 'leejet/FLUX.2-klein-4B-GGUF']);
    expect(setUpPictureModels(null)).toEqual([]);
  });

  it('reads what a repository makes from its declared task when the name does not say', () => {
    expect(catalogKind(hf('acme/Dreamer-GGUF', 1, { pipelineTag: 'image-to-video' }))).toBe('video');
    expect(catalogKind(hf('acme/Painter-GGUF', 1))).toBe('image');
    expect(catalogKind(catalog('acme/Looker-GGUF', { pipelineTag: 'image-text-to-text' }))).toBe('chat');
  });

  it('lists the set-up one first, keeps known publishers behind Show more and drops the rest', () => {
    const { listed, more } = shelveCatalog(search, picks, [], true);
    // The set-up repository leads; chat results are never held back, whatever their downloads.
    expect(ids(listed)).toEqual(['leejet/FLUX.2-klein-4B-GGUF', 'leejet/Z-Image-Turbo-GGUF', 'unsloth/Qwen3-4B-GGUF']);
    expect(ids(more)).toEqual(['unsloth/FLUX.2-klein-9B-GGUF']);
    // An unknown publisher, a known one under the download bar, a barely downloaded one, an unknown video repo: gone.
    expect([...ids(listed), ...ids(more)]).not.toEqual(expect.arrayContaining(['acme/FLUX.1-dev-remix-GGUF']));
    expect([...listed, ...more]).toHaveLength(4);
  });

  it('offers the set-up models before any search, with the size the recommendation chose', () => {
    const { listed, more } = shelveCatalog([], picks, [], true);
    expect(more).toEqual([]);
    expect(listed.map(m => [m.id, m.tags[0], m.quants[0].label])).toEqual([
      ['leejet/Z-Image-Turbo-GGUF', 'image', 'Q4_K'],
      ['leejet/FLUX.2-klein-4B-GGUF', 'image', 'Q4_0'],
    ]);
    expect(shelveCatalog([], [option({ repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF', name: 'Wan 2.2 TI2V 5B', capabilities: ['video'] })], [], true).listed[0].tags).toEqual(['video']);
    // The starter list stays chat only.
    expect(shelveCatalog([], picks, [], false).listed).toEqual([]);
  });

  it('never hides a repository whose files are already on this machine', () => {
    const { listed } = shelveCatalog(search, picks, [{ sourceRepo: 'someone/flux-test-GGUF' }], false);
    expect(ids(listed)).toContain('someone/flux-test-GGUF');
  });

  it('folds a family only when nothing in it is set up or downloaded', () => {
    const { listed, more } = shelveCatalog([hf('unsloth/Z-Image-Turbo-GGUF', 984584, { baseModel: 'Tongyi-MAI/Z-Image-Turbo' }), hf('unsloth/FLUX.2-klein-9B-GGUF', 490506)], picks, [], true);
    const moreIds = new Set(ids(more));
    const folded = Object.fromEntries(groupModelFamilies([], [...listed, ...more]).map(f => [f.name, isMoreFamily(f, moreIds)]));
    // Another publisher's copy of a set-up model joins that model's family instead of a row of its own.
    expect(folded).toEqual({ 'Z-Image-Turbo': false, 'FLUX.2-klein-4B': false, 'FLUX.2-klein-9B': true });
  });

  it('names a set-up family by the model and says what it is for, downloaded or not', () => {
    const { listed } = shelveCatalog([hf('unsloth/FLUX.2-klein-9B-GGUF', 490506)], picks, [], true);
    const families = groupModelFamilies([local('z_image_turbo-Q4_K.gguf', { modality: 'image', sourceRepo: 'leejet/Z-Image-Turbo-GGUF' })], listed);
    expect(families.map(f => setUpModelOf(f, picks)?.name).sort()).toEqual(['FLUX.2 klein 4B', 'Z-Image Turbo']);
    expect(setUpModelOf(groupModelFamilies([], [hf('unsloth/FLUX.2-klein-9B-GGUF', 490506)])[0], picks)).toBeUndefined();
    expect(pictureModelBlurb(klein)).toBe('Small and quick, and it can also edit photos.');
    expect(pictureModelBlurb({ modelId: 'new-one', capabilities: ['video'] })).toBe('Makes short video clips.');
    expect(pictureModelBlurb({ modelId: 'new-one', capabilities: ['create'] })).toBe('Creates pictures from a description.');
  });

  it('says a set-up model\'s fit in the recommendation\'s words', () => {
    expect(setUpFitText(option({ fit: 'tooBig' }))).toBe('Too large for this computer');
    expect(setUpFitText(option({ fit: 'fits', offloadToCpu: false }))).toBe('Fits');
  });
});

describe('how long a picture takes', () => {
  it('says nothing unless something measured it', () => {
    expect(pictureTimeText(option({}))).toBeNull();
    expect(pictureTimeText(option({ time: { seconds: 0, basis: 'measuredHere' } }))).toBeNull();
  });

  it('tells this machine\'s own pictures from a run on the same kind of hardware', () => {
    const here = pictureTimeText(option({ time: { seconds: 24.6, basis: 'measuredHere', samples: 5 } }))!;
    expect(here.text).toBe('25 s a picture here');
    expect(here.title).toContain('last 5 pictures');
    const like = pictureTimeText(option({ time: { seconds: 18, basis: 'measured', width: 1024, height: 1024, steps: 20 } }))!;
    expect(like.text).toBe('~18 s a picture');
    expect(like.title).toContain('1024x1024 and 20 steps');
    expect(pictureTimeText(option({ capabilities: ['video'], time: { seconds: 410, basis: 'measuredHere', samples: 3 } }))!.text).toBe('6.8 min a clip here');
  });

  it('counts in seconds, then minutes', () => {
    expect([0.4, 89, 90, 150, 900].map(durationText)).toEqual(['1 s', '89 s', '1.5 min', '2.5 min', '15 min']);
  });

  it('shows it on the pick\'s row in Best for this machine', () => {
    const timed: Recommendations = { ...withPictures, imageTasks: [{ ...withPictures.imageTasks![0], pick: option({ time: { seconds: 31, basis: 'measuredHere', samples: 4 } }) }] };
    const html = renderToStaticMarkup(<RecommendationList recs={timed} models={[]} onDownload={vi.fn()} onRecheck={vi.fn()} />);
    expect(html).toContain('data-picture-time="measuredHere"');
    expect(html).toContain('31 s a picture here');
    expect(renderToStaticMarkup(<RecommendationList recs={withPictures} models={[]} onDownload={vi.fn()} onRecheck={vi.fn()} />)).not.toContain('data-picture-time');
  });
});

describe('the two halves of the Models section', () => {
  const families = groupModelFamilies(
    [local('Ckpt_Q38.gguf', { lastLoadError: 'a tensor is missing', sizeBytes: 3.9 * 1024 ** 3 }), local('Gemma-4-E4B-Q4_K_M.gguf', { loaded: true, parameterSize: '7.5B' })],
    [catalog('unsloth/Qwen3-8B-GGUF', { parameterSize: '8B', quants: [{ label: 'Q4_K_M', file: 'a.gguf', sizeBytes: 5 * 1024 ** 3 }, { label: 'Q8_0', file: 'b.gguf', sizeBytes: 9 * 1024 ** 3 }] })],
  );

  it('lists what is on disk in one, and what can be downloaded in the other', () => {
    expect(familiesFor('installed', families).map(f => f.name)).toEqual(['Ckpt', 'Gemma-4-E4B']);
    expect(familiesFor('find', families).map(f => f.name)).toEqual(['Qwen3-8B']);
  });

  it('puts a failed load on the row instead of its size, in the danger colour', () => {
    const ckpt = families.find(f => f.name === 'Ckpt')!;
    expect(familyLine(ckpt, 'installed', undefined)).toEqual({ text: 'Last load failed', tone: 'danger', title: 'a tensor is missing' });
  });

  it('shows the engine’s verdict on the row, with no GPU fit beside it', () => {
    const blocked = { level: 'blocked' as const, reason: 'Needs a modified build of llama.cpp.' };
    const repo = { sourceRepo: 'prism-ml/Ternary-Bonsai-2-27B-gguf' };
    const bonsai = (files: LibraryModel[]) => groupModelFamilies(files, [])[0];
    const ptq1 = local('Ternary-Bonsai-2-27B-PTQ1_0.gguf', { sizeBytes: 5.9 * 1024 ** 3, loadCheck: blocked, ...repo });
    const q2 = local('Ternary-Bonsai-2-27B-Q2_0.gguf', { sizeBytes: 7.6 * 1024 ** 3, gpuFit: 'full', ...repo });
    // Only the build the engine refuses: the row says so, in the engine's words.
    expect(familyLine(bonsai([ptq1]), 'installed', undefined)).toEqual({ text: "Can't run here", tone: 'warning', title: blocked.reason });
    // Beside one it can run, the row speaks for that one and shows its fit.
    expect(familyLine(bonsai([ptq1, q2]), 'installed', undefined).text).toMatch(/^27B · 2 variants, .+ · Fits on GPU$/);
    // A warning is the engine's to settle: the row says it may not run.
    const warned = local('Ternary-Bonsai-2-27B-PTQ1_0.gguf', { loadCheck: { level: 'warning', reason: 'It may not load.' }, ...repo });
    expect(familyLine(bonsai([warned]), 'installed', undefined)).toEqual({ text: 'May not run here', tone: 'warning', title: 'It may not load.' });
  });

  it('says the parameters, size and state of a healthy row, and the quant range of a downloadable one', () => {
    const gemma = families.find(f => f.name === 'Gemma-4-E4B')!;
    expect(familyLine(gemma, 'installed', undefined).text).toMatch(/^4B effective · .+ · in memory$/);
    const qwen = families.find(f => f.name === 'Qwen3-8B')!;
    expect(familyLine(qwen, 'find', { budgetBytes: 30 * 1024 ** 3, kind: 'vram' }).text).toBe('8B · 2 quants, 5.0 GB to 9.0 GB · smallest fits on GPU (estimated)');
  });
});
