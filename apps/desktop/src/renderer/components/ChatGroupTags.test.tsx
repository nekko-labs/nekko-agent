import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { liveStore } from '../tests/liveStore.js';
import { useStore } from '../store.js';
import { agentSummary } from '../tests/renderSidebar.js';
import { ChatGroupTagPicker } from './ChatGroupTagPicker.js';
import { ChatBreadcrumb } from './ChatBreadcrumb.js';
import { ChatGroupTagButton } from './ChatGroupTagControls.js';
import { ChatGroupDot } from './ChatGroupDot.js';
import { DEFINED_CHAT_GROUPS_KEY, buildChatGroupIndex, type DefinedChatGroup } from '../views/chatGroups.js';
import { CHAT_TAGS_KEY } from '../views/chatTags.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const defined: DefinedChatGroup[] = [
  { id: 'g_zeta0001', name: 'Zeta', color: 1 },
  { id: 'g_alpha001', name: 'alpha', color: 2 },
  { id: 'g_blank001', color: 0 },
  { id: 'g_hex00001', color: '#123456' },
];

beforeEach(() => { localStorage.removeItem(DEFINED_CHAT_GROUPS_KEY); localStorage.removeItem(CHAT_TAGS_KEY); useStore.setState({ sessions: [] }); });

const picker = (chats: Array<{ chatGroup?: string | null; tags?: string[] }> = [{}], extra: Partial<React.ComponentProps<typeof ChatGroupTagPicker>> = {}) => {
  const index = buildChatGroupIndex(chats, defined);
  return renderToStaticMarkup(
    <ChatGroupTagPicker groups={index.groups} tags={['zed', 'Beta', 'alpha']} chats={chats} resolve={index.resolve}
      onPickGroup={() => {}} onToggleTag={() => {}} onCreate={() => {}} onClose={() => {}} {...extra} />,
  );
};

