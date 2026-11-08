import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./rowState.js', () => ({ useRowState: (_key: string, value: unknown) => [value, vi.fn()] }));
vi.mock('./ToolCard.js', () => ({ ToolCard: () => <div>Tool</div> }));
import type { ImageCompanionStatus, ImageRecommendedOption, LocalModel, Recommendations } from '@nekko-agent/shared';
import { MAX_PHOTO_EDGE, editSize, fitWithin, photoFiles } from './photoEdit.js';
import { EditableList, editableModels } from './EditModelOffer.js';
import { PhotoSetupSteps, photoSetupPhase } from './PhotoModelSetup.js';
import { MessageBubble } from './MessageBubble.js';

describe('photos to edit', () => {
  it('scales a big photo down to the longest side the engine is given, never up', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: MAX_PHOTO_EDGE, height: 1152 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1152, height: MAX_PHOTO_EDGE });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("makes the edit in the photo's shape at about the chat's pixel count, in multiples of 64", () => {
    const chosen = { width: 1024, height: 1024 };
    expect(editSize({ width: 3024, height: 4032 }, chosen)).toEqual({ width: 896, height: 1152 });
    expect(editSize({ width: 1920, height: 1080 }, chosen)).toEqual({ width: 1344, height: 768 });
    expect(editSize({ width: 500, height: 500 }, chosen)).toEqual(chosen);
    // Extreme shapes stay within what the engine accepts.
    const banner = editSize({ width: 10000, height: 100 }, chosen);
    expect(banner).toEqual({ width: 2048, height: 256 });
    expect(editSize({ width: 0, height: 0 }, chosen)).toBe(chosen);
  });

  it('takes PNG, JPEG and WebP only', () => {
    const f = (type: string) => new File(['x'], `a.${type.split('/')[1]}`, { type });
    expect(photoFiles([f('image/png'), f('image/jpeg'), f('image/webp'), f('image/gif'), f('application/pdf')]).map((x) => x.type))
      .toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});

const status = (o: Partial<ImageCompanionStatus>): ImageCompanionStatus => ({ setId: 's', label: 'Model', files: [], ready: true, missingBytes: 0, defaults: { steps: 4, cfgScale: 1 }, capabilities: ['create'], ...o });
const model = (id: string, modality: LocalModel['modality'] = 'image'): LocalModel => ({ id, name: id, path: `/m/${id}.gguf`, sizeBytes: 1, addedAt: 0, modality } as LocalModel);

describe('offering a model that edits', () => {
  it('finds the picture models on disk that can edit', () => {
    const found = editableModels(
      [model('z-image'), model('klein'), model('qwen-edit'), model('chat', 'chat'), model('unknown-sd')],
      {
        'z-image': status({ label: 'Z-Image', capabilities: ['create'] }),
        klein: status({ label: 'FLUX.2 klein 4B', capabilities: ['create', 'edit'] }),
        'qwen-edit': status({ label: 'Qwen Image Edit', capabilities: ['edit'], ready: false }),
        'unknown-sd': null,
      },
    );
    expect(found.map((e) => e.model.id)).toEqual(['klein', 'qwen-edit']);
    const html = renderToStaticMarkup(<EditableList editable={found} onUse={vi.fn()} />);
    expect(html).toContain('Use FLUX.2 klein 4B');
    expect(html).toContain('also makes new pictures');
    expect(html).toContain('edits only');
    expect(html).toContain('its supporting files download first');
  });

  const option = (o: Partial<ImageRecommendedOption>): ImageRecommendedOption => ({
    modelId: 'qwen-image-edit-2511', name: 'Qwen Image Edit 2511', owner: 'Qwen', repo: 'unsloth/Qwen-Image-Edit-2511-GGUF', license: 'Apache-2.0',
    capabilities: ['edit'], companionSet: 'qwen-image-edit', quant: 'Q4_K_M', downloadLabel: 'Q4_K_M', files: ['qwen-image-edit-2511-Q4_K_M.gguf'],
    weightsBytes: 12.8e9, companionBytes: 5.8e9, downloadBytes: 18.6e9, memoryBytes: 20.8e9, headroomBytes: 10e9, placement: 'gpu', offloadToCpu: false, fit: 'fits', ...o,
  });

  it('offers the Edit photos picks even to someone with picture models that cannot edit', () => {
    const options = [option({})];
    const own = [model('z_image_turbo-Q4_K')];
    expect(photoSetupPhase({ jobs: [], models: own, options, companions: null, runtimeReady: true }).kind).toBe('hidden');
    expect(photoSetupPhase({ jobs: [], models: own, options, companions: null, force: true, runtimeReady: true }).kind).toBe('choose');
    const recs = { hardware: { device: 'NVIDIA GeForce RTX 5090' } } as unknown as Recommendations;
    const html = renderToStaticMarkup(
      <PhotoSetupSteps recs={recs} cards={options} choice={options[0]} phase={{ kind: 'choose' }} engineReady canInstallEngine capability="edit"
        onChoose={vi.fn()} onSetUp={vi.fn()} onCancel={vi.fn()} onShowAll={vi.fn()} />,
    );
    expect(html).toContain('Choose a model that edits photos');
    expect(html).toContain('your photos stay here');
    expect(html).toContain('Qwen Image Edit 2511');
  });
});

describe('Edit on a generated picture', () => {
  const generated = {
    id: 'a', role: 'assistant' as const, content: '', createdAt: 1, images: ['data:image/png;base64,AAAA'],
    generated: { modelId: 'image/x/z_image_turbo-Q4_K', width: 1024, height: 1024, steps: 8, cfgScale: 1, seed: 1, ms: 9000 },
  };
  it('puts an Edit button under each generated picture in a Photo chat', () => {
    const onEditImage = vi.fn();
    const html = renderToStaticMarkup(<MessageBubble message={generated} chronological onEditImage={onEditImage} />);
    expect(html.match(/data-edit-image/g)).toHaveLength(1);
    expect(html).toContain('>Edit<');
  });
  it('shows none without the handler, or on a photo the user sent', () => {
    expect(renderToStaticMarkup(<MessageBubble message={generated} chronological />)).not.toContain('data-edit-image');
    const sent = { id: 'u', role: 'user' as const, content: 'make it orange', createdAt: 1, images: ['data:image/png;base64,AAAA'] };
    expect(renderToStaticMarkup(<MessageBubble message={sent} chronological onEditImage={vi.fn()} />)).not.toContain('data-edit-image');
  });
});

describe('a clip from a video model', () => {
  const clip = {
    id: 'c', role: 'assistant' as const, content: '', createdAt: 1, images: ['data:image/webp;base64,UklGR'],
    generated: { modelId: 'image/QuantStack_Wan2.2-TI2V-5B-GGUF/Wan2.2-TI2V-5B-Q4_K_M', width: 832, height: 480, steps: 20, cfgScale: 6, seed: 5, ms: 61000, video: { frames: 33, fps: 16 } },
  };
  it('plays as an animated picture, says how long it is, and offers no Edit', () => {
    const html = renderToStaticMarkup(<MessageBubble message={clip} chronological onEditImage={vi.fn()} />);
    expect(html).toContain('Generated clip, 832×480');
    expect(html).toContain('33 frames at 16 fps (2.1 s clip)');
    expect(html).not.toContain('data-edit-image');
  });
});
