import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ImageRecommendedOption, Recommendations } from '@nekko-agent/shared';
import { familyKind, groupModelFamilies, type LibraryModel } from './modelFamilies.js';
import { KIND_FILTERS, kindNote } from './ModelsHome.js';
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
    const html = renderToStaticMarkup(<RecommendationList recs={withPictures} models={[{ path: '/m/flux-2-klein-4b-Q4_0.gguf' }]} open onDownload={vi.fn()} onRecheck={vi.fn()} />);
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
