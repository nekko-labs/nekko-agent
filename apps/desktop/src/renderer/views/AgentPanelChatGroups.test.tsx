import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { AGENT_PANEL_VIEW_KEY, DEFAULT_AGENT_PANEL_VIEW } from './agentPanelView.js';
import { ArchivedRow, ChatGroupManageMenu } from './WorkspacesView.js';
import { CreateMenuRows, CreateRow } from '../components/CreateMenu.js';
import { ChatGroupSwatches, nextSwatchIndex } from '../components/ChatGroupSwatches.js';
import { ChatGroupColorPicker, rememberChosenColor } from '../components/ChatGroupColorPicker.js';
import { ColorWheel } from '../components/ColorWheel.js';
import { NewChatGroupForm } from '../components/NewChatGroupForm.js';
import { DEFINED_CHAT_GROUPS_KEY, SAVED_CUSTOM_COLORS_KEY } from './chatGroups.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
vi.stubGlobal('requestAnimationFrame', () => 0);

beforeEach(() => { localStorage.removeItem(AGENT_PANEL_VIEW_KEY); localStorage.removeItem(DEFINED_CHAT_GROUPS_KEY); localStorage.removeItem(SAVED_CUSTOM_COLORS_KEY); });

/** The ids of the cards under each chat group sub-heading, and the ungrouped ones after them. */
const titlesOrder = (html: string) => [...html.matchAll(/data-chat-group-cluster="([^"]*)"|>(Chat [a-z0-9]+)</g)].map((m) => m[1] ?? m[2]);