describe('group and tag picker', () => {
  it('has a search field, then Create group / tag… as the very first option, then Groups, then Tags', () => {
    const html = picker();
    expect(html).toMatch(/role="combobox"[^>]*aria-label="Search groups and tags"/);
    const options = [...html.matchAll(/role="option"/g)];
    expect(options.length).toBe(1 + 4 + 3);
    expect(html.indexOf('data-chat-picker-search')).toBeLessThan(html.indexOf('data-picker-create'));
    expect(html.indexOf('Create group / tag…')).toBeLessThan(html.indexOf('>Groups<'));
    expect(html.indexOf('>Groups<')).toBeLessThan(html.indexOf('>Tags<'));
    // The first option in the list is Create.
    expect(html.match(/role="option"[^>]*/)![0]).toContain('data-picker-create');
  });

  it('lists groups A to Z ignoring case, unnamed after, and tags A to Z', () => {
    const html = picker();
    const labels = [...html.matchAll(/data-picker-group="[^"]+"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(['alpha', 'Zeta', 'Untitled group (Teal)', 'Untitled group']);
    // The visible text never names the colour; only screen readers hear it.
    expect(html).not.toContain('>Untitled group (Teal)<');
    expect(html).toContain('>Untitled group<');
    expect([...html.matchAll(/data-picker-tag="([^"]+)"/g)].map((m) => m[1])).toEqual(['alpha', 'Beta', 'zed']);
    expect(html).toContain('>#<');
  });

  it('shows each group as a colour dot and its name, from tokens', () => {
    const html = picker();
    expect(html).toMatch(/data-picker-group="g_zeta0001"[^]*?chat-picker-dot" style="background:var\(--zone-tint-1\)"[^]*?>Zeta</);
    expect(html).toContain('style="background:#123456"');
  });

  it('has listbox, group and option roles, labelled sections, and no highlighted option until the keyboard or pointer picks one', () => {
    const html = picker();
    expect(html).toContain('role="dialog" aria-label="Group and tags"');
    expect(html).toMatch(/role="listbox" aria-label="Groups and tags" aria-multiselectable="true"/);
    const groupLabel = html.match(/<div role="group" aria-labelledby="([^"]+)"[^>]*data-picker-section="groups"/)![1];
    expect(html).toContain(`id="${groupLabel}"`);
    expect(html).not.toContain('aria-activedescendant');
    expect(html).not.toContain('data-active="true"');
  });

  it('checks the chat\'s group, offers No group only when it has one, and marks tags on, some or off', () => {
    const none = picker([{}]);
    expect(none).not.toContain('data-picker-no-group');
    const html = picker([{ chatGroup: 'g_zeta0001', tags: ['beta', 'alpha'] }, { chatGroup: 'g_zeta0001', tags: ['alpha'] }]);
    expect(html).toContain('data-picker-no-group');
    expect(html).toMatch(/aria-selected="true"[^>]*data-picker-group="g_zeta0001"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-picker-group="g_alpha001"/);
    expect(html).toMatch(/aria-selected="true"[^>]*data-picker-tag="alpha"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-mixed="true"[^>]*data-picker-tag="Beta"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-picker-tag="zed"/);
  });

  it('resolves a chat that stored a group\'s name to that group', () => {
    expect(picker([{ chatGroup: 'ZETA' }])).toMatch(/aria-selected="true"[^>]*data-picker-group="g_zeta0001"/);
  });

  it('opens an inline form: Group or Tag, a name that is optional for a group, a colour that is not', () => {
    const html = picker([{}], { initialCreating: true });
    expect(html).toContain('data-picker-create-form');
    expect(html).toMatch(/role="radiogroup" aria-label="Create a"/);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Group</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Tag</);
    expect(html).toContain('aria-label="Group name (optional)"');
    expect(html).toContain('data-chat-group-color-picker');
    expect(html).not.toContain('aria-checked="true" aria-label="Teal"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Create group</);
    // The list gives way to the form.
    expect(html).not.toContain('role="listbox"');
  });
});

describe('unnamed group', () => {
  it('is its colour dot alone, named "Untitled group (Teal)" or plainly for a custom colour', () => {
    const teal = buildChatGroupIndex([], defined).resolve('g_blank001')!;
    const hex = buildChatGroupIndex([], defined).resolve('g_hex00001')!;
    useStore.setState({ sessions: [agentSummary('a', { chatGroup: 'g_blank001' })] });
    localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(defined));
    const html = renderToStaticMarkup(<ChatBreadcrumb sessionId="a" titleNode={<span>Chat a</span>} />);
    expect(html).toMatch(/<span[^>]*title="Group: Untitled group \(Teal\)" aria-label="Group: Untitled group \(Teal\)"[^>]*><span role="img"[^>]*aria-label="Untitled group \(Teal\)"[^>]*><\/span><\/span>/);
    expect(teal.name).toBeNull();
    expect(hex.name).toBeNull();
    const dot = (label: string) => renderToStaticMarkup(<ChatGroupDot color="#123456" name={label} label={label} />);
    expect(dot('Untitled group')).toContain('aria-label="Untitled group"');
  });

  it('shows no text of its own beside the dot, in the crumb or on the card', () => {
    useStore.setState({ sessions: [agentSummary('a', { chatGroup: 'g_hex00001' })] });
    localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(defined));
    const html = renderToStaticMarkup(<ChatBreadcrumb sessionId="a" titleNode={<span>Chat a</span>} />);
    expect(html).toContain('aria-label="Untitled group"');
    expect(html).not.toContain('>Untitled group<');
  });
});

