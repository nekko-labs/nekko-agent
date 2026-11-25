import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LoadParams, LocalModel, PlacementPlan } from '@nekko-agent/shared';
import { EngineLoadDrawer } from './EngineLoadDrawer.js';
import { ImageGeneration } from './ImageGeneration.js';
import { LoadMemoryMeter } from './LoadMemoryMeter.js';
import { loadMemoryEstimate, pollLoadMemory } from './loadMemory.js';
import { toPlacementRequest } from './loadSettings.js';

const GiB = 1024 ** 3;
const model: LocalModel = { id: 'chat', name: 'Chat', path: '/models/chat.gguf', sizeBytes: 6 * GiB, addedAt: 0, layers: 32 };
const hermes: LocalModel = { ...model, id: 'hermes', name: 'Hermes MLX', path: '/models/hermes', format: 'mlx', mlxRunnable: true, layers: undefined, maxContext: 131072 };
const image: LocalModel = { ...model, id: 'qwen-image', name: 'Qwen Image', modality: 'image', sizeBytes: 11 * GiB };

function placement(): PlacementPlan {
  return {
    verdict: 'fits', unified: false, deviceName: 'Card B', spareVramBytes: GiB,
    vram: { totalBytes: 16 * GiB, otherBytes: 9 * GiB, availBytes: 7 * GiB,
      model: { weightsBytes: 4 * GiB, kvCacheBytes: GiB, overheadBytes: GiB, pinnedBytes: 0 } },
    ram: { totalBytes: 32 * GiB, otherBytes: 15 * GiB, availBytes: 15 * GiB,
      model: { weightsBytes: 2 * GiB, kvCacheBytes: 0, overheadBytes: 0, pinnedBytes: 4 * GiB } },
    disk: { tableBytes: GiB, overflowBytes: 0 },
  };
}

function incomplete(): PlacementPlan {
  const plan = placement();
  const empty = { weightsBytes: 0, kvCacheBytes: 0, overheadBytes: 0, pinnedBytes: 0 };
  return { ...plan, verdict: 'unknown', reason: 'missing-metadata', unified: true,
    vram: { ...plan.vram, model: { ...empty } }, ram: { ...plan.ram, model: { ...empty } }, disk: { tableBytes: 0, overflowBytes: 0 } };
}

// Inspect the actual segment in the primary graph, not a legend or hidden details.
function segmentWidth(html: string, pool: string, segment: string) {
  const primary = html.split('data-meter-configuration')[1]?.split('data-meter-total')[0];
  const bar = primary?.split(`data-meter-bar="${pool}"`)[1]?.split('data-meter-bar=')[0];
  const segmentTag = bar?.match(new RegExp(`<div[^>]*data-segment="${segment}"[^>]*>`))?.[0];
  return Number(segmentTag?.match(/width:([\d.]+)%/)?.[1]);
}

function expectVisibleGraphFirst(html: string) {
  const graph = html.indexOf('data-memory-bar');
  expect(graph).toBeGreaterThan(html.indexOf('data-meter-configuration'));
  expect(graph).toBeLessThan(html.indexOf('data-meter-total'));
  expect(html.slice(0, graph)).not.toContain('<details');
}

