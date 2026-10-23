import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Recommendations } from '@nekko-agent/shared';
import { RecommendationList } from './RecommendedModels.js';
import { hardwareText, isDownloaded, speedText } from './recommendationText.js';
// What the daemon answers for four reference machines (`machine:recommendations`
// over the bundled feed), with each task's alternatives left out.
import fixture from './recommendations.fixture.json';

const recs = fixture as unknown as Record<'m5max' | 'rtx4060' | 'cpu' | 'laptop', Recommendations>;
const list = (r: Recommendations, models: { path: string }[] = [], open = true) =>
  renderToStaticMarkup(<RecommendationList recs={r} models={models} open={open} onDownload={vi.fn()} onRecheck={vi.fn()} />);
const task = (r: Recommendations, id: string) => r.tasks.find(t => t.task === id)!;

describe('the recommendations block', () => {
  it('offers a download per task, with memory, size and speed', () => {
    const html = list(recs.m5max);
    expect(html).toContain('Best for this machine');
    expect(html).toContain('Apple M5 Max (40-core GPU) · Metal · 96.0 GB of unified memory for models');
    for (const t of ['chat', 'code', 'router', 'embedding', 'vision']) expect(html).toContain(`data-recommendation="${t}"`);
    expect(html.match(/>Download</g)).toHaveLength(5);
    expect(html).toContain('Qwen3 Coder Next');
    expect(html).toContain('46.5 GB of 96.0 GB');
    expect(html).toContain('~117 tok/s');
    expect(html).toContain('<details');
    expect(html).toContain(' open=""');
  });

  it('marks what is already on disk instead of offering it again', () => {
    const chat = task(recs.m5max, 'chat').pick!;
    const html = list(recs.m5max, [{ path: `/Users/me/.nekko-agent/models/chat/unsloth/Qwen3.8-27B-GGUF/${chat.files[0]}` }], false);
    expect(html).toContain('Downloaded');
    expect(html.match(/>Download</g)).toHaveLength(4);
    expect(html).not.toContain(' open=""');
  });

  it('says when a speed is rough, and when nothing is fast enough', () => {
    const html = list(recs.cpu);
    expect(html).toContain('No GPU found · CPU only · 12.0 GB of RAM for models');
    expect(html).toContain('tok/s, rough');
    expect(html).toContain('data-speed-basis="estimatedBorrowed"');
    expect(html).toContain('Slower than the 25 tok/s this task wants');
  });

  it('guesses no speed for a GPU the table does not know', () => {
    const r = recs.laptop;
    expect(r.hardware.classId).toBeNull();
    const chat = task(r, 'chat');
    expect(speedText(chat.pick!, chat, r.hardware)?.text).toBe('speed unknown');
    expect(list(r)).not.toMatch(/\d tok\/s/);
  });

  it('shows embeddings without a decode speed', () => {
    const e = task(recs.rtx4060, 'embedding');
    expect(speedText(e.pick!, e, recs.rtx4060.hardware)).toBeNull();
    expect(hardwareText(recs.rtx4060)).toBe('NVIDIA GeForce RTX 4060 · Vulkan · 7.0 GB of GPU memory for models');
  });

  it("says when a speed is this machine's own", () => {
    const r = structuredClone(recs.m5max);
    const code = r.tasks.find(t => t.task === 'code')!;
    code.pick!.speed = { tokensPerSecond: 98.4, basis: 'measuredHere', samples: 12 };
    expect(speedText(code.pick!, code, r.hardware)).toEqual({ text: '98 tok/s here', title: 'The median of your last 12 replies with this file on this machine.' });
    expect(list(r)).toContain('data-speed-basis="measuredHere"');
  });

  it('matches a downloaded model by its weights file, whatever the folder', () => {
    const p = task(recs.m5max, 'code').pick!;
    expect(isDownloaded(p, [{ path: `D:\\models\\${p.files[0]}` }])).toBe(true);
    expect(isDownloaded(p, [{ path: '/m/other-Q4_K_M.gguf' }])).toBe(false);
  });
});
