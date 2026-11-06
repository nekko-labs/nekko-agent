import { describe, expect, it } from 'vitest';
import { SIMPLE_ITEMS, agentMonitorRelevant, localModelHost, localModelRunning, parseSimpleChoices, simpleAreas, simpleOptions, simpleShown, simpleVisibility } from './simple-mode.js';

describe('simple mode catalogue', () => {
  it('has unique ids', () => {
    expect(new Set(SIMPLE_ITEMS.map((i) => i.id)).size).toBe(SIMPLE_ITEMS.length);
  });

  it('shows only the everyday controls in Simple when nothing is going on', () => {
    const shown = SIMPLE_ITEMS.filter((i) => simpleShown(i.id, false)).map((i) => i.id);
    expect(shown).toEqual(['model', 'effort', 'asks', 'context', 'suggest']);
  });

  it('shows every control in Expert except what waits for something', () => {
    const off = SIMPLE_ITEMS.filter((i) => !simpleShown(i.id, true)).map((i) => i.id);
    expect(off).toEqual(['changes', 'hardware', 'computers', 'pr-status', 'ph-monitors']);
    const all = { localModel: true, changes: true, pr: true, agents: true, computers: true };
    expect(SIMPLE_ITEMS.every((i) => simpleShown(i.id, true, {}, all))).toBe(true);
  });

  it('applies the three choices in each mode', () => {
    expect(simpleShown('cost', false, { cost: 'show' })).toBe(true);
    expect(simpleShown('model', false, { model: 'expert' })).toBe(false);
    expect(simpleShown('model', true, { model: 'expert' })).toBe(true);
    expect(simpleShown('effort', true, { effort: 'hide' })).toBe(false);
  });

  it('keeps monitors off in both modes until a local model runs', () => {
    for (const id of ['hardware', 'ph-monitors']) for (const expert of [false, true]) {
      expect(simpleShown(id, expert)).toBe(false);
      expect(simpleShown(id, expert, {}, { localModel: true })).toBe(true);
    }
    expect(simpleShown('stats', false, {}, { localModel: true })).toBe(false);
  });

  it('lets Show pin a monitor on and Hide keep it off, whatever is running', () => {
    expect(simpleShown('hardware', false, { hardware: 'show' })).toBe(true);
    expect(simpleShown('hardware', true, { hardware: 'show' })).toBe(true);
    expect(simpleShown('hardware', false, { hardware: 'hide' }, { localModel: true })).toBe(false);
  });

  it('shows Changes only with changed files, in both modes', () => {
    for (const expert of [false, true]) {
      expect(simpleShown('changes', expert)).toBe(false);
      expect(simpleShown('changes', expert, {}, { changes: true })).toBe(true);
    }
    expect(simpleShown('changes', false, { changes: 'expert' }, { changes: true })).toBe(false);
    expect(simpleShown('changes', true, { changes: 'hide' }, { changes: true })).toBe(false);
  });

  it('shows PR status only with a pull request, and keeps the rest of git for Expert', () => {
    expect(simpleShown('pr-status', false)).toBe(false);
    expect(simpleShown('pr-status', false, {}, { pr: true })).toBe(true);
    expect(simpleShown('ph-git', false, {}, { pr: true })).toBe(false);
    expect(simpleShown('ph-git', true)).toBe(true);
  });

  it('shows the Agent Monitor in Simple only while agents work, and always in Expert', () => {
    expect(simpleShown('agent-monitor', false)).toBe(false);
    expect(simpleShown('agent-monitor', false, {}, { agents: true })).toBe(true);
    expect(simpleShown('agent-monitor', true)).toBe(true);
    expect(simpleShown('agent-monitor', false, { 'agent-monitor': 'show' })).toBe(true);
    expect(simpleShown('agent-monitor', true, { 'agent-monitor': 'hide' }, { agents: true })).toBe(false);
  });

  it('says nothing about computers until one is connected', () => {
    for (const expert of [false, true]) {
      expect(simpleShown('computers', expert)).toBe(false);
      expect(simpleShown('computers', expert, {}, { computers: true })).toBe(true);
    }
    expect(simpleShown('computers', true, { computers: 'hide' }, { computers: true })).toBe(false);
  });

  it('counts a local model on a connected computer', () => {
    const idle = { running: true, resident: [] };
    expect(localModelRunning(idle, [idle, null])).toBe(false);
    expect(localModelRunning(null, [idle, { running: true, resident: [{}] }])).toBe(true);
    expect(localModelHost(null, [idle, { running: true, resident: [{}] }])).toBe(1);
    expect(localModelHost({ running: true, resident: [{}] }, [{ running: true, resident: [{}] }])).toBe('here');
    expect(localModelHost(idle, [idle, null])).toBeNull();
  });

  it('reads a local model only from a running engine that holds one', () => {
    expect(localModelRunning(null)).toBe(false);
    expect(localModelRunning({ running: true, resident: [] })).toBe(false);
    expect(localModelRunning({ running: false, resident: [{}] })).toBe(false);
    expect(localModelRunning({ running: true, resident: [{}] })).toBe(true);
  });

  it('calls the Agent Monitor relevant for running sub-agents or background tasks only', () => {
    expect(agentMonitorRelevant({ runningSubAgents: 0, backgroundTasks: 0 })).toBe(false);
    expect(agentMonitorRelevant({ runningSubAgents: 1, backgroundTasks: 0 })).toBe(true);
    expect(agentMonitorRelevant({ runningSubAgents: 0, backgroundTasks: 2 })).toBe(true);
  });

  it('offers When running in place of Expert only on monitors', () => {
    expect(simpleOptions(SIMPLE_ITEMS.find((i) => i.id === 'hardware')!)).toEqual(['auto', 'show', 'hide']);
    expect(simpleOptions(SIMPLE_ITEMS.find((i) => i.id === 'cost')!)).toEqual(['show', 'expert', 'hide']);
    expect(parseSimpleChoices({ hardware: 'expert', cost: 'auto' })).toEqual({});
    expect(parseSimpleChoices({ hardware: 'show' })).toEqual({ hardware: 'show' });
  });

  it('leaves the desktop Monitors panel to its own checked monitors', () => {
    expect(SIMPLE_ITEMS.some((i) => i.id.startsWith('mon-'))).toBe(false);
    expect(parseSimpleChoices({ 'mon-hw': 'hide', 'mon-budget': 'show' })).toEqual({});
  });

  it('shows ids it does not know', () => {
    expect(simpleVisibility('nope', { nope: 'hide' })).toBe('show');
    expect(simpleShown('nope', false)).toBe(true);
  });

  it('parses saved choices defensively', () => {
    expect(parseSimpleChoices('{"effort":"expert","model":"show","bad":"hide","stats":"maybe"}')).toEqual({ effort: 'expert' });
    expect(parseSimpleChoices('not json')).toEqual({});
    expect(parseSimpleChoices(null)).toEqual({});
    expect(parseSimpleChoices([])).toEqual({});
    expect(parseSimpleChoices({ context: 'hide' })).toEqual({ context: 'hide' });
  });

  it('groups each platform by area without the other platform', () => {
    const phone = simpleAreas('phone');
    expect(phone.flatMap((a) => a.items).some((i) => i.id === 'logs')).toBe(false);
    expect(phone.flatMap((a) => a.items).some((i) => i.id === 'ph-monitors')).toBe(true);
    expect(simpleAreas('desktop')[0]).toMatchObject({ area: 'Chat · header' });
  });
});
