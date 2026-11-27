// Runtime copy uses t('the English source') or t(`the {name} message`, values).
// Scan these public entry points only. Do not include signed-in console source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { site } from './catalog.mjs';

const root = new URL('../../', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

const files = ['analytics.js', 'contributors.js', 'design-system.js', 'docs.js', 'download.html', 'pricing.js', 'site.js', 'status.js'];
export function runtimeMessages() {
  const messages = new Set();
  for (const file of files) {
    const source = readFileSync(join(site, file), 'utf8');
    if (file === 'site.js') for (const [, hint] of source.matchAll(/\bhint: '([^']+)'/g)) messages.add(hint);
    for (const [, quote, value] of source.matchAll(/\b(?:t|tSite)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g)) {
      if (quote === '`' && value.includes('${')) throw new Error(`${file}: use named message placeholders, not JavaScript interpolation`);
      messages.add(value.replace(/\\(['"`\\])/g, '$1'));
    }
  }
  const pricing = json('packages/shared/src/plan-catalog.json');
  for (const plan of pricing.plans) {
    messages.add(plan.tagline);
    for (const point of plan.points) messages.add(point);
  }
  for (const group of pricing.groups) {
    messages.add(group.name);
    for (const row of group.rows) {
      messages.add(row.feature);
      for (const cell of [row.free, row.pro, row.team]) if (typeof cell === 'string') messages.add(cell);
    }
  }
  for (const service of json('apps/website/status.json').services) messages.add(service.what);
  return [...messages];
}