describe('Agents panel, chat groups', () => {
  it('gathers chats of one chat group under a sub-heading inside a status group, ungrouped chats after', () => {
    const html = renderSidebar({ sessions: [
      agentSummary('a', { updatedAt: 5, chatGroup: 'Frontend fixes' }),
      agentSummary('b', { updatedAt: 4 }),
      agentSummary('c', { updatedAt: 3, chatGroup: 'frontend FIXES' }),
      agentSummary('d', { updatedAt: 2, chatGroup: 'API' }),
    ] });
    expect(titlesOrder(html)).toEqual(['Frontend fixes', 'Chat a', 'Chat c', 'API', 'Chat d', 'Chat b']);
    expect(html).toContain('data-chat-group-heading');
    // Name in the group's colour; the count a pill in that colour at the far end, shaped like the status headings'.
    expect(html).toMatch(/<span class="min-w-0 truncate" style="color:(var\(--zone-tint-[0-5]\))"[^>]*>Frontend fixes<\/span><span class="chat-group-count ms-auto shrink-0 rounded-full px-2 text-2xs font-semibold tabular-nums" style="--chat-group-color:\1" data-chat-group-count="true">2</);
  });

  it('leaves the dot off a card inside its group box: the border already names the group', () => {
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'Frontend fixes' })] });
    expect(html).toContain('data-chat-group-cluster="Frontend fixes"');
    expect(html).not.toContain('data-chat-group-dot');
    expect(html).not.toContain('data-chat-group-label');
  });

  it('shows the dot before the title when the card is not in a group box (clustering off)', () => {
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, clusterChatGroups: false }));
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'Frontend fixes' })] });
    expect(html).not.toContain('data-chat-group-cluster');
    expect(html).toMatch(/<span[^>]*data-chat-group-dot[^>]*aria-label="Group: Frontend fixes" title="Group: Frontend fixes"[^>]*style="background:var\(--zone-tint-[0-5]\)"[^]*Chat a/);
  });

  it('shows the dot with metadata off, and in every status, when cards are not boxed', () => {
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, showMetadata: false, clusterChatGroups: false }));
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'X', phase: 'verifying' }), agentSummary('b', { chatGroup: 'X', exchangeCount: 0 })] });
    expect(html.match(/data-chat-group-dot/g)).toHaveLength(2);
  });

  it('draws a thin border in the group colour around a cluster and an empty bucket', () => {
    localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify([{ name: 'Empty', color: 3 }, { name: 'Docs', color: 4 }]));
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'Docs' })] });
    expect(html).toMatch(/data-chat-group-cluster="Docs"[^>]*style="border:1px solid color-mix\(in srgb, var\(--zone-tint-4\) 55%, transparent\)"/);
    expect(html).toMatch(/data-chat-group-empty="Empty"[^>]*style="border:1px solid color-mix\(in srgb, var\(--zone-tint-3\) 55%, transparent\)"/);
  });

  it('shows no done check in the Done group, but keeps it under other groupings and in other statuses', () => {
    const done = agentSummary('a');
    expect(renderSidebar({ sessions: [done] })).not.toContain('aria-label="Done"');
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'project' }));
    expect(renderSidebar({ sessions: [done] })).toContain('aria-label="Done"');
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'date' }));
    expect(renderSidebar({ sessions: [done] })).toContain('aria-label="Done"');
  });

  it('keeps the other glyphs in the other status groups', () => {
    const html = renderSidebar({ sessions: [agentSummary('w', { activeWatchCount: 1 })] });
    expect(html).toContain('data-agent-group="status:watching"');
    expect(html).toContain('aria-label="Idle, watching"');
  });

  it('adds nothing when no chat has a group', () => {
    const html = renderSidebar({ sessions: [agentSummary('a'), agentSummary('b')] });
    expect(html).not.toContain('data-chat-group');
  });

  it('keeps the dot but not the sub-headings with the switch off', () => {
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, clusterChatGroups: false }));
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'X' }), agentSummary('b'), agentSummary('c', { chatGroup: 'X' })] });
    expect(html).not.toContain('data-chat-group-heading');
    expect(html).toContain('data-chat-group-dot');
  });

  it('does not cluster cards dragged into order (project grouping, manual sort), but still dots them', () => {
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'project' }));
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'X' }), agentSummary('b'), agentSummary('c', { chatGroup: 'X' })] });
    expect(html).not.toContain('data-chat-group-heading');
    expect(html).toContain('data-chat-group-dot');
  });

  it('clusters inside a project group once it is sorted', () => {
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, groupBy: 'project', sortBy: 'updated' }));
    const html = renderSidebar({ sessions: [agentSummary('a', { updatedAt: 3, chatGroup: 'X' }), agentSummary('b', { updatedAt: 2 }), agentSummary('c', { updatedAt: 1, chatGroup: 'X' })] });
    expect(titlesOrder(html)).toEqual(['X', 'Chat a', 'Chat c', 'Chat b']);
  });

  it('clusters a Done group', () => {
    const html = renderSidebar({ sessions: [
      agentSummary('done1', { updatedAt: 2, chatGroup: 'Docs' }),
      agentSummary('done2', { updatedAt: 1, chatGroup: 'Docs' }),
    ] });
    expect(html).toMatch(/data-agent-group="status:done"[^]*data-chat-group-cluster="Docs"/);
  });

  it('dots an archived row with its chat group colour', () => {
    const row = (chatGroup?: string) => renderToStaticMarkup(<ArchivedRow session={agentSummary('old', { archivedAt: 9, chatGroup })} groupColor={chatGroup ? 'var(--zone-tint-2)' : undefined} groupLabel={chatGroup ? `Group: ${chatGroup}` : undefined} now={10} isActive={false} onOpen={() => {}} />);
    expect(row('Old')).toMatch(/aria-label="Group: Old"[^>]*style="background:var\(--zone-tint-2\)"/);
    expect(row()).not.toContain('data-chat-group-dot');
  });
});

