import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { NekkoApi, Session, AppSettings } from '@nekko-agent/shared';
import { decideApproval, offersToolScope } from './approval-decision.js';
import { ApprovalBar } from './ApprovalBar.js';

function api() {
  return {
    setSessionOptions: vi.fn<NekkoApi['setSessionOptions']>().mockResolvedValue({ id: 's', mode: 'yolo' } as Session),
    updateSettings: vi.fn<NekkoApi['updateSettings']>().mockResolvedValue({ defaultChatMode: 'yolo' } as AppSettings),
    approveTool: vi.fn<NekkoApi['approveTool']>().mockResolvedValue(undefined),
  };
}

describe('approval decisions', () => {
  it.each([true, false])('keeps a one-time decision (%s) scoped to the call', async (approved) => {
    const client = api();
    await decideApproval(client, 's', 'c', approved);
    expect(client.approveTool).toHaveBeenCalledWith('s', 'c', approved);
    expect(client.setSessionOptions).not.toHaveBeenCalled();
    expect(client.updateSettings).not.toHaveBeenCalled();
  });
  it('saves session-only policy before releasing the call, without changing settings', async () => {
    const client = api();
    await decideApproval(client, 's', 'c', true, 'session');
    expect(client.setSessionOptions).toHaveBeenCalledWith('s', { mode: 'yolo' });
    expect(client.updateSettings).not.toHaveBeenCalled();
    expect(client.setSessionOptions.mock.invocationCallOrder[0]).toBeLessThan(client.approveTool.mock.invocationCallOrder[0]);
  });
  it('saves the default and session before releasing an always-allow call', async () => {
    const client = api();
    const result = await decideApproval(client, 's', 'c', true, 'always');
    expect(client.updateSettings).toHaveBeenCalledWith({ defaultChatMode: 'yolo' });
    expect(result.settings?.defaultChatMode).toBe('yolo');
    expect(client.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(client.approveTool.mock.invocationCallOrder[0]);
  });
  it('does not approve if saving policy fails', async () => {
    const client = api();
    client.updateSettings.mockRejectedValue(new Error('Save failed'));
    await expect(decideApproval(client, 's', 'c', true, 'always')).rejects.toThrow('Save failed');
    expect(client.approveTool).not.toHaveBeenCalled();
  });
  it('does not approve when the session no longer exists', async () => {
    const client = api();
    client.setSessionOptions.mockResolvedValue(null);
    await expect(decideApproval(client, 's', 'c', true, 'session')).rejects.toThrow('Could not update');
    expect(client.approveTool).not.toHaveBeenCalled();
  });
  it('always allows one MCP tool in this chat, saved before the call is released, without YOLO', async () => {
    const client = api();
    await decideApproval(client, 's', 'c', true, 'tool', { name: 'mcp__srv__post', allowed: ['mcp__srv__read', 'mcp__srv__post'] });
    expect(client.setSessionOptions).toHaveBeenCalledWith('s', { allowedMcpTools: ['mcp__srv__read', 'mcp__srv__post'] });
    expect(client.setSessionOptions.mock.invocationCallOrder[0]).toBeLessThan(client.approveTool.mock.invocationCallOrder[0]);
    expect(client.approveTool).toHaveBeenCalledWith('s', 'c', true);
    expect(client.updateSettings).not.toHaveBeenCalled();
  });
  it('offers the tool scope only for MCP tools, and refuses it otherwise', async () => {
    expect(offersToolScope('mcp__srv__post')).toBe(true);
    expect(offersToolScope('bash')).toBe(false);
    const client = api();
    await expect(decideApproval(client, 's', 'c', true, 'tool', { name: 'bash' })).rejects.toThrow('Only an MCP tool');
    expect(client.approveTool).not.toHaveBeenCalled();
  });
  it('does not approve when the allowed tool cannot be saved', async () => {
    const client = api();
    client.setSessionOptions.mockResolvedValue(null);
    await expect(decideApproval(client, 's', 'c', true, 'tool', { name: 'mcp__srv__post' })).rejects.toThrow('Could not save');
    expect(client.approveTool).not.toHaveBeenCalled();
  });
  it('adds "Always allow this tool" for an MCP call only', () => {
    const html = renderToStaticMarkup(createElement(ApprovalBar, {
      approval: { call: { id: 'c', name: 'mcp__srv__post', input: {} }, reason: 'Call mcp__srv__post?', severity: 'high' },
      onDecide: async () => {},
    }));
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html).toContain('Always allow this tool');
  });
  it('renders all four compact, clearly scoped actions', () => {
    const html = renderToStaticMarkup(createElement(ApprovalBar, {
      approval: { call: { id: 'c', name: 'capture', input: { action: 'list' } }, reason: 'Window capture', severity: 'high' },
      onDecide: async () => {},
    }));
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).toContain('Allow all this session');
    expect(html).toContain('Always allow all');
    expect(html.match(/h-7/g)).toHaveLength(4);
    expect(html).not.toContain('Always allow this tool');
  });
});
