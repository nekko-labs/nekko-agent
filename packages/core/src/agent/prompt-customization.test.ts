import { expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt.js';

it('includes server customization separately from user content and built-in policies', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '', systemInstructions: 'Prefer short replies.', aboutUser: 'I am learning Rust.', turnWrapper: 'Verify results.', checkoutNotice: 'Committed HEAD; local edits are not included.' });
  expect(prompt).toContain('Custom system instructions:\nPrefer short replies.');
  expect(prompt).toContain('About the user');
  expect(prompt).toContain('I am learning Rust.');
  expect(prompt).toContain('Server instructions for this user turn:\nVerify results.');
  expect(prompt).toContain('Checkout baseline:\nCommitted HEAD; local edits are not included.');
  expect(prompt).not.toContain('Before starting work');
  expect(prompt).toContain('Operating principles:');
});
it('scopes user-sent photo consent to PR chats and honors saved preferences', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '' });
  for (const rule of [
    'Only in agent chats making or updating a PR',
    'check the conversation and loaded user/project preferences',
    'ask the first time, before uploading',
    'this PR only',
    'do not ask in non-PR chats',
    'no relevant user-sent images exist',
    'honor its scope, do not ask again',
    'let later instructions override it',
    'only in an authorized project guideline or user-preference store',
    'distinguish reference photos from verified implementation evidence',
    'verify published links',
    'Never publish unrelated or sensitive images without specific permission',
    'does not replace required agent-captured UI verification evidence',
  ]) expect(prompt).toContain(rule);
});

it('requires published PR descriptions to keep unfinished work explicit and current', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '' });
  expect(prompt).toContain('Unfinished work / release blockers');
  expect(prompt).toContain('Keep this section current after each pushed batch');
  expect(prompt).toContain('Verify the published description');
  expect(prompt).toContain('keep the PR draft/unmerged');
});
it('always includes safe app verification guidance without optional capabilities', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '' });
  expect(prompt).toContain('App verification:');
  expect(prompt).toContain('Do not launch the app when those checks suffice.');
  expect(prompt).toContain('check for existing instances');
  expect(prompt).toContain('Prefer reusing a matching agent-owned sandbox');
  expect(prompt).toContain("Treat the user's running app as read-only by default; ask before interactions");
  expect(prompt).toContain('separate app data and external side effects disabled by default');
  expect(prompt).toContain("never close the user's app.");
  expect(prompt).toContain('Headless checks do not replace actual desktop-window evidence');
});


it('omits empty customization sections', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'win32', contextBlock: '', turnWrapper: '' });
  expect(prompt).not.toContain('Server instructions for this user turn:');
  expect(prompt).not.toContain('About the user');
});

it('requires automatic UI verification and authorized landing, not a draft-PR handoff', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'darwin', contextBlock: '' });
  for (const rule of [
    'automatically continue into isolated visual and interaction testing',
    'unchanged base revision in a separate sandbox',
    'Capture and inspect matching before/after screenshots',
    'record a short video for motion or timing changes',
    'verify the published links',
    'Missing evidence is unfinished work',
    'A draft PR is a checkpoint, not a stopping condition',
    'When the user or repository authorizes landing',
    'never bypass protections or approval requirements',
    'Investigate available isolation and verification paths',
    'A user-requested pause or narrower scope always takes precedence',
    'register agent_watch when available before ending the turn',
    // Verification runs alongside CI, and the wait is spent finishing work.
    'CI is not a gate for your own verification',
    'while the checks run, not after them',
    'Waiting on checks is time to finish remaining work',
    'first do everything that does not depend on the result',
    'If unavailable or registration fails',
    'Do not schedule continuations to bypass',
  ]) expect(prompt).toContain(rule);
  // GitHub release naming is repository policy, not a global side effect.
  expect(prompt).not.toContain('pr-media');
});

it('ends a PR task at merge or a named blocker, never at a draft with residual notes', () => {
  const prompt = buildSystemPrompt({ workspaces: [], platform: 'linux', contextBlock: '' });
  for (const rule of [
    'A PR task ends when the PR is merged or you have named the exact blocker',
    'A non-empty Unfinished work section is not a blocker',
    'Only a release blocker holds a PR',
    'mark the draft ready and merge it',
    'do not hand the PR back to the user in draft',
    'A check that also fails on the base branch is a baseline problem',
    'file one if none exists',
    'Never weaken a budget or disable a check to get green',
  ]) expect(prompt).toContain(rule);
});
