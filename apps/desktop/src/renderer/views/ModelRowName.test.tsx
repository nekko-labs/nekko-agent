import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelRowName } from './ModelRowName.js';

describe('Models page row name', () => {
  it('is a button that sets the model as default', () => {
    const onSetDefault = vi.fn();
    const props = { name: 'OpenAI: GPT-6', isDefault: false, onSetDefault };

    expect(renderToStaticMarkup(<ModelRowName {...props} />)).toContain('<button');
    expect(renderToStaticMarkup(<ModelRowName {...props} />)).toContain('title="Set as default"');

    ModelRowName(props).props.onClick();
    expect(onSetDefault).toHaveBeenCalledTimes(1);
  });

  it('shows the Default tag and does nothing on the current default', () => {
    const onSetDefault = vi.fn();
    const props = { name: 'OpenAI: GPT-6', isDefault: true, onSetDefault };

    expect(renderToStaticMarkup(<ModelRowName {...props} />)).toContain('>Default<');

    ModelRowName(props).props.onClick();
    expect(onSetDefault).not.toHaveBeenCalled();
  });
});
