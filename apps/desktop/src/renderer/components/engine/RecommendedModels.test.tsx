import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Recommendations } from '@nekko-agent/shared';
import { RecommendationList, UpgradeNudges, feedText } from './RecommendedModels.js';
import { hardwareText, isDownloaded, nudgeTitle, speedText } from './recommendationText.js';
// What the daemon answers for four reference machines (`machine:recommendations`
// over the bundled feed), with each task's alternatives left out.
import fixture from './recommendations.fixture.json';

const recs = fixture as unknown as Record<'m5max' | 'rtx4060' | 'cpu' | 'laptop' | 'rtx4080upgrade', Recommendations>;
const list = (r: Recommendations, models: { path: string }[] = []) =>
  renderToStaticMarkup(<RecommendationList recs={r} models={models} onDownload={vi.fn()} onRecheck={vi.fn()} />);
const task = (r: Recommendations, id: string) => r.tasks.find(t => t.task === id)!;

describe('the recommendations block', () => {
  it('offers a download per task, with memory, size and speed', () => {
    const html = list(recs.m5max);
    expect(html).toContain('Best for this machine');
    expect(html).toContain('Apple M5 Max (40-core GPU) · Metal · 96.0 GB of unified memory for models');
    for (const t of ['chat', 'code', 'router', 'embedding', 'vision']) expect(html).toContain(`data-recommendation="${t}"`);
    expect(html.match(/>Download</g)).toHaveLength(5);
    expect(html).toContain('Qwen3 Coder Next');
    expect(html).toContain('46.5 GB</span> of 96.0 GB at 32k context');
    expect(html).toContain('~117 tok/s');
    // Open, not folded behind a summary: it leads Find new models.
    expect(html).not.toContain('<details');
  });

  it('says the parameters, the memory split and the context that fits', () => {
    const html = list(recs.rtx4060);
    expect(html).toContain('9B parameters · Q4_K_M');
    expect(html.match(/role="meter"/g)?.length).toBeGreaterThanOrEqual(5);
    const chat = task(recs.rtx4060, 'chat').pick!;
    expect(chat.fitContextTokens).toBeGreaterThanOrEqual(chat.contextTokens);
    expect(html).toMatch(/data-context-fit="true">Context: (Up to \d+k|All of it) fits in this GPU · \d+k max/);
    expect(html).toContain('weights');
    expect(html).toContain('context and working memory');
  });

  it('keeps every quant behind Quants, with what each needs', () => {
    const html = list(recs.rtx4060);
    expect(html).toContain('data-quants-toggle');
    expect(html).toContain('aria-expanded="false"');
    // Closed: the table mounts on open.
    expect(html).not.toContain('data-quant-table');
    const chat = task(recs.rtx4060, 'chat').pick!;
    expect(chat.quants?.some(q => q.quant === chat.quant)).toBe(true);
    const bigger = chat.quants!.filter(q => q.downloadBytes > chat.downloadBytes);
    for (const q of bigger) expect(q.fitContextTokens).toBeLessThanOrEqual(chat.fitContextTokens!);
  });

  it('marks what is already on disk instead of offering it again', () => {
    const chat = task(recs.m5max, 'chat').pick!;
    const html = list(recs.m5max, [{ path: `/Users/me/.nekko-agent/models/chat/unsloth/Qwen3.8-27B-GGUF/${chat.files[0]}` }]);
    expect(html).toContain('Downloaded');
    expect(html.match(/>Download</g)).toHaveLength(4);
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

  it('names an upgrade to a new GPU, with the model each pick replaces', () => {
    const r = recs.rtx4080upgrade;
    expect(nudgeTitle(r)).toBe('Better models now fit your 16 GB GPU');
    const html = renderToStaticMarkup(<UpgradeNudges recs={r} onDownload={vi.fn()} onDismiss={vi.fn()} />);
    for (const t of ['chat', 'code', 'vision']) expect(html).toContain(`data-upgrade-nudge="${t}"`);
    expect(html).toContain('instead of Qwen3.5 4B');
    expect(html).toContain('Not now');
    const one = { ...r, nudges: r.nudges.filter(n => n.task === 'code') };
    expect(nudgeTitle(one)).toBe('A better coding model now fits your 16 GB GPU');
    expect(nudgeTitle({ ...one, nudges: [{ ...one.nudges[0], reason: 'feed' }] })).toBe("A better coding model is in this version's list for your 16 GB GPU");
  });

  it('says nothing without an upgrade', () => {
    expect(renderToStaticMarkup(<UpgradeNudges recs={recs.m5max} onDownload={vi.fn()} onDismiss={vi.fn()} />)).toBe('');
  });
});

describe('where the model list came from', () => {
  it('says when it is newer than the one this version shipped', () => {
    expect(feedText({ feedVersion: '2026-10-22.1' })).toBe('From the model list shipped with this version (2026-10-22.1).');
    expect(feedText({ feedVersion: '2026-10-22.1', feedSource: 'bundled' })).toContain('shipped with this version');
    expect(feedText({ feedVersion: '2026-12-01.2', feedSource: 'update' })).toBe('From an updated model list (2026-12-01.2), newer than the one this version shipped.');
  });
});
