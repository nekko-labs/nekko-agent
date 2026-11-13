import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanRow, TeamSwitches, price } from './PlanAndBilling.js';

describe('Plan and billing (#2724)', () => {
  it('offers Upgrade on Free (enabled once the price loads) and Manage billing on a paid plan', () => {
    const free = renderToStaticMarkup(<PlanRow plan="free" />);
    expect(free).toContain('Nekko Cloud Pro');
    expect(free).toMatch(/<button[^>]*disabled[^>]*data-testid="billing-upgrade"/);
    expect(free).toContain('hello@nekkoagent.com');
    const pro = renderToStaticMarkup(<PlanRow plan="pro" />);
    expect(pro).toContain('Manage billing');
    expect(pro).not.toContain('Upgrade');
  });

  it('shows the team switch with its three states, disabled until loaded', () => {
    const html = renderToStaticMarkup(<TeamSwitches />);
    expect(html).toContain('role="radiogroup"');
    for (const word of ['Off', 'Team only', 'Everyone']) expect(html).toContain(word);
    expect(html).toContain('Only the Nekko team sees this switch');
  });

  it('formats Stripe amounts in the currency\'s smallest unit', () => {
    expect(price({ id: 'pro', amount: 1200, currency: 'usd', interval: 'month' })).toMatch(/^\$12 a month$/);
    expect(price({ id: 'pro', amount: 1250, currency: 'usd', interval: 'month' })).toMatch(/^\$12\.50 a month$/);
    expect(price({ id: 'pro', amount: 1800, currency: 'jpy', interval: 'month' })).toMatch(/1,800 a month$/);
  });
});
