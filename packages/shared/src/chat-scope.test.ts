import { describe, expect, it } from 'vitest';
import { chatConnectors, chatEffort, chatMcpTools } from './chat-scope.js';

describe('chat scope', () => {
  it('lets a chat effort win over the app-wide one', () => {
    expect(chatEffort({}, 'high')).toBe('high');
    expect(chatEffort({ effort: 'low' }, 'high')).toBe('low');
    expect(chatEffort({ effort: null as never }, 'high')).toBe('high');
    expect(chatEffort(undefined, undefined)).toBeUndefined();
  });

  it('drops only the tools of switched-off MCP servers', () => {
    const tools = [{ name: 'mcp__web__get' }, { name: 'mcp__webby__get' }, { name: 'mcp__files__read' }, { name: 'read_file' }];
    expect(chatMcpTools(tools, {})).toBe(tools);
    expect(chatMcpTools(tools, { disabledMcpServers: ['web'] }).map((t) => t.name)).toEqual(['mcp__webby__get', 'mcp__files__read', 'read_file']);
    expect(chatMcpTools(tools, { disabledMcpServers: ['web', 'webby', 'files'] }).map((t) => t.name)).toEqual(['read_file']);
  });

  it('skips switched-off connectors', () => {
    const connectors = [{ kind: 'github' }, { kind: 'slack' }];
    expect(chatConnectors(connectors, null)).toBe(connectors);
    expect(chatConnectors(connectors, { disabledConnectors: ['slack'] })).toEqual([{ kind: 'github' }]);
  });
});
