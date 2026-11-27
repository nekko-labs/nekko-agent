import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolDetail } from './ToolDetail.js';
import { ActivityGroup } from './ActivityGroup.js';
import { HoverTip } from '../HoverTip.js';
import type { Activity } from './transcript.js';

vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));

const decode = (s: string) => s.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

describe('tool row hover details', () => {
  it('carries the full pretty-printed input, not the truncated headline', () => {
    const input = { path: `/workspace/${'deep/'.repeat(40)}file.ts`, start_line: 1, end_line: 220 };
    const items: Activity[] = [{ kind: 'tool', call: { id: 'read', name: 'read_file', input } }];
    const html = renderToStaticMarkup(<ActivityGroup items={items} streaming />);
    const tips = [...html.matchAll(/data-hover-tip="([^"]*)"/g)].map((m) => decode(m[1]));
    expect(tips).toContain(JSON.stringify(input, null, 2));
  });

  it('a heading tip renders its trigger like a plain one until opened', () => {
    const plain = renderToStaticMarkup(<HoverTip label="x"><button>row</button></HoverTip>);
    const detailed = renderToStaticMarkup(<HoverTip label="x" heading="read_file"><button>row</button></HoverTip>);
    expect(detailed).toBe(plain);
    expect(detailed).not.toContain('role="tooltip"');
  });
});

it('renders the error as literal text ahead of the command and preserves extra arguments', () => {
  const call = { id: 'cmd', name: 'Bash', input: { command: 'echo "hello"', cwd: '/work' } };
  const html = renderToStaticMarkup(<ToolDetail call={call} result={{ toolCallId: 'cmd', isError: true, output: '<bad>not found</bad>' }} />);
  expect(html).not.toContain('<bad>');
  expect(decode(html)).toMatch(/Failed.*<bad>not found<\/bad>.*echo "hello".*"cwd": "\/work"/s);
  expect(renderToStaticMarkup(<ToolDetail call={call} failed />)).toContain('No failure message was recorded');
  expect(renderToStaticMarkup(<ToolDetail call={call} />)).not.toContain('Failed');
});