describe('header breadcrumb', () => {
  const crumb = (patch: { chatGroup?: string | null; tags?: string[] }) => {
    localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(defined));
    useStore.setState({ sessions: [agentSummary('a', patch)] });
    return renderToStaticMarkup(<ChatBreadcrumb sessionId="a" titleNode={<span data-title>Chat a</span>} />);
  };
  const order = (html: string) => ['data-chat-crumb="group"', 'data-chat-crumb="tags"', 'data-title'].map((m) => html.indexOf(m));
  const seps = (html: string) => html.match(/<span aria-hidden="true"[^>]*>\/<\/span>/g)?.length ?? 0;

  it('is just the title with no group and no tags', () => {
    expect(crumb({})).toBe('<span data-title="true">Chat a</span>');
  });
  it('is group / title with a group only', () => {
    const html = crumb({ chatGroup: 'g_zeta0001' });
    const [g, t, title] = order(html);
    expect(g).toBeGreaterThan(-1); expect(t).toBe(-1); expect(g).toBeLessThan(title);
    expect(seps(html)).toBe(1);
    expect(html).toContain('>Zeta<');
    // A named group is its name in the group's colour, with no dot.
    expect(html).toMatch(/style="color:var\(--zone-tint-1\)"[^>]*>Zeta</);
    expect(html).not.toMatch(/background:var\(--zone-tint-1\)/);
  });
  it('draws an unnamed group as its dot alone', () => {
    const html = crumb({ chatGroup: 'g_blank001' });
    expect(html).toMatch(/background:var\(--zone-tint-0\)/);
    expect(html).not.toMatch(/style="color:/);
  });
  it('is #tags / title with tags only, joined and counted when there are many', () => {
    const html = crumb({ tags: ['a', 'b', 'c', 'd', 'e'] });
    const [g, t, title] = order(html);
    expect(g).toBe(-1); expect(t).toBeGreaterThan(-1); expect(t).toBeLessThan(title);
    expect(seps(html)).toBe(1);
    expect(html).toContain('>#a #b #c<');
    expect(html).toContain('>+2<');
    expect(html).not.toContain('>#d');
  });
  it('is group / #tags / title with both, the title last', () => {
    const html = crumb({ chatGroup: 'g_alpha001', tags: ['x', 'y'] });
    const [g, t, title] = order(html);
    expect(g).toBeLessThan(t); expect(t).toBeLessThan(title);
    expect(seps(html)).toBe(2);
    expect(html).toContain('>#x #y<');
  });
  it('resolves a group stored by name, and only names the group and tags on hover: no buttons, no picker', () => {
    const html = crumb({ chatGroup: 'ZETA', tags: ['x'] });
    expect(html).toContain('>Zeta<');
    expect(html).toContain('title="Group: Zeta"');
    expect(html).toContain('title="Tags: #x"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('Change group and tags');
  });
  it('truncates: parts are capped and shrink, the title keeps its own element', () => {
    const html = crumb({ chatGroup: 'g_zeta0001', tags: ['x'] });
    expect(html).toMatch(/data-chat-crumb="group"[^>]*>/);
    expect(html).toContain('max-w-[9rem]');
    expect(html).toContain('truncate');
  });
  it('draws the tags part as quiet 11px faint text with no border, ring or fill', () => {
    const html = crumb({ chatGroup: 'g_zeta0001', tags: ['x'] });
    const tags = html.match(/<span[^>]*data-chat-crumb="tags"[^>]*>/)![0];
    expect(tags).toContain('text-2xs text-ink-faint');
    expect(tags).not.toMatch(/border|ring-|bg-|outline/);
  });
  it('uses tokens only', () => {
    expect(crumb({ chatGroup: 'g_zeta0001', tags: ['x'] })).not.toMatch(/#[0-9a-f]{3,6}\b(?![^<]*<\/)/i);
  });
});

describe('composer button', () => {
  it('shows for a chat with no messages, naming what it is and its group', () => {
    localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(defined));
    useStore.setState({ sessions: [agentSummary('a', { messageCount: 0, chatGroup: 'g_zeta0001', tags: ['x', 'y'] })] });
    const html = renderToStaticMarkup(<ChatGroupTagButton sessionId="a" />);
    expect(html).toContain('aria-label="Group and tags"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('>Zeta<');
    expect(html).toContain('#2');
  });
  it('shows for a chat that is not in the list yet, and not once it has messages', () => {
    expect(renderToStaticMarkup(<ChatGroupTagButton sessionId="new" />)).toContain('data-chat-group-tag-button');
    useStore.setState({ sessions: [agentSummary('a', { messageCount: 3 })] });
    expect(renderToStaticMarkup(<ChatGroupTagButton sessionId="a" />)).toBe('');
  });
});
