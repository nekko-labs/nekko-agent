import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalBar, approvalNeedsYoloConfirmation, handleApprovalKey, isTruncated, needsFullTextToggle } from './ApprovalBar.js';
import type { ApprovalScope } from './approval-decision.js';

const approval = { call: { id: 'approval', name: 'bash', input: { command: 'echo test' } }, reason: 'Confirm command', severity: 'medium' as const };
const heredoc = "cat > notes.txt <<'EOF'\nfirst line\nsecond line\nEOF";
const multiLineApproval = { call: { id: 'heredoc', name: 'bash', input: { command: heredoc } }, reason: 'Confirm write', severity: 'high' as const };

it('renders approval controls without automatic focus', () => {
  const html = renderToStaticMarkup(<ApprovalBar approval={approval} onDecide={vi.fn()} />);
  expect(html).toContain('Deny');
  expect(html).toContain('Approve');
  expect(html).toContain('Allow all this session');
  expect(html).not.toContain('autofocus');
});

it.each<ApprovalScope>(['once', 'tool', 'session', 'always'])('warns only when approving a YOLO scope: %s', (scope) => {
  expect(approvalNeedsYoloConfirmation(true, scope)).toBe(scope === 'session' || scope === 'always');
  expect(approvalNeedsYoloConfirmation(false, scope)).toBe(false);
});

it('keeps keyboard decisions scoped to the approval surface', () => {
  const decide = vi.fn();
  const preventDefault = vi.fn();
  handleApprovalKey({ key: 'y', preventDefault }, decide);
  expect(decide).toHaveBeenLastCalledWith(true);
  handleApprovalKey({ key: 'n', preventDefault }, decide);
  expect(decide).toHaveBeenLastCalledWith(false);
  handleApprovalKey({ key: 'Enter', preventDefault }, decide);
  expect(decide).toHaveBeenCalledTimes(2);
  handleApprovalKey({ key: 'Escape', preventDefault }, decide);
  expect(decide).toHaveBeenLastCalledWith(false);
});

it('reports truncation only when the content is wider than the box', () => {
  expect(isTruncated({ scrollWidth: 400, clientWidth: 200 })).toBe(true);
  expect(isTruncated({ scrollWidth: 200, clientWidth: 200 })).toBe(false);
  expect(isTruncated({ scrollWidth: 120, clientWidth: 200 })).toBe(false);
  expect(isTruncated(null)).toBe(false);
  expect(isTruncated(undefined)).toBe(false);
});

it('offers the toggle when cut off, multi-line, or already expanded', () => {
  expect(needsFullTextToggle('echo test', false, false)).toBe(false);
  expect(needsFullTextToggle('echo test', true, false)).toBe(true);
  expect(needsFullTextToggle('echo a\necho b', false, false)).toBe(true);
  expect(needsFullTextToggle('echo a\r\necho b', false, false)).toBe(true);
  // Expanded text no longer overflows; the control must stay to collapse it.
  expect(needsFullTextToggle('echo test', false, true)).toBe(true);
  // Length alone does not matter: a long command that fits needs no toggle.
  expect(needsFullTextToggle('x'.repeat(200), false, false)).toBe(false);
});

it('renders a collapsed toggle for a multi-line command', () => {
  const html = renderToStaticMarkup(<ApprovalBar approval={multiLineApproval} onDecide={vi.fn()} />);
  expect(html).toContain('Show full command');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toMatch(/aria-controls="[^"]+"/);
  expect(html).not.toContain('Show less');
  expect(html).not.toContain('aria-live');
});

it('keeps the hover title and renders no toggle for short single-line text', () => {
  const html = renderToStaticMarkup(<ApprovalBar approval={approval} onDecide={vi.fn()} />);
  expect(html).toContain('title="echo test"');
  expect(html).not.toContain('Show full command');
  expect(html).not.toContain('aria-expanded');
});