describe('primary configuration graph', () => {
  it('grows the primary projected context segment for larger selections without including other usage', () => {
    const draw = (contextTokens: number) => {
      const params: LoadParams = { contextTokens, parallelSlots: 2, mlock: true };
      const request = toPlacementRequest(params, model);
      const plan = placement();
      // A deterministic stand-in for the real planner. Feed it exactly the request the drawer makes.
      plan.vram.model.kvCacheBytes = request.contextTokens * request.sessions * (GiB / 32768);
      return renderToStaticMarkup(<LoadMemoryMeter model={model} plan={plan} params={params} />);
    };
    const before = draw(32768);
    const after = draw(65536);
    expectVisibleGraphFirst(before);
    expectVisibleGraphFirst(after);
    expect(segmentWidth(before, 'vram', 'context')).toBe(6.25);
    expect(segmentWidth(after, 'vram', 'context')).toBe(12.5);
    expect(segmentWidth(after, 'vram', 'weights')).toBe(segmentWidth(before, 'vram', 'weights'));
    expect(before).toMatch(/data-meter-total[^]*?≈ 12\.0 GB/);
    expect(after).toMatch(/data-meter-total[^]*?≈ 13\.0 GB/);
    expect(after).toContain('2 sessions × 32k');
    expect(after).toContain('Pinned copy');
    expect(after).toContain('lookup table (1.0 GB) stays on your SSD');
    expect(after).not.toMatch(/data-segment="other"|Live memory usage|Partial breakdown/);
  });

  it('folds unified allocations into one pool without double counting', () => {
    const plan = { ...placement(), unified: true };
    expect(loadMemoryEstimate(plan, {}, model)).toMatchObject({ totalBytes: 12 * GiB, vramBytes: 12 * GiB, ramBytes: 0 });
    const html = renderToStaticMarkup(<LoadMemoryMeter model={model} plan={plan} />);
    expect(html).toContain('data-meter-bar="vram"');
    expect(html).not.toContain('data-meter-bar="ram"');
  });

  it('retains an on-disk graph and the new selection while waiting for a replanned context', () => {
    const html = renderToStaticMarkup(<LoadMemoryMeter model={model} pending params={{ contextTokens: 65536 }} />);
    expectVisibleGraphFirst(html);
    expect(segmentWidth(html, 'disk', 'weights')).toBe(100);
    expect(html).toMatch(/data-meter-total[^]*?Calculating/);
    expect(html).toContain('Selected context: 64k tokens per session');
    expect(html).not.toContain('data-segment="context"');
  });

  it('keeps the previous configuration graph visible and labels it while a new estimate is in flight', () => {
    const previous = { plan: { ...placement(), unified: true }, params: { contextTokens: 32768 } };
    const html = renderToStaticMarkup(<LoadMemoryMeter model={model} pending previous={previous} params={{ contextTokens: 65536 }} />);
    expectVisibleGraphFirst(html);
    expect(segmentWidth(html, 'vram', 'context')).toBe(6.25);
    expect(html).toContain('Unified memory, previous estimate while updating');
    expect(html).toContain('Selected context: 64k tokens per session');
    expect(html).toMatch(/data-meter-total[^]*?Calculating/);
  });

  it('graphs only known MLX disk weights when cache geometry is missing', () => {
    const plan = incomplete();
    const html = renderToStaticMarkup(<LoadMemoryMeter model={hermes} plan={plan} params={{ contextTokens: 32768 }} />);
    expectVisibleGraphFirst(html);
    expect(segmentWidth(html, 'disk', 'weights')).toBe(100);
    expect(html).toMatch(/data-meter-total[^]*?Unknown/);
    expect(html).toContain('Model weights on disk');
    expect(html).toContain('6.0 GB');
    expect(html).toContain('Selected context: 32k tokens per session');
    expect(html).toContain('Context memory</dt><dd>Unknown');
    expect(html).toContain('Working space</dt><dd>Unknown');
    expect(html).not.toContain('data-segment="context"');
  });

  it('changes the MLX context graph immediately when disk metadata supports the estimate, without claiming a full total', () => {
    const knownGeometry = { ...hermes, mlxKvBytesPerToken: 327680 };
    const draw = (contextTokens: number) => renderToStaticMarkup(<LoadMemoryMeter model={knownGeometry} params={{ contextTokens }} />);
    const before = draw(8192);
    const after = draw(32768);
    expectVisibleGraphFirst(after);
    expect(segmentWidth(before, 'mlx-context', 'context')).toBe(6.25);
    expect(segmentWidth(after, 'mlx-context', 'context')).toBe(25);
    expect(segmentWidth(after, 'disk', 'weights')).toBe(100);
    expect(after).toContain('≈ 10.0 GB');
    expect(after).toMatch(/data-meter-total[^]*?Unknown/);
    expect(after).toContain('Working space</dt><dd>Unknown');
    expect(after).not.toContain('Context memory</dt><dd>Unknown');
  });

  it('retains known allocations from a partial placement without calling them a full total', () => {
    const plan = incomplete();
    plan.vram.model.weightsBytes = 6 * GiB;
    const html = renderToStaticMarkup(<LoadMemoryMeter model={model} plan={plan} />);
    expectVisibleGraphFirst(html);
    expect(segmentWidth(html, 'vram', 'weights')).toBe(37.5);
    expect(html).toMatch(/data-meter-total[^]*?Unknown/);
    expect(html).not.toContain('data-meter-bar="disk"');
  });

  it('shows a Qwen Image disk graph and unknown image memory, never an LLM context', () => {
    const html = renderToStaticMarkup(<ImageGeneration model={image} onChanged={vi.fn()} />);
    expectVisibleGraphFirst(html);
    expect(segmentWidth(html, 'disk', 'weights')).toBe(100);
    expect(html).toContain('Image model weights on disk');
    expect(html).toContain('11.0 GB');
    expect(html).toMatch(/data-meter-total[^]*?Unknown/);
    expect(html).toContain('Supporting files in memory</dt><dd>Unknown');
    expect(html).toContain('image size');
    expect(html).not.toMatch(/context|session|KV cache|recommended settings/i);
  });

  it('mounts the primary graph before controls and uses a secondary recommendation button', () => {
    const html = renderToStaticMarkup(<EngineLoadDrawer providerId="nekko-engine" model={{ ...hermes, loaded: false }}
      onDone={vi.fn()} onClose={vi.fn()} onToggleAutoload={vi.fn()} />);
    expectVisibleGraphFirst(html);
    expect(html.indexOf('data-meter-total')).toBeLessThan(html.indexOf('Use recommended settings'));
    expect(html.match(/<button[^>]*data-recommend[^>]*>/)?.[0]).toContain('btn btn-outline text-xs');
  });

  it('does not render a zero-byte estimate when hardware and model facts are unavailable', () => {
    const html = renderToStaticMarkup(<LoadMemoryMeter model={{ ...model, sizeBytes: 0 }} />);
    expect(html).toMatch(/data-meter-total[^]*?Unknown/);
    expect(html).not.toMatch(/on disk|0 B|role="meter"/);
  });
});

describe('placement refresh', () => {
  it('refreshes placement, never overlaps a pending read, and drops results after the drawer closes or edits change', async () => {
    vi.useFakeTimers();
    try {
      let finishRead!: (value: number) => void;
      const read = vi.fn<() => Promise<number>>()
        .mockResolvedValueOnce(1)
        .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      const publish = vi.fn();
      const stop = pollLoadMemory(read, publish, 2000, 150);
      await vi.advanceTimersByTimeAsync(149);
      expect(read).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(publish).toHaveBeenCalledWith(1);
      await vi.advanceTimersByTimeAsync(4000);
      expect(read).toHaveBeenCalledTimes(2);
      stop();
      finishRead(2);
      await vi.advanceTimersByTimeAsync(6000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
