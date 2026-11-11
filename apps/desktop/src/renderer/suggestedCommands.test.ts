import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@nekko-agent/shared';
import { commandToRun, isShellLang, pickChatTerminal, sharedOutputMessage, terminalText } from './suggestedCommands.js';

describe('isShellLang', () => {
  it('knows the shell fences and nothing else', () => {
    for (const lang of ['bash', 'sh', 'Shell', 'zsh', 'fish', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'console', 'shell-session', 'terminal', ' bash title="setup" '])
      expect(isShellLang(lang)).toBe(true);
    for (const lang of ['', 'js', 'ts', 'python', 'json', 'text', 'diff', 'mermaid', 'bashful'])
      expect(isShellLang(lang)).toBe(false);
  });
});

describe('commandToRun', () => {
  it('runs a script block as written, lines joined with Enter', () => {
    expect(commandToRun('bash', 'npm install\nnpm test\n')).toBe('npm install\rnpm test');
  });

  it('is null for code that is not a shell, and for an empty block', () => {
    expect(commandToRun('ts', 'const a = 1')).toBeNull();
    expect(commandToRun('bash', '\n  \n')).toBeNull();
  });

  it('drops a $ or PS> prompt a model put in front of a script line', () => {
    expect(commandToRun('sh', '$ cd app\n$ npm ci')).toBe('cd app\rnpm ci');
    expect(commandToRun('powershell', 'PS> Get-ChildItem\nPS C:\\repo> git status')).toBe('Get-ChildItem\rgit status');
    expect(commandToRun('cmd', 'C:\\repo> dir')).toBe('dir');
  });

  it('keeps script comments and redirections, which the shell understands', () => {
    expect(commandToRun('bash', '# install\nnpm ci > log.txt')).toBe('# install\rnpm ci > log.txt');
  });

  it('keeps blank lines inside a block but trims them from its ends', () => {
    expect(commandToRun('bash', '\n\ncd app\n\nnpm ci   \n\n')).toBe('cd app\r\rnpm ci');
  });

  it('runs only the prompt lines of a session block, without the prompt', () => {
    const block = '$ npm run build\n\n> app@1.0.0 build\n> vite build\n\nbuilt in 2s\n$ npm test\n';
    expect(commandToRun('console', block)).toBe('npm run build\rnpm test');
  });

  it('follows a session line onto its continuation lines', () => {
    const block = '$ docker run \\\n>   -p 80:80 \\\n    nginx\nabc123\n$ echo done';
    expect(commandToRun('console', block)).toBe('docker run \\\r  -p 80:80 \\\r    nginx\recho done');
  });

  it('never runs a # comment or npm output line from a session block', () => {
    expect(commandToRun('console', '# set up\n$ make')).toBe('make');
    expect(commandToRun('shell-session', '> app@1 build\n$ ls')).toBe('ls');
  });

  it('reads a session block with no prompts as plain commands, minus output and notes', () => {
    expect(commandToRun('console', 'npm install\n> added 5 packages\n# then\nnpm start')).toBe('npm install\rnpm start');
  });

  it('reads PowerShell session prompts', () => {
    expect(commandToRun('pwsh-session', 'PS C:\\code> npm ci\nadded 1 package\nPS C:\\code> npm test')).toBe('npm ci\rnpm test');
  });

  it('normalizes Windows line ends', () => {
    expect(commandToRun('bash', 'a\r\nb\r\n')).toBe('a\rb');
  });
});

describe('pickChatTerminal', () => {
  const term = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
    id, title: id, cwd: '/', shell: 'bash', createdAt: 1, running: true, sessionId: 's1', ...extra,
  });

  it('finds a running shell opened for the chat, never the command log or another chat', () => {
    const list = [
      term('agent_s1'),
      term('log', { agentSessionId: 's1' }),
      term('other', { sessionId: 's2' }),
      term('dead', { running: false, createdAt: 9 }),
      term('mine', { createdAt: 2 }),
    ];
    expect(pickChatTerminal(list, 's1')?.id).toBe('mine');
    expect(pickChatTerminal(list, 's3')).toBeUndefined();
  });

  it('prefers the terminal Run used last, else the newest', () => {
    const list = [term('old', { createdAt: 1 }), term('new', { createdAt: 5 })];
    expect(pickChatTerminal(list, 's1')?.id).toBe('new');
    expect(pickChatTerminal(list, 's1', 'old')?.id).toBe('old');
    expect(pickChatTerminal(list, 's1', 'gone')?.id).toBe('new');
  });
});

describe('terminalText', () => {
  it('drops escape sequences and keeps what an overwrite left on screen', () => {
    const raw = '\x1b]0;title\x07\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\r\n\x1b[?25hdone\r\n';
    expect(terminalText(raw)).toBe('ok\n100%\ndone');
  });

  it('folds runs of blank lines and keeps only the last lines', () => {
    expect(terminalText('a\n\n\n\nb\n\n')).toBe('a\n\nb');
    expect(terminalText('1\n2\n3\n4', 2)).toBe('3\n4');
  });
});

describe('sharedOutputMessage', () => {
  it('fences the output, with a longer fence when the output holds one', () => {
    expect(sharedOutputMessage('ok')).toBe('Output from my terminal:\n\n```text\nok\n```');
    expect(sharedOutputMessage('```js\nx\n```')).toContain('````text');
  });
});
