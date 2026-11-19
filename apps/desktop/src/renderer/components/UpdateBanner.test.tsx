import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdatedPill } from './UpdateBanner.js';

describe('the pill after an update', () => {
  const html = renderToStaticMarkup(<UpdatedPill version="0.10.1004" onOpen={() => {}} onDismiss={() => {}} />);

  it('is a group that says an update was installed', () => {
    expect(html).toMatch(/^<span[^>]*role="group"[^>]*aria-label="Updated to v0\.10\.1004"/);
  });

  it('holds two buttons side by side, never one inside the other', () => {
    const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.match(/<button/g)).toHaveLength(1);
    expect(buttons[0]).toContain('data-testid="update-whats-new"');
    expect(buttons[0]).toContain("What&#x27;s new");
    expect(buttons[1]).toContain('data-testid="update-dismiss"');
    expect(buttons[1]).toContain('aria-label="Dismiss"');
  });

  it('draws the dismiss as the Gentleface x alone, hidden from the name', () => {
    const dismiss = html.match(/<button[\s\S]*?<\/button>/g)![1]!;

    expect(dismiss).toContain('M11.5 2.997C11.636 2.997');
    expect(dismiss).toMatch(/^<button[^>]*><span[^>]*aria-hidden="true"[^>]*>.*<\/span><\/button>$/s);
  });
});
