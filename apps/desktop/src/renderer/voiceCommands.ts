import type { View } from './store.js';
import type { GoTarget } from './displays.js';

export type VoiceIntent = { kind: 'dictation'; text: string } | { kind: 'new-session' } | { kind: 'complete-session' } | { kind: 'navigate'; view: View } | { kind: 'go'; target: GoTarget } | { kind: 'unknown'; text: string };

/** Only an explicit leading address can turn dictation into an app action. */
export function parseVoiceIntent(text: string): VoiceIntent {
  const trimmed = text.trim();
  // Recognizers spell the wake word as they hear it: Nekko, Neko, Neco, Necko.
  const address = /^ne[ck]k?o\b[\s,:.!-]*/i.exec(trimmed);
  if (!address) return { kind: 'dictation', text: trimmed };
  const command = trimmed.slice(address[0].length).toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(?:create|start|open)(?: a)? new (?:session|chat|agent)$/.test(command)) return { kind: 'new-session' };
  if (/^(?:complete|finish|archive) (?:this|the current) (?:session|chat|agent)$/.test(command)) return { kind: 'complete-session' };
  const go = parseGo(command);
  if (go) return { kind: 'go', target: go };
  const target = command.replace(/^(?:go to|open|show|switch to) (?:the )?/, '').replace(/ (?:tab|page)$/, '');
  const views: Record<string, View> = { 'agent board': 'command', 'command center': 'command', agents: 'chat', models: 'models', 'model providers': 'models', 'model server': 'modelserver', settings: 'settings', connectors: 'connectors', memory: 'memory', skills: 'skills', training: 'training', workflows: 'workflows', design: 'design', artifacts: 'artifacts' };
  if (target !== command && views[target]) return { kind: 'navigate', view: views[target] };
  return { kind: 'unknown', text: trimmed };
}

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
