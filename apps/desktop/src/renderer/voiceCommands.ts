import type { View } from './store.js';

export type VoiceIntent = { kind: 'dictation'; text: string } | { kind: 'new-session' } | { kind: 'complete-session' } | { kind: 'navigate'; view: View } | { kind: 'unknown'; text: string };

/** Only an explicit leading address can turn dictation into an app action. */
export function parseVoiceIntent(text: string): VoiceIntent {
  const trimmed = text.trim();
  // Recognizers spell the wake word as they hear it: Nekko, Neko, Neco, Necko.
  const address = /^ne[ck]k?o\b[\s,:.!-]*/i.exec(trimmed);
  if (!address) return { kind: 'dictation', text: trimmed };
  const command = trimmed.slice(address[0].length).toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(?:create|start|open)(?: a)? new (?:session|chat|agent)$/.test(command)) return { kind: 'new-session' };
  if (/^(?:complete|finish|archive) (?:this|the current) (?:session|chat|agent)$/.test(command)) return { kind: 'complete-session' };
  const target = command.replace(/^(?:go to|open|show|switch to) (?:the )?/, '').replace(/ (?:tab|page)$/, '');
  const views: Record<string, View> = { 'agent board': 'command', 'command center': 'command', agents: 'chat', models: 'models', 'model providers': 'models', 'model server': 'modelserver', settings: 'settings', connectors: 'connectors', memory: 'memory', skills: 'skills', training: 'training', workflows: 'workflows', design: 'design', artifacts: 'artifacts' };
  if (target !== command && views[target]) return { kind: 'navigate', view: views[target] };
  return { kind: 'unknown', text: trimmed };
}
