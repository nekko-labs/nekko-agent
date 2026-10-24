import { describe, expect, it } from 'vitest';
import { parseVoiceIntent } from './voiceCommands.js';

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
  it.each([['Nekko go to the model server tab', 'modelserver'], ['Nekko open settings', 'settings'], ['Nekko show agents', 'chat']])('routes %s', (text, view) => {
    expect(parseVoiceIntent(text)).toEqual({ kind: 'navigate', view });
  });
  it('leaves arbitrary and multi-step app commands unexecuted', () => {
    expect(parseVoiceIntent('Nekko go to the model server tab and add a new one')).toMatchObject({ kind: 'unknown' });
    expect(parseVoiceIntent('Nekko delete everything')).toMatchObject({ kind: 'unknown' });
  });
});
