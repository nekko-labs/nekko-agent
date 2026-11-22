import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CloudSignIn, hasBeenWelcomed } from './CloudSignIn.js';
import { PlanStep, TEST_PRO, TestCheckout } from './CloudWelcomePlan.js';
import { CloudWelcomeScene } from './CloudWelcomeScene.js';

const noop = () => {};

describe('Nekko Cloud sign-in', () => {
  it('starts with the sign-in choices when no code is waiting', () => {
    const html = renderToStaticMarkup(<CloudSignIn status={null} pending={null} onPending={noop} onClose={noop} />);
    expect(html).toContain('Sign in to Nekko Cloud');
    expect(html).toContain('data-testid="cloud-send-code"');
    expect(html).not.toContain('Check your email');
    // A later sign-in on this device: no Welcome, no step dots.
    expect(html).not.toContain('cw-dots');
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

describe('Nekko Cloud walkthrough (#3187)', () => {
  it('opens on Welcome the first time, with Create your account, I already have an account and five step dots', () => {
    const html = renderToStaticMarkup(<CloudSignIn start="welcome" status={null} pending={null} onPending={noop} onClose={noop} />);
    expect(html).toContain('Your Nekko, on every device');
    expect(html).toContain('data-testid="cw-create"');
    expect(html).toContain('data-testid="cw-have-account"');
    expect(html).toContain('aria-label="Step 1 of 5"');
    expect(html).toContain('data-step="welcome"');
  });

  it('a waiting code still wins over Welcome', () => {
    const pending = { email: 'sam@example.com', sentAt: Date.now() };
    const html = renderToStaticMarkup(<CloudSignIn start="welcome" status={null} pending={pending} onPending={noop} onClose={noop} />);
    expect(html).toContain('Check your email');
  });

  it('treats a device with no storage as not yet welcomed', () => {
    expect(hasBeenWelcomed()).toBe(false);
  });

  it('draws one picture whose scene is a class, so steps can morph into each other', () => {
    const html = renderToStaticMarkup(<CloudWelcomeScene scene="welcome" />);
    expect(html).toContain('cw-s s-welcome');
    expect(html).toContain('data-part="pixel-head"');
    // Other scenes mount on the account layout, then move to their own on the next frame.
    expect(renderToStaticMarkup(<CloudWelcomeScene scene="sync" />)).toContain('cw-s s-account');
  });
});

describe('Choose a plan and the test checkout', () => {
  it('offers Free, Pro and Team with Pro chosen, at the draft price while billing is off', () => {
    const html = renderToStaticMarkup(<PlanStep live={false} onFree={noop} onPro={noop} onError={noop} />);
    expect(html).toContain('data-testid="cw-plan-free"');
    expect(html).toContain('data-testid="cw-plan-team"');
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="cw-plan-pro"/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/\$12(\.00)? a month/);
    expect(html).toContain('Continue with Pro');
  });

  it('waits for the real price when billing is live', () => {
    const html = renderToStaticMarkup(<PlanStep live onFree={noop} onPro={noop} onError={noop} />);
    expect(html).not.toMatch(/\$12/);
  });

  it('says it is test mode and has no card fields to type a real card into', () => {
    const html = renderToStaticMarkup(<TestCheckout plan={TEST_PRO} email="sam@example.com" onPaid={noop} />);
    expect(html).toContain('Test mode: nothing is charged');
    expect(html).toContain('Test card ending in 4242');
    expect(html).not.toContain('<input');
    expect(html).toMatch(/Pay \$12/);
  });
});
