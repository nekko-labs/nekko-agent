import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: React.ReactNode) => node }));

import { Modal } from './Modal.js';

describe('Modal', () => {
  it('opts out of the title bar drag strip, so buttons drawn over it take clicks across their whole face', () => {
    vi.stubGlobal('document', { body: null });
    const html = renderToStaticMarkup(<Modal title="Photo" onClose={() => {}}><button>Copy</button></Modal>);
    expect(html).toMatch(/^<div class="fixed inset-0 \[-webkit-app-region:no-drag\]/);
  });
});
