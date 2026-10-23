import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { AutomationsSection } from './SettingsView.js';

vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));

function elements(tree: React.ReactNode): React.ReactElement<Record<string, any>>[] {
  const out: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    out.push(child);
    walk(child.props.children);
  });
  walk(tree);
  return out;
}

describe('Automations settings', () => {
  it('defaults by where the model runs, with a 5 minute threshold', () => {
    const html = renderToStaticMarkup(<AutomationsSection settings={{} as AppSettings} update={() => {}} />);
    expect(html).toContain('id="automations"');
    expect(html).toContain('>By where the model runs</option>');
    expect(html).toContain('On a local model, only when you are away');
    expect(html).toContain('value="5"');
  });

  it('writes the policy, and null to go back to the default; minutes on blur, within 1 to 240', () => {
    const update = vi.fn();
    const html = renderToStaticMarkup(<AutomationsSection settings={{ automationRunPolicy: 'lowPriority', automationIdleMinutes: 15 } as AppSettings} update={update} />);
    expect(html).toContain('value="15"');
    expect(html).toContain('not on a low battery or a hot computer');
    const tree = AutomationsSection({ settings: { automationRunPolicy: 'lowPriority' } as AppSettings, update });
    const select = elements(tree).find((e) => e.type === 'select')!;
    select.props.onChange({ target: { value: '' } });
    expect(update).toHaveBeenLastCalledWith({ automationRunPolicy: null });
    select.props.onChange({ target: { value: 'always' } });
    expect(update).toHaveBeenLastCalledWith({ automationRunPolicy: 'always' });
    const minutes = elements(tree).find((e) => e.props['data-settings-idle-minutes'])!;
    minutes.props.onBlur({ currentTarget: { value: '12' } });
    expect(update).toHaveBeenLastCalledWith({ automationIdleMinutes: 12 });
    const wrong = { value: '0' };
    minutes.props.onBlur({ currentTarget: wrong });
    expect(wrong.value).toBe('5');
    expect(update).toHaveBeenCalledTimes(3);
  });
});
