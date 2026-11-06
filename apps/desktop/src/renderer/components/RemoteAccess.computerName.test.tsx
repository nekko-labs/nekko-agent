import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComputerName } from './RemoteAccess.js';

const state = vi.hoisted(() => ({ settings: {} as { machineName?: string }, refreshSettings: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));

describe('Computer name in phone pairing settings', () => {
  it('labels the editable name, bounds it and explains the system-name default', () => {
    const html = renderToStaticMarkup(<ComputerName />);
    expect(html).toContain('for="computer-name"');
    expect(html).toContain('maxLength="40"');
    expect(html).toContain('Leave blank to use');
    expect(html).toContain('rename it just on your phone');
  });

  it('starts with the saved override rather than a generic OS name', () => {
    state.settings = { machineName: 'Studio Mac' };
    expect(renderToStaticMarkup(<ComputerName />)).toContain('value="Studio Mac"');
    state.settings = {};
  });
});
