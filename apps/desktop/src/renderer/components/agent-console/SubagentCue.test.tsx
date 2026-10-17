import React from 'react';
import { expect, it, vi } from 'vitest';
vi.mock('../../store.js', () => ({ useStore: { getState: () => ({ openChatPane: () => {}, setView: () => {} }) } }));
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityGroup } from './ActivityGroup.js';
import { ToolCard } from './ToolCard.js';
import { toStreamBlocks } from './transcript.js';
import { MessageBubble } from './MessageBubble.js';
import type { ChatMessage, ToolCall } from '@nekko-agent/shared';

const call: ToolCall = { id: 'child', name: 'spawn_agent', input: { title: 'Integration checks', task: 'Run tests' } };
it('keeps delegation identifiable in collapsed groups and tool cards', () => {
  const html = renderToStaticMarkup(<ActivityGroup items={[{ kind: 'tool', call }]} />);
  expect(html).toContain('Subagent waiting · Run tests');
  expect(html).not.toContain('border-accent');
  expect(html).not.toContain('border-l border-line');
  expect(html.match(/<svg/g)).toHaveLength(2);
  expect(renderToStaticMarkup(<ToolCard call={call} />)).toContain('Subagent waiting · Run tests');
  expect(renderToStaticMarkup(<ActivityGroup items={[{kind:'tool',call:{...call,name:'read_file'}}]} />)).not.toContain('subagent');
});
it('summarizes task text rather than titles, and retains a title fallback', () => {
  const long = { ...call, input: { ...call.input, task: '  Check  the\nplatform  ' } };
  expect(renderToStaticMarkup(<ToolCard call={long} />)).toContain('Subagent waiting · Check the platform');
  expect(renderToStaticMarkup(<ToolCard call={{ ...call, input: { title: 'Integration checks' } }} />)).toContain('Subagent waiting · Integration checks');
});
it('attaches only the matching delegation result, including errors, to the persisted step', () => {
  const messages: ChatMessage[] = [
    {id:'a',role:'assistant',content:'',createdAt:0,toolCalls:[call]},
    {id:'other',role:'tool',content:'unrelated',createdAt:0,toolResult:{toolCallId:'other',output:'unrelated'}},
    {id:'result',role:'tool',content:'Test failed',createdAt:0,toolResult:{toolCallId:call.id,output:'Test failed',isError:true}},
  ];
  const blocks = toStreamBlocks(messages);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({type:'activity',items:[{kind:'tool',call,result:{output:'Test failed',isError:true}}]});
});
it('renders watch wake-ups as watch rows without treating assistant quotations as automated messages', () => {
  const message: ChatMessage = {id:'watch',role:'user',content:'[Agent watch abc]\nCheck CI',createdAt:0};
  const html = renderToStaticMarkup(<MessageBubble message={message} />);
  expect(html).toContain('data-watch-wake');
  expect(html).toContain('Watch triggered');
  expect(html).not.toContain('msg-user');
  expect(renderToStaticMarkup(<MessageBubble message={{...message,role:'assistant'}} />)).not.toContain('Watch triggered');
});

import { SubagentParentContext } from './SubagentCue.js';
import { foldSubagentActivity, resetSubagentActivity } from '../../subagentActivity.js';
it('offers sibling navigation only for an unambiguous observed child', () => {
  resetSubagentActivity();
  foldSubagentActivity({ type: 'tool_call', sessionId: 'parent', call }, 10);
  const child: any = { id: 'child-session', parentSessionId: 'parent', title: 'Integration checks', createdAt: 20 };
  for (const content of [<ToolCard call={call} />, <ActivityGroup items={[{ kind: 'tool', call }]} />]) {
    const html = renderToStaticMarkup(<SubagentParentContext.Provider value={[child]}>{content}</SubagentParentContext.Provider>);
    expect(html).toContain('aria-label="Open subagent: Integration checks"');
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  }
  resetSubagentActivity();
  expect(renderToStaticMarkup(<ToolCard call={call} />)).not.toContain('Open subagent:');
});
