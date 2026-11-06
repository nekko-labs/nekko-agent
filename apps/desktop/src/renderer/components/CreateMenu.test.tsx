import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateMenuRows } from './CreateMenu.js';
import { SHORTCUTS } from '../shortcuts.js';

describe('shared creation choices', () => {
  it('shows all three hints without a permanently active hero row', () => {
    const html = renderToStaticMarkup(<CreateMenuRows onCreate={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html.match(/<kbd/g)).toHaveLength(3);
    for (const shortcut of [SHORTCUTS.newAgent, SHORTCUTS.newMedia, SHORTCUTS.newTerminal]) expect(html).toContain(shortcut.label);
    expect(html).not.toContain('create-row-hero');
  });
  it('routes exactly one creation kind per row activation', () => {
    const create = vi.fn();
    const rows = React.Children.toArray(CreateMenuRows({ onCreate: create }).props.children) as React.ReactElement<{ onClick: () => void }>[];
    rows.forEach((row) => row.props.onClick());
    expect(create.mock.calls).toEqual([['chat'], ['image'], ['terminal']]);
  });
});
