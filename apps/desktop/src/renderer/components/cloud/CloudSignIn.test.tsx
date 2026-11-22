import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG } from '@nekko-agent/shared';
import { CloudSignIn, hasBeenWelcomed } from './CloudSignIn.js';
import { PlanStep, PlanTable, TEST_PRO, TestCheckout } from './CloudWelcomePlan.js';
import { CloudWelcomeScene } from './CloudWelcomeScene.js';
import { NekkoCloudMark } from './NekkoCloudMark.js';

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

describe('Nekko Cloud walkthrough (#3187, #3190)', () => {
  it('opens on Welcome the first time, about your way, with Create your account, I already have an account and five step dots', () => {
    const html = renderToStaticMarkup(<CloudSignIn start="welcome" status={null} pending={null} onPending={noop} onClose={noop} />);
    expect(html).toContain('Your way, on every device');
    expect(html).toContain('Your profile, computers, fleet and settings');
    expect(html).not.toContain('Your Nekko');
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

  it('draws one picture: the Nekko Cloud mark above four devices, whose scene is a class so steps morph', () => {
    const html = renderToStaticMarkup(<CloudWelcomeScene scene="welcome" />);
    expect(html).toContain('cw-s s-welcome');
    expect(html).toContain('data-part="nekko-cloud"');
    expect(html).toContain('nc-hop');
    expect(html.match(/class="dev d\d"/g)).toHaveLength(4);
    // Other scenes mount on the account layout, then move to their own on the next frame.
    expect(renderToStaticMarkup(<CloudWelcomeScene scene="code" />)).toContain('cw-s s-account');
  });

  it('draws the mark as a cloud with ears and caret eyes, and nothing else', () => {
    const html = renderToStaticMarkup(<NekkoCloudMark size={64} title="Nekko Cloud" />);
    expect(html).toContain('aria-label="Nekko Cloud"');
    expect(html.match(/<path/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<NekkoCloudMark hop={false} />)).not.toContain('nc-hop');
  });
});

describe('Choose a plan (#3191)', () => {
  it('offers Free, Pro and Enterprise with Pro chosen and three main points each, at the draft price while billing is off', () => {
    const html = renderToStaticMarkup(<PlanStep live={false} onFree={noop} onPro={noop} onError={noop} />);
    expect(html).toContain('data-testid="cw-plan-free"');
    expect(html).toContain('data-testid="cw-plan-team"');
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="cw-plan-pro"/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/\$12(\.00)?<small>a month<\/small>/);
    expect(html).toContain('Talk to us');
    expect(html).toContain('>Enterprise<');
    expect(html.match(/<li>/g)).toHaveLength(9);
    expect(html).toContain('Continue with Pro');
    // The full list waits behind its toggle.
    expect(html).toContain('Show the full list');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="cw-table"');
  });

  it('waits for the real price when billing is live', () => {
    const html = renderToStaticMarkup(<PlanStep live onFree={noop} onPro={noop} onError={noop} />);
    expect(html).not.toMatch(/\$12/);
  });

  it('lists every catalog row in the full comparison, with unshipped rows marked Soon', () => {
    const html = renderToStaticMarkup(<PlanTable chosen="pro" />);
    const rows = PLAN_CATALOG.groups.flatMap((g) => g.rows);
    for (const r of rows) expect(html).toContain(r.feature);
    expect(html.match(/class="cw-tr"/g)).toHaveLength(rows.length);
    expect(html).toContain('Soon');
    expect(html).toContain('5 GB');
  });
});

describe('The test checkout (#3193)', () => {
  const checkout = (country: string, device: 'apple' | 'other') =>
    renderToStaticMarkup(<TestCheckout plan={TEST_PRO} email="sam@example.com" onPaid={noop} initialCountry={country} initialDevice={device} />);

  it('says it is test mode, says Pay now, and has no card fields to type a real card into', () => {
    const html = checkout('US', 'other');
    expect(html).toContain('Test mode: nothing is charged');
    expect(html).toContain('Test card ending in 4242');
    expect(html).not.toContain('<input');
    expect(html).toContain('>Pay now<');
    expect(html).not.toMatch(/Pay \$12/);
  });

  it('offers the methods where you are: three tiles and the rest behind more in the US', () => {
    const html = checkout('US', 'other');
    expect(html).toContain('data-testid="cw-method-google_pay"');
    expect(html).not.toContain('data-testid="cw-method-apple_pay"');
    expect(html).toContain('4 more');
  });

  it('shows the JCB test card and Apple Pay on a Mac in Japan', () => {
    const html = checkout('JP', 'apple');
    expect(html).toContain('data-testid="cw-method-apple_pay"');
    expect(html).toContain('Test card ending in 0505');
    expect(html).not.toContain('data-testid="cw-methods-more"');
  });

  it('offers UPI in India with the notice Indian rules require', () => {
    const html = checkout('IN', 'other');
    expect(html).toContain('data-testid="cw-method-upi"');
    expect(html).toContain('a day before each payment');
  });
});
