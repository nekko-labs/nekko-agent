import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, composerBox, renderChatPane, withProvider } from '../tests/renderChatPane.js';
vi.mock('./PromptAnalyzer.js', () => ({ PromptAnalyzer: () => 'Prompt suggestions test control' }));

const mode = vi.hoisted(() => ({ expert: false }));
vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('../simpleMode.js', async (original) => {
  const { simpleShown } = await import('@nekko-agent/shared');
  return { ...(await original<object>()), useExpertMode: () => [mode.expert, () => {}], useShown: (id: string) => simpleShown(id, mode.expert, {}) };
});

beforeEach(() => { mode.expert = false; withProvider(); });
const box = () => composerBox(renderChatPane(chatSession(), { commandCenter: true }));

describe('composer effort and suggestions', () => {
  for (const cleanStart of [false, true]) for (const props of [{}, { commandCenter: true }, { surface: 'composer' as const }]) {
    it(`keeps one Mode/Suggestions row for new=${cleanStart}, ${JSON.stringify(props)}`, () => {
      mode.expert = true;
      const out = composerBox(renderChatPane(chatSession({ messages: cleanStart ? [] : chatSession().messages }), { ...props, cleanStart }));
      expect(out.match(/data-composer-mode-row/g)).toHaveLength(1);
      expect(out.match(/data-chat-mode-button/g)).toHaveLength(1);
      expect(out.match(/data-composer-suggestions/g)).toHaveLength(1);
      const row = out.slice(out.indexOf('data-composer-mode-row'));
      expect(row.indexOf('data-chat-mode-button')).toBeLessThan(row.indexOf('data-composer-suggestions'));
      expect(row).toContain('composer-suggestions ml-auto shrink-0');
    });
  }
  it('shows effort in the Simple composer by default, not only inside the model menu', () => {
    const out = box();
    expect(out).toContain('data-composer-foot');
    expect(out).toContain('class="effort-slider');
    expect(out).toContain('Reasoning effort: Unavailable');
    expect(out).toContain('disabled=""');
    expect(out).not.toContain('data-composer-suggestions');
    expect(out).not.toContain('Prompt suggestions test control');
  });
  it('keeps new-chat suggestions at the right of Mode without repeating the control', () => {
    mode.expert = true;
    const out = composerBox(renderChatPane(chatSession({ messages: [] }), { commandCenter: true, cleanStart: true }));
    expect(out.match(/data-composer-suggestions/g)).toHaveLength(1);
    expect(out).toContain('composer-suggestions ml-auto shrink-0');
    expect(out.indexOf('data-composer-suggestions')).toBeGreaterThan(out.indexOf('data-composer-mode-row'));
    expect(out.indexOf('data-composer-suggestions')).toBeGreaterThan(out.indexOf('data-composer-action'));
  });
  it('puts suggestions in the Mode row, below the action bar, only in Expert', () => {
    mode.expert = true;
    const out = box();
    expect(out).toContain('data-composer-suggestions');
    expect(out).toContain('Prompt suggestions test control');
    expect(out.indexOf('data-composer-suggestions')).toBeGreaterThan(out.indexOf('data-composer-foot'));
    expect(out.indexOf('data-composer-suggestions')).toBeGreaterThan(out.indexOf('data-composer-action'));
    expect(out.slice(0, out.indexOf('data-composer-suggestions'))).not.toContain('Prompt suggestions test control');
    const chat = composerBox(renderChatPane(chatSession()));
    expect(chat.indexOf('data-composer-suggestions')).toBeGreaterThan(chat.indexOf('composer-bar'));
    expect(chat.indexOf('data-composer-suggestions')).toBeGreaterThan(chat.indexOf('data-composer-action'));
  });
});
