import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CloudSignIn } from './CloudSignIn.js';

const noop = () => {};

describe('Nekko Cloud sign-in', () => {
  it('starts with the sign-in choices when no code is waiting', () => {
    const html = renderToStaticMarkup(<CloudSignIn status={null} pending={null} onPending={noop} onClose={noop} />);
    expect(html).toContain('Sign in to Nekko Cloud');
    expect(html).toContain('data-testid="cloud-send-code"');
    expect(html).not.toContain('Check your email');
  });

  it('reopens straight to the code already sent, with Cancel and the resend wait carried over', () => {
    const pending = { email: 'sam@example.com', sentAt: Date.now() - 10_000 };
    const html = renderToStaticMarkup(<CloudSignIn status={null} pending={pending} onPending={noop} onClose={noop} />);
    expect(html).toContain('Check your email');
    expect(html).toContain('sam@example.com');
    expect(html).toContain('data-testid="cloud-code-cancel"');
    expect(html).toMatch(/Send again in (19|20)s/);
  });

  it('offers a new code at once when the wait is over', () => {
    const pending = { email: 'sam@example.com', sentAt: Date.now() - 120_000 };
    expect(renderToStaticMarkup(<CloudSignIn status={null} pending={pending} onPending={noop} onClose={noop} />)).toContain('Send a new code');
  });
});
