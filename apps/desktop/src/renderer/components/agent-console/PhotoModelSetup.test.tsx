import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadJob, ImageCompanionStatus, ImageRecommendedOption, ImageTaskRecommendation, LocalModel, Recommendations } from '@nekko-agent/shared';
import { PhotoSetupSteps, photoCards, photoFitLine, photoSetupPhase, type PhotoSetupPhase } from './PhotoModelSetup.js';

const option = (o: Partial<ImageRecommendedOption>): ImageRecommendedOption => ({
  modelId: 'z-image-turbo', name: 'Z-Image Turbo', owner: 'Tongyi-MAI', repo: 'leejet/Z-Image-Turbo-GGUF', license: 'Apache-2.0',
  capabilities: ['create'], companionSet: 'z-image', quant: 'Q4_K', downloadLabel: 'Q4_K', files: ['z_image_turbo-Q4_K.gguf'],
  weightsBytes: 3.86e9, companionBytes: 2.83e9, downloadBytes: 6.69e9, memoryBytes: 6e9, headroomBytes: 1e9,
  placement: 'gpu', offloadToCpu: false, fit: 'fits', ...o,
});
const zImage = option({});
const klein = option({ modelId: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', repo: 'leejet/FLUX.2-klein-4B-GGUF', capabilities: ['create', 'edit'], companionSet: 'flux2-klein-4b', quant: 'Q4_0', downloadLabel: 'Q4_0', files: ['flux-2-klein-4b-Q4_0.gguf'], downloadBytes: 5.3e9 });
const qwen = option({ modelId: 'qwen-image', name: 'Qwen Image', repo: 'QuantStack/Qwen-Image-GGUF', companionSet: 'qwen-image', quant: 'Q4_K_M', downloadLabel: 'Q4_K_M', files: ['Qwen_Image-Q4_K_M.gguf'], downloadBytes: 18e9, fit: 'tooBig' });
const task: ImageTaskRecommendation = { task: 'imageCreate', label: 'Create pictures', capability: 'create', pick: zImage, options: [qwen, zImage, klein] };
const recs = { hardware: { device: 'NVIDIA GeForce RTX 4060', classId: null, bandwidthGBps: null, backend: 'vulkan', memoryBytes: 8e9 } } as unknown as Recommendations;

const job = (j: Partial<DownloadJob>): DownloadJob => ({ id: 'j', kind: 'model', label: 'x', target: 'x', state: 'downloading', receivedBytes: 0, startedAt: 0, ...j });
const onDisk = (file: string, extra: Partial<LocalModel> = {}): LocalModel => ({ id: `image/leejet_Z-Image-Turbo-GGUF/${file}`, name: 'z', path: `/models/image/leejet_Z-Image-Turbo-GGUF/${file}`, sizeBytes: 1, addedAt: 0, modality: 'image', ...extra } as LocalModel);
const ready = (r: boolean): ImageCompanionStatus => ({ setId: 'z-image', label: 'Z-Image', files: [], ready: r, missingBytes: r ? 0 : 1, defaults: { steps: 8, cfgScale: 1 }, capabilities: ['create'] });
const phase = (p: Partial<Parameters<typeof photoSetupPhase>[0]>) => photoSetupPhase({ jobs: [], models: [], options: task.options, companions: null, ...p });

describe('where the Photo setup is', () => {
  it('offers the choice when there is no picture model', () => {
    expect(phase({}).kind).toBe('choose');
    // A chat model on disk is not a picture model.
    expect(phase({ models: [{ ...onDisk('chat.gguf'), modality: 'chat' }] }).kind).toBe('choose');
  });

  it('stays out of the way of someone with picture models of their own', () => {
    expect(phase({ models: [onDisk('my-own-sdxl.gguf')] }).kind).toBe('hidden');
  });

  it('follows the engine, then the weights, then the supporting files', () => {
    expect(phase({ jobs: [job({ kind: 'engine', id: 'e' })] })).toMatchObject({ kind: 'working', step: 'engine' });
    expect(phase({ jobs: [job({ dest: '/m/image/x/z_image_turbo-Q4_K.gguf', group: 'g' })] })).toMatchObject({ kind: 'working', step: 'model' });
    expect(phase({ jobs: [job({ id: 'image-companions:vae', group: 'image-companions:m' })] })).toMatchObject({ kind: 'working', step: 'files' });
    // Someone else's download is not this setup's.
    expect(phase({ jobs: [job({ dest: '/m/chat/x/qwen3.5-9b-Q4_K_M.gguf' })] }).kind).toBe('choose');
  });

  it('fetches the supporting files once the weights land, then hands the model to the chat', () => {
    const m = onDisk('z_image_turbo-Q4_K.gguf');
    expect(phase({ models: [m], companions: undefined })).toMatchObject({ kind: 'working', step: 'files' });
    expect(phase({ models: [m], companions: ready(false) })).toMatchObject({ kind: 'needsFiles', model: m, option: zImage });
    expect(phase({ models: [m], companions: ready(true) })).toMatchObject({ kind: 'finish', model: m, option: zImage });
    expect(phase({ models: [m], companions: ready(true), chatModelId: m.id }).kind).toBe('hidden');
  });

  it('says when a download stopped', () => {
    const m = onDisk('z_image_turbo-Q4_K.gguf');
    const failedFiles = job({ id: 'image-companions:vae', group: `image-companions:${m.id}`, state: 'failed', message: 'Network lost.' });
    expect(phase({ models: [m], companions: ready(false), jobs: [failedFiles] })).toEqual({ kind: 'failed', message: 'Network lost.' });
    const failedWeights = job({ dest: '/m/z_image_turbo-Q4_K.gguf', state: 'failed', message: 'Disk full.' });
    expect(phase({ jobs: [failedWeights] })).toEqual({ kind: 'failed', message: 'Disk full.' });
  });
});

describe('the fit in words', () => {
  it('never promises speed, and says when offloading or the processor makes it slower', () => {
    expect(photoFitLine(zImage, recs)).toBe('Fits your NVIDIA GeForce RTX 4060.');
    expect(photoFitLine({ ...zImage, fit: 'tight' }, recs)).toContain('little room to spare');
    expect(photoFitLine({ ...zImage, offloadToCpu: true }, recs)).toContain('pictures take longer');
    expect(photoFitLine({ ...zImage, placement: 'cpu' }, recs)).toContain('processor');
    expect(photoFitLine(qwen, recs)).toBe('Too large for this computer.');
    for (const o of [zImage, klein, qwen]) expect(photoFitLine(o, recs)).not.toMatch(/runs well|fast/i);
  });

  it('puts the pick first and offers at most three', () => {
    expect(photoCards(task).map((c) => c.modelId)).toEqual(['z-image-turbo', 'qwen-image', 'flux2-klein-4b']);
    expect(photoCards({ ...task, options: [qwen, zImage, klein, { ...klein, modelId: 'extra' }] })).toHaveLength(3);
  });
});

describe('the Photo setup screen', () => {
  const render = (p: PhotoSetupPhase, engineReady = false, cards = photoCards(task)) =>
    renderToStaticMarkup(
      <PhotoSetupSteps recs={recs} cards={cards} choice={cards.find((c) => c.fit !== 'tooBig')} phase={p} engineReady={engineReady} canInstallEngine
        onChoose={vi.fn()} onSetUp={vi.fn()} onCancel={vi.fn()} onShowAll={vi.fn()} />,
    );

  it('shows each model in plain words, with the one too large disabled', () => {
    const html = render({ kind: 'choose' });
    expect(html).toContain('Choose a picture model');
    expect(html).toContain('Z-Image Turbo');
    expect(html).toContain('Download and set up');
    expect(html).toContain('plus the free engine that makes pictures');
    expect(html).toContain('See all picture models');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-photo-model="qwen-image"/);
    for (const jargon of ['Q4_K', 'GGUF', 'VAE', 'CFG', 'quant', 'runtime']) expect(html).not.toContain(jargon);
  });

  it('does not mention the engine once it is installed', () => {
    expect(render({ kind: 'choose' }, true)).not.toContain('engine');
  });

  it('says so when nothing fits, and points to the full list', () => {
    const html = render({ kind: 'choose' }, true, [qwen]);
    expect(html).toContain('None of the recommended picture models fits this computer');
    expect(html).not.toContain('Download and set up');
  });

  it('shows the download as steps with progress and a way to cancel', () => {
    const p = photoSetupPhase({
      jobs: [job({ dest: '/m/z_image_turbo-Q4_K.gguf', group: 'g', groupLabel: 'Z-Image Turbo · Q4_K', receivedBytes: 1e9, totalBytes: 4e9 })],
      models: [], options: task.options, companions: null,
    });
    const html = render(p, true);
    expect(html).toContain('Setting up a picture model');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('Download its supporting files');
    expect(html).toContain('Cancel');
  });
});
