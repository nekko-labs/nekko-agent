import { describe, expect, it } from 'vitest';
import { checkPhoneAccess, phoneChannelAllowed, phoneChannelClass, redactPhoneResult, screenPhoneCall } from './phone-access.js';
import { phoneImageModels, phoneImageParamsProblem, phoneImageRequestProblem } from './phone-access-image.js';

const params = { modelId: 'image/acme_sd/tiny-sd', width: 1024, height: 1024, steps: 28, cfgScale: 4, seed: -1 };
const request = { sessionId: 's_img', prompt: 'a calico cat', params };

describe('approved phone image boundary #2162', () => {
  it('opens only read-class model discovery and signed Change-class generation', () => {
    expect(phoneChannelClass('engine:models')).toBe('read');
    expect(phoneChannelClass('chat:generateImage')).toBe('change');
    expect(() => checkPhoneAccess('engine:models', { read: false, change: true })).toThrow('read-off');
    expect(() => checkPhoneAccess('chat:generateImage', { read: true, change: false })).toThrow('change-off');
    for (const c of ['engine:install', 'engine:removeModel', 'engine:downloadModel', 'engine:generateImage', 'image:fetch', 'file:read']) {
      expect(phoneChannelAllowed(c), c).toBe(false);
    }
  });

  it('accepts exactly one generation object, not cloud providers, paths, uploads or runtime overrides', () => {
    expect(() => screenPhoneCall('chat:generateImage', [request])).not.toThrow();
    for (const key of ['providerId', 'images', 'attachedPaths', 'url', 'outputPath', 'preset']) {
      expect(phoneImageRequestProblem({ ...request, [key]: 'secret' })).toBe(key);
      expect(phoneImageParamsProblem({ ...params, [key]: 'secret' }, true)).toBe(key);
    }
    for (const args of [[], [request, {}], [null], [{ ...request, params: null }], [{ ...request, params: {} }]]) {
      expect(() => screenPhoneCall('chat:generateImage', args)).toThrow();
    }
    expect(() => screenPhoneCall('engine:models', [{}])).toThrow();
    for (const id of ['/private/image.gguf', 'C:\\models\\sd.gguf', '../image', 'https://model', '-flag', 'a/../b', '']) {
      expect(phoneImageParamsProblem({ modelId: id }, true)).toBe('modelId');
    }
    for (const prompt of ['', '  ', 'x'.repeat(8001)]) expect(phoneImageRequestProblem({ ...request, prompt })).toBe('prompt');
    for (const sessionId of ['', '../s', 's'.repeat(129)]) expect(phoneImageRequestProblem({ ...request, sessionId })).toBe('sessionId');
  });

  it('bounds whole-number parameters, including CFG, without rounding saved fractional values', () => {
    for (const [key, bad] of Object.entries({ width: [255, 257, 2112, '512'], height: [255, 257, 2112], steps: [0, 101, 1.5], cfgScale: [-1, 31, 4.5], seed: [-2, 2147483648, 1.5] })) {
      for (const value of bad) expect(phoneImageParamsProblem({ ...params, [key]: value }, true), `${key}=${value}`).toBe(key);
    }
    for (const cfgScale of [0, 4, 30]) expect(phoneImageParamsProblem({ ...params, cfgScale }, true)).toBeNull();
    for (const key of ['width', 'height', 'steps', 'cfgScale', 'seed']) {
      for (const value of [null, true, NaN, Infinity]) expect(phoneImageParamsProblem({ ...params, [key]: value }, true)).toBe(key);
    }
    expect(() => screenPhoneCall('session:setOptions', ['s_img', { chatType: 'image', imageParams: params }])).not.toThrow();
    expect(() => screenPhoneCall('session:setOptions', ['s_img', { chatType: 'video' }])).toThrow();
    expect(() => screenPhoneCall('session:setOptions', ['s_img', { imageParams: { cfgScale: 4.5 } }])).toThrow();
    expect(() => screenPhoneCall('session:setOptions', ['s_img', { imageParams: { outputPath: '/secret' } }])).toThrow();
    expect(() => screenPhoneCall('session:setOptions', ['s_img', { arbitrary: true }])).toThrow();
  });

  it('projects real engine rows, omitting incompatible formats, paths, errors, presets and hardware', () => {
    const rows = [
      { id: params.modelId, name: 'Tiny SD', modality: 'image', loaded: true, path: 'C:/secret', file: '/private', preset: { vae: '/private' }, lastLoadError: '/secret error' },
      { id: 'image/sd2', name: '/secret/name', modality: 'image', lastLoadError: 'failed at /private/file' },
      { id: 'chat/model', modality: 'chat' }, { id: 'mlx/image', modality: 'image', format: 'mlx' },
      { id: '/private/model', modality: 'image' }, { id: 'https://model', modality: 'image' },
    ];
    const expected = [
      { id: params.modelId, name: 'Tiny SD', kind: 'image', format: 'gguf', state: 'loaded' },
      { id: 'image/sd2', name: 'image/sd2', kind: 'image', format: 'gguf', state: 'error' },
    ];
    expect(phoneImageModels(rows)).toEqual(expected);
    expect(redactPhoneResult('engine:models', rows)).toEqual(expected);
    expect(redactPhoneResult('engine:models', null)).toEqual([]);
    expect(redactPhoneResult('chat:generateImage', { path: '/secret', images: ['huge'] })).toBeNull();
  });
});
