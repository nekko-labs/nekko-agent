import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, stylesheet } from '../tests/css.js';
import { liveStore } from '../tests/liveStore.js';
import { elementWidthMock, paneWidth } from '../tests/paneWidth.js';
import { chatSession, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { useStore } from '../store.js';
import { QuestionCard } from './QuestionCard.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('./agent-console/useElementWidth.js', (original) => elementWidthMock(original));

const request = { callId: 'c', askedAt: 0, questions: [{ id: 'q', header: 'Branch', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] };
const styles = stylesheet('styles.css');
// The store as a fresh profile loads it, before any test changes it.
const freshProfile = { planRailOpen: useStore.getState().planRailOpen, planRailOpenBySession: useStore.getState().planRailOpenBySession };

describe('agent question in the window', () => {
  it('wears the warning tone, larger, when it is how a window asks for you', () => {
    const html = renderToStaticMarkup(<QuestionCard request={request} onAnswer={() => {}} onSkip={() => {}} tone="attention" />);
    expect(html).toContain('data-question-tone="attention"');
    expect(html).toContain('var(--warning) 70%');
    expect(html).toContain('text-[14px] font-semibold');
    const plain = renderToStaticMarkup(<QuestionCard request={request} onAnswer={() => {}} onSkip={() => {}} />);
    expect(plain).toContain('data-question-tone="accent"');
  });
  // Source pin, pending the wall e2e journey: the question reaches the pane
  // from the host (a promise or an agent event), which a server render never
  // applies, so the pinned layout cannot be rendered here.
  it('pins the question above the transcript with a visible label, not below it (source pin)', () => {
    const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    const pin = pane.search(/data-agent-question\b/);
    expect(pin).toBeGreaterThan(0);
    expect(pin).toBeLessThan(pane.search(/<VirtualTranscript\b/));
    expect(pane).toMatch(/Asked you a question<\/p>/);
  });
  it('says what a window is waiting on inside it, not in a frame banner', async () => {
    // The frame's banner sat under the absolutely positioned window content.
    const { loadWall, summary } = await import('../tests/renderWall.js');
    const wall = (await loadWall()).render(
      { root: { id: 'a', kind: 'chat', refId: 'a' } as never, layout: { mode: 'grid', cols: 1, rows: 1 } },
      { sessions: [summary('a')], pending: { a: { sessionId: 'a', question: request } } },
    );
    expect(wall).toContain('data-wall-needs-you="true"');
    expect(wall).not.toContain('Needs your attention');
    expect(wall).not.toContain('Waiting on you');
  });
});

describe('plan panel toggle', () => {
  beforeEach(() => {
    withProvider();
    paneWidth.value = 1200;
    useStore.setState(freshProfile);
  });
  const toggle = (html: string) => html.match(/<button[^>]*data-plan-toggle[^>]*>/)?.[0] ?? null;

  it('is a floating plan icon in the chat area while minimized; the open panel minimizes itself', () => {
    const plan = chatSession();
    const open = renderChatPane(plan);
    expect(toggle(open)).toBeNull();
    expect(open).toContain('data-plan-minimize');
    expect(open).not.toContain('Hide the plan panel');
    useStore.setState({ planRailOpenBySession: { [plan.id]: false } });
    const minimized = renderChatPane(plan);
    expect(toggle(minimized)).toMatch(/class="plan-rail-toggle /);
    expect(minimized).not.toContain('data-plan-minimize');
    // It floats in the chat area's top-right, and the transcript starts below it.
    expect(cssRule(styles, '.plan-rail-toggle')).toMatchObject({ position: 'absolute', top: '8px', right: '10px' });
    expect(cssRule(styles, 'div:has(> .plan-rail-toggle) > [data-transcript-scroll]')['padding-top']).toBe('44px');
  });

  it('is on by default and only gives way when the pane is under two panels wide', () => {
    // A fresh profile (nothing saved) opens the rail.
    expect(freshProfile).toEqual({ planRailOpen: true, planRailOpenBySession: {} });
    const chat = chatSession();
    paneWidth.value = 560;
    expect(renderChatPane(chat)).toContain('aria-label="Plan and sub-agents"');
    paneWidth.value = 559;
    const narrow = renderChatPane(chat);
    expect(narrow).not.toContain('aria-label="Plan and sub-agents"');
    expect(toggle(narrow)).toBeNull();
    // The rail itself is 280px.
    paneWidth.value = 1200;
    expect(renderChatPane(chat)).toMatch(/<div class="shrink-0" style="width:280px"><aside[^>]*aria-label="Plan and sub-agents"/);
  });
});
