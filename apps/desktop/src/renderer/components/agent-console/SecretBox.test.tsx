import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SecretBox } from './SecretBox.js';

const request = { callId: 'c1', name: 'OPENAI_API_KEY', reason: 'To call the OpenAI API.', requestedAt: 1 };

it('names what the agent asked for and why, and offers paste, show, skip and provide', () => {
  const html = renderToStaticMarkup(<SecretBox request={request} onProvide={vi.fn()} onSkip={vi.fn()} />);
  expect(html).toContain('OPENAI_API_KEY');
  expect(html).toContain('To call the OpenAI API.');
  expect(html).toContain('$OPENAI_API_KEY');
  for (const control of ['data-secret-paste', 'data-secret-show', 'data-secret-skip', 'data-secret-provide']) {
    expect(html).toContain(control);
  }
});

it('masks the field and keeps it out of autofill, spellcheck and password managers', () => {
  const html = renderToStaticMarkup(<SecretBox request={request} onProvide={vi.fn()} onSkip={vi.fn()} />);
  const input = html.match(/<input[^>]*>/)?.[0] ?? '';
  expect(input).toContain('type="password"');
  expect(input).toContain('autoComplete="off"');
  expect(input).toContain('spellCheck="false"');
  expect(input).toContain('data-1p-ignore');
  expect(input).not.toContain('autofocus');
});

it('cannot provide an empty value', () => {
  const html = renderToStaticMarkup(<SecretBox request={request} onProvide={vi.fn()} onSkip={vi.fn()} />);
  const provide = html.match(/<button[^>]*data-secret-provide[^>]*>/)?.[0] ?? '';
  expect(provide).toContain('disabled');
});
