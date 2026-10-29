import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadJob, LocalModel, Recommendations } from '@nekko-agent/shared';
import { FirstModelSteps, firstModelPhase, fitSentence, type FirstModelPhase } from './FirstLocalModel.js';
import fixture from './recommendations.fixture.json';

const recs = fixture as unknown as Record<'rtx4060' | 'cpu', Recommendations>;
const picks = (r: Recommendations) => r.tasks.filter((t) => t.task === 'chat' || t.task === 'code');
const chat = picks(recs.rtx4060)[0];
const render = (phase: FirstModelPhase, engineReady = false) =>
  renderToStaticMarkup(
    <FirstModelSteps
      recs={recs.rtx4060}
      picks={picks(recs.rtx4060)}
      chosen={chat}
      engineReady={engineReady}
      phase={phase}
      onChoose={vi.fn()}
      onSetUp={vi.fn()}
      onCancel={vi.fn()}
      onStart={vi.fn()}
      onShowAll={vi.fn()}
    />,
  );
const job = (j: Partial<DownloadJob>): DownloadJob => ({ id: 'j', kind: 'model', label: 'x', target: 'x', state: 'downloading', receivedBytes: 0, startedAt: 0, ...j });
const model = (file: string): LocalModel => ({ id: `r/${file}`, name: 'Qwen3.5 9B', path: `/m/${file}`, sizeBytes: 1, addedAt: 0 });

describe('the first local model screen', () => {
  it('asks one question and hides the expert vocabulary', () => {
    const html = render({ kind: 'choose' });
    expect(html).toContain('Run AI on this computer');
    expect(html).toContain('Everyday help');
    expect(html).toContain('Writing code');
    expect(html).toContain('Download and set up');
    expect(html).toContain('plus the small free engine that runs it');
    expect(html).toContain('Show all models and settings');
    for (const jargon of ['Q4_K_M', 'tok/s', 'Vulkan', 'runtime', 'GGUF', 'quant']) expect(html).not.toContain(jargon);
  });

  it('does not mention the engine once it is installed', () => {
    expect(render({ kind: 'choose' }, true)).not.toContain('engine');
  });

  it('shows the engine and the model as steps with progress', () => {
    const [engine] = [job({ id: 'e', kind: 'engine', state: 'done' })];
    const phase = firstModelPhase(
      [engine, job({ id: 'm', group: 'g', groupLabel: 'Qwen3.5 9B · Q4_K_M', receivedBytes: 2e9, totalBytes: 5e9, bytesPerSecond: 20e6 })],
      [],
      picks(recs.rtx4060),
    );
    expect(phase.kind).toBe('working');
    const html = render(phase);
    expect(html).toContain('Setting up Qwen3.5 9B');
    expect(html).toContain('data-step="done"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('left');
    expect(html).toContain('Cancel');
  });

  it('is ready once the picked file is on disk, and offers to start chatting', () => {
    const phase = firstModelPhase([], [model(chat.pick!.files[0])], picks(recs.rtx4060));
    expect(phase.kind).toBe('ready');
    const html = render(phase);
    expect(html).toContain('Qwen3.5 9B is ready');
    expect(html).toContain('Start chatting');
    expect(html).toContain('Step 3 of 3');
  });

  it('says a failed download stopped, and offers the button again', () => {
    const phase = firstModelPhase([job({ state: 'failed', message: 'The network dropped.' })], [], picks(recs.rtx4060));
    expect(phase).toEqual({ kind: 'failed', message: 'The network dropped.' });
    const html = render(phase);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Download and set up');
  });

  it('describes the fit in words', () => {
    expect(fitSentence(chat, recs.rtx4060)).toBe('Fits your NVIDIA GeForce RTX 4060, with little room to spare.');
    const cpuChat = picks(recs.cpu)[0];
    expect(fitSentence(cpuChat, recs.cpu)).toMatch(/this computer/);
  });
});
