import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuestionCard } from './QuestionCard.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const request = { callId: 'c', askedAt: 0, questions: [{ id: 'q', header: 'Branch', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] };

describe('agent question in the window', () => {
  it('wears the warning tone, larger, when it is how a window asks for you', () => {
    const html = renderToStaticMarkup(<QuestionCard request={request} onAnswer={() => {}} onSkip={() => {}} tone="attention" />);
    expect(html).toContain('data-question-tone="attention"');
    expect(html).toContain('var(--warning) 70%');
    expect(html).toContain('text-[14px] font-semibold');
    const plain = renderToStaticMarkup(<QuestionCard request={request} onAnswer={() => {}} onSkip={() => {}} />);
    expect(plain).toContain('data-question-tone="accent"');
  });
  it('pins the question above the transcript with a visible label, not below it', () => {
    const pane = read('./ChatPane.tsx');
    const pin = pane.indexOf('data-agent-question');
    const transcript = pane.indexOf('<VirtualTranscript\n');
    expect(pin).toBeGreaterThan(0);
    expect(pin).toBeLessThan(transcript);
    expect(pane).toContain('Asked you a question</p>');
    expect(pane).not.toContain("surface === 'transcript' && question && <div className=\"max-h-[60%]");
    // The frame's banner sat under the absolutely positioned window content.
    expect(read('./CommandWall.tsx')).not.toContain("{status?.label ?? 'Needs your attention'}</div>}");
  });
});

describe('plan panel toggle', () => {
  const pane = read('./ChatPane.tsx');
  const rail = read('./PlanRail.tsx');
  it('is a floating plan icon in the chat area, not an X in the panel', () => {
    expect(pane).toContain('data-plan-toggle');
    // Floating button only while minimized; the open panel minimizes itself.
    expect(pane).toContain('{wideEnoughForRail && !planRailOpen && (');
    expect(pane).toContain('onMinimize={() => useStore.getState().togglePlanRail(sessionId)}');
    expect(rail).toContain('data-plan-minimize');
    // The transcript starts below the floating button instead of under it.
    expect(read('../styles.css')).toContain('div:has(> .plan-rail-toggle) > [data-transcript-scroll] { padding-top: 44px; }');
    expect(pane).toMatch(/className=\{`plan-rail-toggle \$\{planRailOpen \? 'is-open' : ''\}`\}/);
    expect(rail).not.toContain('Hide the plan panel');
    expect(rail).not.toContain('onClose');
    expect(read('../styles.css')).toMatch(/\.plan-rail-toggle \{\s*position: absolute; top: 8px; right: 10px;/);
  });
  it('is on by default and only gives way when the window is about two panels wide', () => {
    expect(pane).toContain('const PLAN_RAIL_WIDTH = 280;');
    expect(pane).toContain('const PLAN_RAIL_MIN_PANE = PLAN_RAIL_WIDTH * 2;');
    expect(read('../store.ts')).toMatch(/function readPlanRailOpen\(\)[\s\S]{0,200}return true;/);
  });
});
