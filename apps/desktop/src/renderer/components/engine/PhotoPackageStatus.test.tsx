import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhotoPackageStatus, photoReadyLabel } from './PhotoPackageStatus.js';
import type { ImageCompanionStatus } from '@nekko-agent/shared';
const files = (capabilities: string[], ready = true) => ({ capabilities, ready }) as ImageCompanionStatus;

describe('photo package readiness', () => {
  it('requires both image engine and known supporting files', () => {
    expect(photoReadyLabel(false, files(['create', 'edit']))).toBe('Finish photo setup');
    expect(photoReadyLabel(true, files(['create'], false))).toBe('Finish photo setup');
    expect(photoReadyLabel(true, null)).toBe('Finish photo setup');
  });
  it('describes the model capability instead of calling every model a generator', () => {
    expect(photoReadyLabel(true, files(['edit']))).toBe('Ready to edit photos');
    expect(photoReadyLabel(true, files(['create']))).toBe('Ready to create pictures');
    expect(photoReadyLabel(true, files(['create', 'edit']))).toBe('Ready to create and edit photos');
    expect(photoReadyLabel(true, files(['video']))).toBe('Ready to make short clips (experimental)');
  });
  it('does not imply readiness before a host check', () => {
    const html = renderToStaticMarkup(<PhotoPackageStatus modelId="m" onChanged={() => {}} onDefaults={() => {}} />);
    expect(html).toContain('Checking photo setup');
    expect(html).not.toContain('Ready to');
    expect(html).toContain('Nekko handles them together');
  });
});
