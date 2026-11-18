import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ImageCompanionStatus, LocalModel } from '@nekko-agent/shared';
import { PictureModelControl, readyPictureModels } from './PictureModelSettings.js';

const model = (id: string, name: string, modality = 'image') => ({ id, name, modality }) as unknown as LocalModel;
const status = (ready: boolean, capabilities: string[]) => ({ ready, capabilities }) as unknown as ImageCompanionStatus;

describe('readyPictureModels', () => {
  it('keeps ready picture models, as the daemon offers them to agents', () => {
    const models = [model('z', 'Z-Image'), model('k', 'FLUX.2 klein 4B'), model('q', 'Qwen Image'), model('w', 'Wan 2.2'), model('sd', 'Tiny SD'), model('chat', 'Qwen3', 'text')];
    const statuses = {
      z: status(true, ['create']),
      k: status(true, ['create', 'edit']),
      q: status(false, ['create']),
      w: status(true, ['video']),
      sd: null,
    };
    expect(readyPictureModels(models, statuses)).toEqual([
      { id: 'z', name: 'Z-Image', edits: false },
      { id: 'k', name: 'FLUX.2 klein 4B', edits: true },
      { id: 'sd', name: 'Tiny SD', edits: false },
    ]);
  });
});

describe('PictureModelControl', () => {
  const choices = [{ id: 'z', name: 'Z-Image', edits: false }, { id: 'k', name: 'FLUX.2 klein 4B', edits: true }];
  const html = (value: string | undefined, list = choices as typeof choices | null) =>
    renderToStaticMarkup(<PictureModelControl value={value} choices={list} onChange={() => {}} />);

  it('offers Automatic and the ready models', () => {
    const out = html(undefined);
    expect(out).toContain('aria-label="Picture model for agents"');
    expect(out).toContain('>Automatic</option>');
    expect(out).toContain('FLUX.2 klein 4B · edits too');
    expect(out).toContain('Used when the agent and the chat name none.');
  });

  it('says when the chosen model is not ready', () => {
    const out = html('gone');
    expect(out).toContain('gone (not ready)');
    expect(out).toContain('agents use Automatic until it is');
  });

  it('shows only a line when no model is ready, or while it looks', () => {
    expect(html(undefined, [])).toContain('No picture model is ready on this computer.');
    expect(html(undefined, [])).not.toContain('<select');
    expect(html(undefined, null)).toContain('Looking for picture models');
  });
});
