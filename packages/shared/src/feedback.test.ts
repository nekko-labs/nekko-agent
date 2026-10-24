import { describe, expect, it } from 'vitest';
import { agentPrompt, appInfoLine } from './feedback.js';

describe('feedback', () => {
  it('names the app in one line, skipping what is unknown', () => {
    expect(appInfoLine({ app: 'desktop', version: '1.4.0', os: 'macOS', osVersion: '15.1', arch: 'aarch64' }))
      .toBe('App: Nekko Agent 1.4.0 (desktop, macOS 15.1, aarch64)');
    expect(appInfoLine({ app: 'web', version: '1.4.0', os: 'Ubuntu' })).toBe('App: Nekko Agent 1.4.0 (web, Ubuntu)');
  });

  it('asks the agent to check with the person before filing, and ends with the app line', () => {
    const prompt = agentPrompt({ app: 'ios', version: '1.4.0', os: 'iOS', osVersion: '18.1', arch: 'arm64' });
    expect(prompt).toContain('File the issue only after I approve');
    expect(prompt).toContain('Leave out anything personal');
    expect(prompt.split('\n').at(-1)).toBe('App: Nekko Agent 1.4.0 (ios, iOS 18.1, arm64)');
    expect(agentPrompt(null)).not.toContain('App:');
  });
});
