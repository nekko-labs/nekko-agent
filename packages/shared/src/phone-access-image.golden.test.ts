import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { phoneImageModels, phoneImageParamsProblem, phoneImageRequestProblem } from './phone-access-image.js';

it('records image boundary decisions for Rust parity', () => {
  const base = { sessionId: 's_img', prompt: 'cat', params: { modelId: 'image/acme/sd', width: 512, height: 768, steps: 28, cfgScale: 4, seed: -1 } };
  const requests: unknown[] = [base, null, {}, { ...base, extra: true }, { ...base, providerId: 'cloud' },
    { ...base, sessionId: '../secret' }, { ...base, prompt: '\ufeff \n' }, { ...base, prompt: '🐈'.repeat(4001) },
    { ...base, params: {} }, { ...base, params: { ...base.params, modelId: '/secret/model' } },
    { ...base, params: { ...base.params, modelId: '\ufeffimage/sd' } },
    { ...base, params: { ...base.params, modelId: 'image/sd\u0085' } },
    { ...base, params: { ...base.params, vae: '/secret' } }];
  for (const [key, values] of Object.entries({ width: [256, 2048, 255, 257, 2112], height: [256, 2048, 257],
    steps: [1, 100, 0, 101, 1.5], cfgScale: [0, 30, -1, 31, 4.5], seed: [-1, 0, 2147483647, -2, 2147483648] })) {
    for (const value of [...values, null, true, '4']) requests.push({ ...base, params: { ...base.params, [key]: value } });
  }
  for (const key of ['width', 'height', 'steps', 'cfgScale', 'seed']) {
    const partial: Record<string, unknown> = { ...base.params };
    delete partial[key];
    requests.push({ ...base, params: partial });
  }
  const params: unknown[] = [{}, { cfgScale: 4 }, { cfgScale: 4.5 }, null, [], { modelId: null }, { modelId: 'C:\\models\\sd' }, { modelId: '../sd' }, { outputPath: '/secret' }];
  const rows = [{ id: 'image/sd', name: 'SD', modality: 'image', loaded: true, path: '/secret', preset: { vae: '/secret' } },
    { id: 'image/error', name: 'checkpoint at /private/name', modality: 'image', lastLoadError: '/secret error' },
    { id: 'vision', modality: 'vision' }, { id: 'mlx/sd', modality: 'image', format: 'mlx' }, { id: '/private/sd', modality: 'image' }];
  const recorded = {
    requests: requests.map((input) => ({ input, problem: phoneImageRequestProblem(input) })),
    params: params.map((input) => ({ input, problem: phoneImageParamsProblem(input, false) })),
    models: { input: rows, output: phoneImageModels(rows) },
  };
  const path = join(__dirname, '../../../crates/nekko-remote/tests/golden/phone-image.json');
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(recorded, null, 1)}\n`);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(recorded);
});
