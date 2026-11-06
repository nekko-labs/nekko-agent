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
  it('shows effort in the Simple composer by default, not only inside the model menu', () => {
    const out = box();
    expect(out).toContain('data-composer-foot');
    expect(out).toContain('class="effort-slider');
    expect(out).toContain('Reasoning effort: Unavailable');
    expect(out).toContain('disabled=""');
    expect(out).not.toContain('data-composer-suggestions');
    expect(out).not.toContain('Prompt suggestions test control');
  });
  it('puts suggestions beside the microphone, in the action bar, only in Expert', () => {
    mode.expert = true;
    const out = box();
    expect(out).toContain('data-composer-suggestions');
    expect(out).toContain('Prompt suggestions test control');
    expect(out.indexOf('data-composer-suggestions')).toBeGreaterThan(out.indexOf('data-composer-foot'));
    expect(out.indexOf('data-composer-suggestions')).toBeLessThan(out.indexOf('data-composer-action'));
    expect(out.slice(0, out.indexOf('data-composer-suggestions'))).not.toContain('Prompt suggestions test control');
    const chat = composerBox(renderChatPane(chatSession()));
    expect(chat.indexOf('data-composer-suggestions')).toBeGreaterThan(chat.indexOf('composer-bar'));
    expect(chat.indexOf('data-composer-suggestions')).toBeLessThan(chat.indexOf('data-composer-action'));
  });
});
