import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
const wall = readFileSync(new URL('./CommandWall.tsx', import.meta.url), 'utf8');

describe('focus mode clean start', () => {
  it('is asked for by the focused wall chat only', () => {
    expect(wall).toContain("cleanStart={focusedChat}");
  });
  it('lasts only while the chat is empty and nothing needs the user', () => {
    expect(pane).toMatch(/const cleanStart = cleanStartWanted && surface === 'full' && !readOnly && welcomeState\.welcome && hasProvider && !welcomeState\.modelChoice && !imageMode && !!session && !question && !approval;/);
  });
  it('hides the header, transcript, footer and monitor while on', () => {
    expect(pane).toContain("surface !== 'composer' && !cleanStart && (\n        <ChatHeader");
    expect(pane).toContain("surface !== 'composer' && !cleanStart && (\n        <div className=\"relative flex min-h-0 w-full flex-1\">");
    expect(pane).toContain('{!cleanStart && <div className={surface === \'composer\'');
    expect(pane).toContain("planRailOpen && !cleanStart");
  });
});