describe('defined chat groups', () => {
  // The first version saved plain names; they still read.
  const define = (...names: string[]) => localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(names));
  it('migrates the saved list to ids the first time it is read, and keeps them', () => {
    define('Docs');
    const first = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'docs' })] });
    expect(first).toContain('data-chat-group-cluster="Docs"');
    const saved = JSON.parse(localStorage.getItem(DEFINED_CHAT_GROUPS_KEY)!);
    expect(saved).toEqual([{ id: expect.stringMatching(/^g_[a-z0-9]{10}$/), name: 'Docs' }]);
    renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'docs' })] });
    expect(JSON.parse(localStorage.getItem(DEFINED_CHAT_GROUPS_KEY)!)).toEqual(saved);
  });


  it('shows a defined group with no chats as an empty bucket above the groups, with a hint', () => {
    define('Frontend fixes');
    const html = renderSidebar({ sessions: [agentSummary('a')] });
    expect(html).toMatch(/data-chat-group-empty="Frontend fixes"[^]*Drag chats here[^]*data-agent-group=/);
    expect(html).not.toContain('data-chat-group-cluster');
  });

  it('shows no empty bucket once a chat, even an archived one, is in the group', () => {
    define('Docs', 'Old');
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'docs' }), agentSummary('b', { archivedAt: 5, chatGroup: 'Old' })] });
    expect(html).not.toContain('data-chat-group-empty');
    expect(html).toContain('data-chat-group-cluster="Docs"');
  });

  it('lists empty buckets only under Agents', () => {
    define('Docs');
    expect(renderSidebar({ shows: 'terminals' })).not.toContain('data-chat-group-empty');
  });

  it('offers the group menu exactly Edit group and Delete', () => {
    const html = renderToStaticMarkup(<ChatGroupManageMenu name="Docs" color={0} onSave={() => {}} onDelete={() => {}} />);
    expect([...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(['Edit group', 'Delete']);
    expect(html).not.toContain('Rename');
    expect(html).not.toContain('Colour');
  });

  it('edits a group in the one form: name and colour prefilled, Save enabled at once', () => {
    const html = renderToStaticMarkup(<NewChatGroupForm initialName="Docs" initialColor={2} submitLabel="Save" onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('value="Docs"');
    expect([...html.matchAll(/role="radio" aria-checked="(true|false)" aria-label="([A-Za-z]+)"/g)].filter((m) => m[1] === 'true').map((m) => m[2])).toEqual(['Coral']);
    expect(html.match(/tabindex="0"/g)).toHaveLength(6);
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled)[^>]*data-new-chat-group-create[^>]*>Save<\/button>/);
    expect(html).not.toContain('Create group');
  });

  it('saves the name and the colour together, in one update', () => {
    const src = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
    expect(src).toContain('onSave={(typed, color) => editGroup(groupMenu.group, typed, color)}');
    expect(src).toContain('renameChatGroupPlan(definedGroups, sessions, from, typed, undefined, color)');
    expect(src).not.toContain('colorGroup');
  });

  it('offers the six colours as labelled radios, one checked, each in the tab order', () => {
    const html = renderToStaticMarkup(<ChatGroupSwatches value={2} onPreset={() => {}} />);
    expect(html).toContain('role="radiogroup" aria-label="Group colour"');
    expect([...html.matchAll(/role="radio" aria-checked="(true|false)" aria-label="([A-Za-z]+)"/g)].map((m) => [m[2], m[1]]))
      .toEqual([['Teal', 'false'], ['Amber', 'false'], ['Coral', 'true'], ['Blue', 'false'], ['Pink', 'false'], ['Lime', 'false']]);
    expect(html.match(/tabindex="0"/g)).toHaveLength(6);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  // Keyboard: Tab steps through every colour in turn before it moves on to the rainbow tile.
  it('puts every colour in the tab order, presets then saved colours, then the rainbow tile', () => {
    const html = renderToStaticMarkup(<ChatGroupSwatches value={null} saved={['#ab12cd', '#00ff7f']} onPreset={() => {}} onToggleOpen={() => {}} />);
    const order = [...html.matchAll(/<button[^>]*?(?:aria-label="([^"]+)"[^>]*?tabindex="(-?\d)"|tabindex="(-?\d)"[^>]*?aria-label="([^"]+)")|<button[^>]*?aria-label="(Custom colour…)"/g)]
      .map((m) => ({ label: m[1] ?? m[4] ?? m[5], tab: m[2] ?? m[3] ?? '0' }));
    const stops = order.filter((o) => o.tab === '0').map((o) => o.label);
    expect(stops).toEqual(['Teal', 'Amber', 'Coral', 'Blue', 'Pink', 'Lime', 'Custom colour #ab12cd', 'Custom colour #00ff7f', 'Custom colour…']);
    // The small remove buttons stay out of the way of Tab.
    expect(order.filter((o) => o.label?.startsWith('Remove')).every((o) => o.tab === '-1')).toBe(true);
  });

  it('moves the arrow keys to the next swatch, wrapping', () => {
    expect(nextSwatchIndex(5, 1, 6)).toBe(0);
    expect(nextSwatchIndex(0, -1, 6)).toBe(5);
    expect(nextSwatchIndex(6, 1, 8)).toBe(7);
    expect(nextSwatchIndex(0, 1, 0)).toBe(0);
  });

  it('leaves the arrow keys and Tab to the swatches inside the + menu: its own handlers do not take them', () => {
    const src = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
    const menu = src.slice(src.indexOf('data-new-agent-menu'), src.indexOf('data-new-agent-menu') + 900);
    expect(menu).not.toMatch(/onKeyDown|ArrowDown|ArrowUp|'Tab'/);
  });

  it('makes a new group with an optional name and a colour that starts unpicked, Create disabled', () => {
    const html = renderToStaticMarkup(<NewChatGroupForm onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('aria-label="Group name (optional)"');
    expect(html).toContain('data-chat-group-color-picker');
    expect(html.match(/role="radio" aria-checked="false"/g)).toHaveLength(6);
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-new-chat-group-create/);
  });

  it('renders a custom colour on the border, and on the dot of an unboxed card', () => {
    localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify([{ name: 'Docs', color: '#AB12CD' }, { name: 'Empty', color: '#00ff7f' }]));
    const html = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'Docs' })] });
    expect(html).toMatch(/data-chat-group-cluster="Docs"[^>]*style="border:1px solid color-mix\(in srgb, #ab12cd 55%, transparent\)"/);
    expect(html).toMatch(/data-chat-group-empty="Empty"[^>]*style="border:1px solid color-mix\(in srgb, #00ff7f 55%, transparent\)"/);
    localStorage.setItem(AGENT_PANEL_VIEW_KEY, JSON.stringify({ ...DEFAULT_AGENT_PANEL_VIEW, clusterChatGroups: false }));
    const unboxed = renderSidebar({ sessions: [agentSummary('a', { chatGroup: 'Docs' })] });
    expect(unboxed).toMatch(/aria-label="Group: Docs"[^>]*style="background:#ab12cd"/);
  });

  it('starts collapsed: the presets, saved colours and a rainbow tile, with no wheel', () => {
    localStorage.setItem(SAVED_CUSTOM_COLORS_KEY, JSON.stringify(['#AB12CD', '#00ff7f']));
    const html = renderToStaticMarkup(<ChatGroupColorPicker value="#ab12cd" onChange={() => {}} />);
    expect(html.match(/role="radio"/g)).toHaveLength(8);
    expect(html).toMatch(/aria-checked="true" aria-label="Custom colour #ab12cd"/);
    expect(html).toMatch(/aria-checked="false" aria-label="Custom colour #00ff7f"/);
    // The rainbow tile is last, closed, and named.
    expect(html).toMatch(/aria-label="Custom colour…" title="Custom colour…" aria-expanded="false"[^>]*data-chat-group-custom[^>]*style="background:conic-gradient\(/);
    expect(html.lastIndexOf('data-chat-group-custom')).toBeGreaterThan(html.lastIndexOf('data-chat-group-saved'));
    for (const absent of ['role="slider"', 'type="range"', 'Group colour hex']) expect(html).not.toContain(absent);
  });

  it('shows the colour in use as a swatch even when it was never saved, and a preset as the checked preset', () => {
    expect(renderToStaticMarkup(<ChatGroupColorPicker value="#123456" onChange={() => {}} />)).toMatch(/aria-checked="true" aria-label="Custom colour #123456"/);
    expect(renderToStaticMarkup(<ChatGroupColorPicker value={4} onChange={() => {}} />)).toMatch(/aria-checked="true" aria-label="Pink"/);
  });

  it('offers a small remove button on a saved colour only', () => {
    localStorage.setItem(SAVED_CUSTOM_COLORS_KEY, JSON.stringify(['#00ff7f']));
    const html = renderToStaticMarkup(<ChatGroupColorPicker value="#123456" onChange={() => {}} />);
    expect(html).toContain('aria-label="Remove custom colour #00ff7f"');
    expect(html).not.toContain('aria-label="Remove custom colour #123456"');
  });

  it('expands to the wheel, a vertical brightness bar, and a hex field with no preview dot, without accent tabs', () => {
    const html = renderToStaticMarkup(<ChatGroupColorPicker value="#ab12cd" onChange={() => {}} defaultOpen />);
    expect(html).toMatch(/aria-expanded="true"[^>]*data-chat-group-custom/);
    expect(html).toContain('role="slider" tabindex="0" aria-label="Group colour wheel"');
    expect(html).toMatch(/role="slider" tabindex="0" aria-orientation="vertical" aria-label="Group colour wheel lightness"/);
    expect(html).not.toContain('type="range"');
    expect(html).toMatch(/aria-label="Group colour hex"[^>]*value="#ab12cd"/);
    expect(html).not.toContain('data-chat-group-preview');
    expect(html).not.toMatch(/Accent|Secondary|Reset/);
    // Panel is the rainbow tile's aria-controls target.
    expect(html.match(/aria-controls="([^"]+)"/)![1]).toBe(html.match(/id="([^"]+)" class="chat-group-color-open/)![1]);
  });

  it('stands the brightness bar centred in the room right of the wheel, with a solid thin handle', () => {
    const html = renderToStaticMarkup(<ChatGroupColorPicker value="#ab12cd" onChange={() => {}} defaultOpen />);
    expect(html).toContain('class="flex w-full flex-row items-stretch"');
    expect(html).toMatch(/class="flex flex-1 justify-center" data-lightness-column="true"><div role="slider"[^>]*aria-orientation="vertical"/);
    const thumb = html.match(/<span aria-hidden="true" data-lightness-thumb="true" class="([^"]+)"/)![1];
    expect(thumb.split(' ')).toEqual(expect.arrayContaining(['h-1', 'w-4', 'bg-white']));
    expect(thumb).not.toContain('border');
  });

  it('has no Save button: the open picker is the wheel, the bar and the hex field only', () => {
    const html = renderToStaticMarkup(<ChatGroupColorPicker value="#ab12cd" onChange={() => {}} defaultOpen />);
    expect(html).not.toContain('data-chat-group-color-save');
    expect(html).not.toMatch(/>Save</);
  });

  it('keeps a custom colour as a swatch once chosen for a group, and skips presets and bad values', () => {
    rememberChosenColor('#AB12CD');
    rememberChosenColor(2);
    rememberChosenColor(null);
    rememberChosenColor('nope');
    expect(JSON.parse(localStorage.getItem(SAVED_CUSTOM_COLORS_KEY)!)).toEqual(['#ab12cd']);
  });

  it('creates a group with no Cancel button, Create waiting for a colour', () => {
    const html = renderToStaticMarkup(<NewChatGroupForm onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).not.toMatch(/>Cancel</);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-new-chat-group-create/);
  });

  it('puts the action beside the hex field when the wheel is open, and on its own row when closed', () => {
    const action = <button type="submit" data-new-chat-group-create>Create group</button>;
    const open = renderToStaticMarkup(<ChatGroupColorPicker value="#79a83a" onChange={() => {}} defaultOpen action={action} />);
    expect(open).toMatch(/aria-label="Group colour hex"[^>]*\/><div class="ms-auto shrink-0" data-chat-group-color-action="true"><button[^>]*data-new-chat-group-create/);
    expect(open.match(/data-new-chat-group-create/g)).toHaveLength(1);
    const closed = renderToStaticMarkup(<ChatGroupColorPicker value="#79a83a" onChange={() => {}} action={action} />);
    expect(closed).toMatch(/<div class="flex justify-end" data-chat-group-color-action="true"><button[^>]*data-new-chat-group-create/);
    expect(closed).not.toContain('Group colour hex');
  });

  it("leaves the wheel's own default, as the theme settings use it, a horizontal range under the disc", () => {
    const html = renderToStaticMarkup(<ColorWheel value="#336699" onChange={() => {}} label="Accent" />);
    expect(html).toContain('type="range"');
    expect(html).not.toContain('aria-orientation');
    expect(html).toContain('class="flex flex-col items-center gap-2" style="width:132px"');
  });

  it('adds a row to the create menu in the same style as the kinds', () => {
    const html = renderToStaticMarkup(<CreateMenuRows onCreate={() => {}}><CreateRow label="New group" icon={null} onClick={() => {}} /></CreateMenuRows>);
    expect(html).toContain('aria-label="New group"');
    expect(html.match(/class="create-row /g)).toHaveLength(5);
    expect(renderToStaticMarkup(<CreateMenuRows onCreate={() => {}} />)).not.toContain('New group');
  });
});
