import type { View } from './store.js';
import type { GoTarget } from './displays.js';

export type VoiceIntent = { kind: 'dictation'; text: string } | { kind: 'new-session' } | { kind: 'complete-session' } | { kind: 'navigate'; view: View } | { kind: 'go'; target: GoTarget } | { kind: 'erase' } | { kind: 'clear' } | { kind: 'send' } | { kind: 'status' } | { kind: 'ship' } | { kind: 'open-chat'; query: string; text: string } | { kind: 'pick'; n: 1 | 2 | 3 } | { kind: 'yes' } | { kind: 'no' } | { kind: 'unknown'; text: string };

/** Only an explicit leading address can turn dictation into an app action. */
export function parseVoiceIntent(text: string): VoiceIntent {
  const trimmed = text.trim();
  // Recognizers spell the wake word as they hear it: Nekko, Neko, Neco, Necko.
  const address = /^ne[ck]k?o\b[\s,:.!?-]*/i.exec(trimmed);
  if (!address) return { kind: 'dictation', text: trimmed };
  const command = trimmed.slice(address[0].length).toLowerCase().replace(/\u2019/g, "'").replace(/[.!?]+$/, '').trim();
  if (/^(?:(?:create|start|open)(?: a)? new (?:session|chat|agent)|new (?:agent )?(?:session|chat|agent)|let's (?:make|start|create) a new (?:change|session|chat|task))$/.test(command)) return { kind: 'new-session' };
  if (/^(?:complete|finish|archive) (?:this|the current) (?:session|chat|agent)$/.test(command)) return { kind: 'complete-session' };
  if (/^(?:erase|scratch|cancel|undo) that$/.test(command)) return { kind: 'erase' };
  if (/^clear(?: everything| all| it)?$/.test(command)) return { kind: 'clear' };
  if (/^send(?: it| that)?$/.test(command)) return { kind: 'send' };
  if (/^ship(?: it| that)?$/.test(command)) return { kind: 'ship' };
  if (/^(?:status|how(?:'s| is) it going|what's the status)$/.test(command)) return { kind: 'status' };
  if (/^(?:yes|yeah|yep|confirm|do it)$/.test(command)) return { kind: 'yes' };
  if (/^(?:no|nope|cancel|never ?mind)$/.test(command)) return { kind: 'no' };
  const pick = /^(?:the )?(first|second|third|one|two|three|1|2|3)(?: one)?$/.exec(command);
  if (pick) return { kind: 'pick', n: PICKS[pick[1]] };
  const go = parseGo(command);
  if (go) return { kind: 'go', target: go };
  const target = command.replace(/^(?:go to|open|show|switch to) (?:the )?/, '').replace(/ (?:tab|page)$/, '');
  if (target !== command && VIEWS[target]) return { kind: 'navigate', view: VIEWS[target] };
  // Views and desktop/screen words keep winning; whatever else follows "open" or "switch to" names a chat.
  const chat = /^open the (?:other )?one (?:about|related to|on) (.+)$/.exec(command) ?? /^(?:switch to|open) (.+)$/.exec(command);
  const query = chat?.[1].replace(/^(?:the|a) /, '');
  if (query && !VIEWS[query.replace(/ (?:tab|page)$/, '')] && !/^(?:desktop|space|screen|monitor|display)/.test(query)) return { kind: 'open-chat', query, text: trimmed };
  return { kind: 'unknown', text: trimmed };
}

const VIEWS: Record<string, View> = { 'agent board': 'command', 'command center': 'command', agents: 'command', models: 'models', 'model providers': 'models', 'model server': 'modelserver', settings: 'settings', connectors: 'connectors', memory: 'memory', skills: 'skills', training: 'training', workflows: 'workflows', design: 'design', artifacts: 'artifacts' };

const PICKS: Record<string, 1 | 2 | 3> = { first: 1, one: 1, 1: 1, second: 2, two: 2, 2: 2, third: 3, three: 3, 3: 3 };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

/**
 * "switch to desktop 2", "go to screen two", "next desktop", "previous space".
 * Desktops are macOS Spaces; screens are monitors. Recognizers hear "two" as "to".
 */
function parseGo(command: string): GoTarget | null {
  const step = /^(?:go to |switch to |move to )?(?:the )?(next|previous|last) (?:desktop|space)$/.exec(command);
  if (step) return { kind: 'desktop', step: step[1] === 'next' ? 1 : -1 };
  const to = /^(?:go to|switch(?: to)?|move to|show) (?:the )?(desktop|space|screen|monitor|display) (\w+)$/.exec(command);
  if (!to) return null;
  const n = /^\d+$/.test(to[2]) ? Number(to[2]) : NUMBER_WORDS[to[2]];
  if (!n || n > 16) return null;
  return /desktop|space/.test(to[1]) ? { kind: 'desktop', n } : { kind: 'screen', n };
}

const WAKE_ONLY = /^ne[ck]k?o\b[\s,:.!?-]*$/i;

/** Splits a transcript at sentence ends and parses each piece; adjacent dictation pieces rejoin. */
export function splitVoiceSegments(text: string): VoiceIntent[] {
  const out: VoiceIntent[] = [];
  const pieces = text.split(/(?<=[.!?])\s+/).filter(p => p.trim());
  for (let i = 0; i < pieces.length; i++) {
    // Recognizers punctuate a pause after the wake word ("Nekko. Send it."): it still addresses the next sentence.
    const piece = WAKE_ONLY.test(pieces[i].trim()) && i + 1 < pieces.length ? `${pieces[i]} ${pieces[++i]}` : pieces[i];
    const intent = parseVoiceIntent(piece);
    const last = out[out.length - 1];
    if (intent.kind === 'dictation' && last?.kind === 'dictation') last.text += ` ${intent.text}`;
    else out.push(intent);
  }
  return out;
}

/**
 * A wake word said alone at the end of a segment ("Nekko." then a pause cuts it):
 * `wake` is carried to the next segment, `rest` is applied now.
 */
export function splitWakeTail(text: string): { rest: string; wake: string } {
  const tail = /(?:^|(?<=[.!?])\s+)(ne[ck]k?o\b[\s,:.!?-]*)$/i.exec(text.trim());
  return tail ? { rest: text.trim().slice(0, tail.index).trim(), wake: tail[1].trim() } : { rest: text.trim(), wake: '' };
}
