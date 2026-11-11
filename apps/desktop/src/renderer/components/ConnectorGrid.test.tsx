import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import { CONNECTOR_CATALOG, type ConnectorKind } from '@nekko-agent/shared';
import { RepoChoice } from './ConnectorRepos.js';
import { ConnectorGrid, ConnectorRow, type SetupStage, canConnect, firstStage, githubTokenUrl, gitlabTokenUrl, recognizesToken } from './ConnectorGrid.js';

const meta = (kind: ConnectorKind) => CONNECTOR_CATALOG.find((c) => c.kind === kind)!;
const noop = () => {};
const row = (kind: ConnectorKind, stage: SetupStage, extra: Partial<React.ComponentProps<typeof ConnectorRow>> = {}) =>
  renderToStaticMarkup(
    <ConnectorRow
      meta={meta(kind)} compact={false} connected={false} stage={stage} token="" fields={{}} busy={false}
      onStart={noop} onStage={noop} onSkipCli={noop} onToken={noop} onField={noop} onConnect={noop} onDisconnect={noop} onFetch={noop}
      {...extra}
    />,
  );

describe('one-click connector setup (#2492)', () => {
  it('starts every connector as one Connect button with no key field', () => {
    const html = renderToStaticMarkup(<ConnectorGrid />);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('<input');
    expect(html.match(/>Connect</g)?.length).toBe(CONNECTOR_CATALOG.length);
  });

  it('opens on where to get the key, and asks for it only at the next step', () => {
    const source = row('github', 'source');
    expect(source).toContain('Create a token on GitHub');
    expect(source).toContain('I already have one');
    expect(source).not.toContain('type="password"');

    const paste = row('github', 'paste');
    expect(paste).toContain('Paste it here');
    expect(paste).toContain('type="password"');
    expect(paste).toContain('Open it again');
  });

  it('asks a self-managed GitLab for its address before opening the token page', () => {
    expect(row('gitlab', 'source')).toContain('aria-label="GitLab Your own GitLab (optional)"');
    expect(row('gitlab', 'paste')).toContain('aria-label="GitLab token"');
  });

  it('skips the key step for a connector without one', () => {
    expect(firstStage('tasksfile')).toBe('paste');
    const html = row('tasksfile', 'paste');
    expect(html).toContain('Point it at your file');
    expect(html).not.toContain('type="password"');
  });

  it('offers the GitHub CLI sign-in on the row, with a way to use a token', () => {
    const html = row('github', 'closed', { detected: 'octocat' });
    expect(html).toContain('Ready: your GitHub CLI sign-in as @octocat.');
    expect(html).toContain('Use a token');
    expect(row('github', 'closed', { detected: '' })).toContain('Ready: your GitHub CLI sign-in.');
  });

  it('fills in the token pages that take a name and scopes', () => {
    const gh = new URL(githubTokenUrl());
    expect(gh.pathname).toBe('/settings/tokens/new');
    expect(gh.searchParams.get('description')).toBe('Nekko Agent');
    expect(gh.searchParams.get('scopes')).toBe('repo,read:org');
    expect(gitlabTokenUrl()).toBe('https://gitlab.com/-/user_settings/personal_access_tokens?name=Nekko%20Agent&scopes=api');
    expect(gitlabTokenUrl(' https://git.example.com/ ')).toBe('https://git.example.com/-/user_settings/personal_access_tokens?name=Nekko%20Agent&scopes=api');
  });

  it('connects on paste only for an unmistakable key', () => {
    expect(recognizesToken('github', 'ghp_0123456789abcdefABCDEF0123456789abcd')).toBe(true);
    expect(recognizesToken('github', 'github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(recognizesToken('github', 'glpat-0123456789abcdefghij')).toBe(false);
    expect(recognizesToken('gitlab', 'glpat-0123456789abcdefghij')).toBe(true);
    expect(recognizesToken('slack', 'xoxb-1234-5678-abcdefghijklmnop')).toBe(true);
    expect(recognizesToken('discord', 'anything-at-all-long-enough-here')).toBe(false);
    // Jira still needs its site and email, so a pasted token alone cannot connect.
    expect(canConnect('jira', 'tok', {})).toBe(false);
  });
});

describe('choosing GitHub repositories (#2562)', () => {
  const list = {
    repos: ['nekko-labs/nekko-agent', 'nekko-labs/floop', 'ermish/notes', 'acme/site'].map((fullName) => ({
      provider: 'github' as const, id: fullName, fullName, cloneUrl: '', webUrl: '', defaultBranch: 'main', private: fullName === 'ermish/notes', description: '', updatedAt: '',
    })),
    providers: [{ kind: 'github' as const }],
  };

  it('starts closed with a count', () => {
    const html = renderToStaticMarkup(<RepoChoice kind="github" list={list} exclusions={{ excludedRepos: [], excludedOwners: [] }} onChange={noop} />);
    expect(html).toContain('Repositories');
    expect(html).toContain('>4<');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Remove org');
  });

  it('groups under each owner with Remove org, and lists what was removed', () => {
    const html = renderToStaticMarkup(
      <RepoChoice kind="github" list={list} exclusions={{ excludedRepos: ['nekko-labs/floop'], excludedOwners: ['acme'] }} onChange={noop} startOpen />,
    );
    expect(html).toContain('2 of 4');
    expect(html).toContain('data-repo-group="ermish"');
    expect(html).toContain('data-repo-group="nekko-labs"');
    expect(html).not.toContain('data-repo-group="acme"');
    expect(html).toContain('aria-label="Remove nekko-labs"');
    expect(html).toContain('data-repo-group="removed"');
  });

  it('shows the provider error instead of an empty list', () => {
    const html = renderToStaticMarkup(
      <RepoChoice kind="github" list={{ repos: [], providers: [{ kind: 'github', error: 'Reconnect GitHub' }] }} exclusions={{ excludedRepos: [], excludedOwners: [] }} onChange={noop} startOpen />,
    );
    expect(html).toContain('Reconnect GitHub');
    expect(html).not.toContain('No repositories reachable');
  });
});
