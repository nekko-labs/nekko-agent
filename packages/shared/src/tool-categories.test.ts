import { describe, expect, it } from 'vitest';
import { groupToolsByCategory, toolAllowedOffline, toolCategory } from './tool-categories.js';

describe('tool categories', () => {
  it('keeps local tools offline and drops networked ones', () => {
    for (const t of ['read_file', 'write_file', 'grep', 'bash', 'start_process', 'capture', 'update_plan', 'ask_user']) expect(toolAllowedOffline(t)).toBe(true);
    for (const t of ['fetch_url', 'browser', 'spawn_agent', 'delegation_targets', 'agent_watch', 'decide', 'mcp__srv__x']) expect(toolAllowedOffline(t)).toBe(false);
  });
  it('refuses an unclassified tool offline while listing it under Agent', () => {
    expect(toolCategory('web_search')).toBe('agent');
    expect(toolAllowedOffline('web_search')).toBe(false);
  });
  it('groups in menu order and drops empty groups', () => {
    const groups = groupToolsByCategory([{ name: 'browser' }, { name: 'grep' }, { name: 'mcp__a__b' }]);
    expect(groups.map((g) => g.category.id)).toEqual(['files', 'online', 'mcp']);
  });
});
