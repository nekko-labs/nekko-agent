import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseVoiceIntent, splitVoiceSegments, type VoiceIntent } from './voiceCommands.js';

interface Fixture { cases: Array<{ say: string; intent: VoiceIntent; platforms?: string[] }> }
// The fixture the Swift grammar on iOS runs too.
const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'fixtures', 'voice-commands.json'), 'utf8')) as Fixture;

describe('voice intent', () => {
  it('never treats ordinary dictation as a command', () => {
    expect(parseVoiceIntent('complete this session')).toEqual({ kind: 'dictation', text: 'complete this session' });
    expect(parseVoiceIntent('Tell Nekko to create a new session')).toMatchObject({ kind: 'dictation' });
  });
  it.each(['Nekko, create a new session.', 'Nekko start new chat', 'Nekko open a new agent'])('recognizes new-session command: %s', (text) => {
    expect(parseVoiceIntent(text)).toEqual({ kind: 'new-session' });
  });
  it.each(['Neco, open settings.', 'Neko open settings', 'Necko open settings'])('hears the wake word as recognizers spell it: %s', (text) => {
    expect(parseVoiceIntent(text)).toEqual({ kind: 'navigate', view: 'settings' });
    expect(parseVoiceIntent('Necklace open settings')).toMatchObject({ kind: 'dictation' });
  });
  it('recognizes completion without auto-execution', () => {
    expect(parseVoiceIntent('Nekko complete this session')).toEqual({ kind: 'complete-session' });
  });
  it.each([['Nekko go to the model server tab', 'modelserver'], ['Nekko open settings', 'settings'], ['Nekko show agents', 'command']])('routes %s', (text, view) => {
    expect(parseVoiceIntent(text)).toEqual({ kind: 'navigate', view });
  });
  it('leaves arbitrary and multi-step app commands unexecuted', () => {
    expect(parseVoiceIntent('Nekko go to the model server tab and add a new one')).toMatchObject({ kind: 'unknown' });
    expect(parseVoiceIntent('Nekko delete everything')).toMatchObject({ kind: 'unknown' });
  });
  it('switches desktops and screens by voice', () => {
    expect(parseVoiceIntent('Nekko, switch to desktop 2.')).toEqual({ kind: 'go', target: { kind: 'desktop', n: 2 } });
    expect(parseVoiceIntent('Neko go to desktop to')).toEqual({ kind: 'go', target: { kind: 'desktop', n: 2 } });
    expect(parseVoiceIntent('Nekko next desktop')).toEqual({ kind: 'go', target: { kind: 'desktop', step: 1 } });
    expect(parseVoiceIntent('Nekko switch to the previous space')).toEqual({ kind: 'go', target: { kind: 'desktop', step: -1 } });
    expect(parseVoiceIntent('Nekko show screen three')).toEqual({ kind: 'go', target: { kind: 'screen', n: 3 } });
    expect(parseVoiceIntent('switch to desktop 2')).toEqual({ kind: 'dictation', text: 'switch to desktop 2' });
    expect(parseVoiceIntent('Nekko switch to desktop purple').kind).toBe('unknown');
  });
});

describe('shared fixture', () => {
  const desktop = fixture.cases.filter((c) => !c.platforms || c.platforms.includes('desktop'));
  it.each(desktop.map((c) => [c.say, c] as const))('parses: %s', (_say, c) => {
    expect(parseVoiceIntent(c.say)).toEqual(c.intent);
  });
});

describe('splitVoiceSegments', () => {
  it('splits dictation from a command at the sentence end', () => {
    expect(splitVoiceSegments('Fix the login bug. Nekko, send it.')).toEqual([{ kind: 'dictation', text: 'Fix the login bug.' }, { kind: 'send' }]);
  });
  it('only honors the wake word at the start of a piece', () => {
    expect(splitVoiceSegments('Tell Nekko to send it.')).toEqual([{ kind: 'dictation', text: 'Tell Nekko to send it.' }]);
  });
  it('joins consecutive dictation pieces', () => {
    expect(splitVoiceSegments('Fix the bug. Then add a test! Nekko ship it')).toEqual([{ kind: 'dictation', text: 'Fix the bug. Then add a test!' }, { kind: 'ship' }]);
  });
  it('returns nothing for silence', () => {
    expect(splitVoiceSegments('  ')).toEqual([]);
  });
});
