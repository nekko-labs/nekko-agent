import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryCard, parseMemorySave } from './MemoryCard.js';

const call = { id: 'r1', name: 'remember', input: { title: 'Preferred name', body: 'Goes by Phil.' } };

it('shows what was saved and whether it was new', () => {
  const added = renderToStaticMarkup(<MemoryCard call={call} result={{ toolCallId: 'r1', output: 'Memory added: Preferred name' }} />);
  expect(added).toContain('Memory added');
  expect(added).toContain('Preferred name');
  expect(added).toContain('Goes by Phil.');
  expect(added).toContain('Turn on Memory to view');
  expect(parseMemorySave(call, { toolCallId: 'r1', output: 'Memory updated: Preferred name' })?.action).toBe('updated');
});

it('shows nothing for a failed, unfinished or other call', () => {
  expect(parseMemorySave(call)).toBeNull();
  expect(parseMemorySave(call, { toolCallId: 'r1', output: 'Memory was not saved: disk full', isError: true })).toBeNull();
  expect(parseMemorySave({ ...call, name: 'bash' }, { toolCallId: 'r1', output: 'Memory added: x' })).toBeNull();
  expect(renderToStaticMarkup(<MemoryCard call={call} />)).toBe('');
});
