import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionCatalogEntry, DecisionStatus, InstalledDecisionModel } from '@nekko-agent/shared';
import { CatalogCard } from './DecisionModels.js';

vi.mock('../../store.js', () => ({ useStore: () => undefined }));

const entry = (id: string, name: string, precisions: Array<'fp16' | 'fp32' | 'int8'>): DecisionCatalogEntry => ({
  id, name, publisher: 'Convai Innovations', license: 'Apache-2.0', source: `nekko-agent decision-models-v1, from x/${id}@abc1234`,
  description: `${name} description`,
  variants: precisions.map((precision, i) => ({ precision, file: `${precision}.onnx`, bytes: (i + 1) * 100_000_000, recommended: i === 0 })),
  shared: [{ file: 'tokenizer.json', bytes: 3_000_000 }],
});
const STATUS: DecisionStatus = { local: { available: true, loaded: false }, typesafe: { configured: false } };
const card = (e: DecisionCatalogEntry, have?: InstalledDecisionModel, status = STATUS) =>
  renderToStaticMarkup(<CatalogCard entry={e} have={have} status={status} busy={null} act={vi.fn()} refresh={vi.fn()} />);

describe('a decision catalog card', () => {
  it('offers the recommended precision for download with its full size, and only its own precisions', () => {
    const html = card(entry('laya-multilingual', 'Laya (multilingual)', ['fp16', 'fp32']));
    expect(html).toContain('data-decision-model="laya-multilingual"');
    expect(html).toContain('Download 98 MB');
    expect(html).toContain('nekko-agent decision-models-v1, from x/laya-multilingual@abc1234');
    expect(html.match(/<option /g)).toHaveLength(2);
    expect(html).toContain('fp16 (recommended)');
    expect(html).not.toContain('int8');
  });

  it('loads what is on disk instead of downloading it, and says what is running', () => {
    const e = entry('laya-en', 'Laya (English)', ['fp16', 'int8', 'fp32']);
    const have: InstalledDecisionModel = { id: 'laya-en', name: 'Laya (English)', dir: '/m/laya-en', precisions: ['fp16'], sizeBytes: 846_000_000 };
    const html = card(e, have);
    expect(html).not.toContain('Download');
    expect(html).toContain('>Load<');
    expect(html).toContain('On disk: fp16');
    const loaded = card(e, have, { local: { available: true, loaded: true, model: 'laya-en', ep: 'directml', precision: 'fp16', loadMs: 2200 }, typesafe: { configured: false } });
    expect(loaded).toContain('running fp16 on directml, loaded in 2.2 s');
    expect(loaded).toContain('>Unload<');
  });

  it('explains instead of offering a download when an entry cannot be fetched', () => {
    const html = card({ ...entry('x', 'X', ['fp16']), unavailable: 'Not hosted.' });
    expect(html).toContain('Not hosted.');
    expect(html).not.toContain('Download');
  });
});
