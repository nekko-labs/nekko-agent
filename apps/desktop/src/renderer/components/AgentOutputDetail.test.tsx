import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';

const saved = vi.hoisted(() => ({ expert: false, choices: {} as Record<string, string> }));
vi.mock('../store.js', original => liveStore(original as never));
vi.mock('../simpleMode.js', () => ({
  useExpertMode: () => [saved.expert, vi.fn()],
  useSimpleChoices: () => [saved.choices, vi.fn()],
  useShown: () => true,
}));

import { AgentOutputDetail } from './AgentOutputDetail.js';
import { ExperienceControls } from './CustomizeExperience.js';
import { DetailChoices, DetailPreview } from './onboarding/DetailStep.js';
import { LEVELS, MINIMAL_HIDES } from './onboarding/aboutYou.js';
import { useStore } from '../store.js';

describe('Agent output detail', () => {
  it.each(LEVELS)('restores $title from existing presentation preferences', ({ id }) => {
    saved.expert = id === 'detailed';
    saved.choices = id === 'minimal' ? Object.fromEntries(MINIMAL_HIDES.map(key => [key, 'hide'])) : {};
    const html = renderToStaticMarkup(<AgentOutputDetail />);
    expect(html).toContain(`aria-checked="true" data-detail-level="${id}" tabindex="0"`);
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toContain(`aria-label="Preview of a chat in ${id}"`);
    expect(html).toContain('Illustrative example, not a live agent run.');
    expect(html).toContain('Pause preview');
  });

  it('shares setup cards and keeps a single keyboard tab stop', () => {
    const html = renderToStaticMarkup(<DetailChoices level="regular" onChange={() => {}} recommended="regular" />);
    for (const level of LEVELS) { expect(html).toContain(level.title); expect(html).toContain(level.desc); }
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toContain('Suggested');
    expect(html).not.toContain('Every thought');
  });

  it('uses a dedicated output section rather than another binary mode switch', () => {
    const defaults = JSON.parse(readFileSync(new URL('../../../../../crates/nekko-settings/src/defaults.json', import.meta.url), 'utf8')).defaults;
    useStore.setState({ settings: defaults, settingsLoaded: true });
    const html = renderToStaticMarkup(<ExperienceControls onSettings={() => {}} />);
    const output = html.split('<section class="customize-section">')[1].split('</section>')[0];
    expect(output).toContain('Agent output detail');
    expect(output).toContain('not permissions or answer length');
    expect(output).toContain('data-detail-level="minimal"');
    expect(output).not.toContain('data-chat-mode');
  });

  it('keeps the setup preview and monitors available without the compact variant', () => {
    const html = renderToStaticMarkup(<DetailPreview level="detailed" monitors />);
    expect(html).toContain('Monitors');
    expect(html).toContain('Thought for 4s');
    expect(html).toContain('h-[440px]');
  });
});
