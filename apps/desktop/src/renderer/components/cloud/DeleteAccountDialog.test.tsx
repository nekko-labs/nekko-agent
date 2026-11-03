import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../primitives/Modal.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

import { DeleteAccountDialog, emailMatches } from './DeleteAccountDialog.js';

describe('Delete Nekko Cloud account', () => {
  it('asks for the account email before it can delete', () => {
    const html = renderToStaticMarkup(<DeleteAccountDialog email="sam@example.com" onClose={() => {}} onDeleted={() => {}} />);
    expect(html).toContain('sam@example.com');
    expect(html).toContain('Chats on this computer and your other devices stay');
    expect(html).toMatch(/<button[^>]*data-cloud-delete-confirm="true"[^>]*disabled/);
  });

  it('matches the email ignoring case and surrounding spaces, never an empty one', () => {
    expect(emailMatches(' Sam@Example.com ', 'sam@example.com')).toBe(true);
    expect(emailMatches('sam@example.co', 'sam@example.com')).toBe(false);
    expect(emailMatches('', '')).toBe(false);
  });
});
