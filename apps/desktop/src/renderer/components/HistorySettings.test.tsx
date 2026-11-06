import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HISTORY_RANGES, HISTORY_WARNING_BYTES, HistorySettings, HistoryStorageNotice, historyStorageLabel } from './HistorySettings.js';

describe('chat history Settings', () => {
  it('offers exactly the five explicit cleanup windows', () => {
    expect(HISTORY_RANGES.map(r => r.value)).toEqual(['today', 'last-week', 'older-2-weeks', 'older-1-month', 'older-6-months']);
    const html = renderToStaticMarkup(<HistorySettings openSync={() => {}} refreshSessions={async () => {}} />);
    expect(html).toContain('Completed chats are kept until you delete them');
    expect(html).toContain('Active and running chats are kept');
    expect(html).toContain('<option value="older-1-month" selected="">');
    expect(html).not.toContain('data-history-confirm');
    expect(html).toMatch(/disabled=""[^>]*data-history-clear/);
  });
  it('warns at exactly one decimal GB, not before, and does not promise cloud offloading', () => {
    const render = (bytes: number) => renderToStaticMarkup(<HistoryStorageNotice bytes={bytes} openSync={() => {}} />);
    expect(render(HISTORY_WARNING_BYTES - 1)).toBe('');
    expect(render(HISTORY_WARNING_BYTES)).toContain('uses 1 GB or more');
    expect(render(HISTORY_WARNING_BYTES)).toContain('Sync does not automatically free local space');
    expect(render(HISTORY_WARNING_BYTES * 2)).toContain('data-history-sync');
  });
  it('formats measured storage using the same decimal units as the warning', () => {
    expect(historyStorageLabel(0)).toBe('0 KB');
    expect(historyStorageLabel(1250)).toBe('2 KB');
    expect(historyStorageLabel(1_250_000)).toBe('1.3 MB');
    expect(historyStorageLabel(1_250_000_000)).toBe('1.25 GB');
  });
});
