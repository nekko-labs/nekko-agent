import { build } from '../build-docs.mjs';
import { build as design } from '../build-design-system.mjs';
import { extract, loadCatalog, locales, pageSources } from './catalog.mjs';
import { runtimeMessages } from './runtime-messages.mjs';

const expected = extract(pageSources(new Map([...build(), ...design()])), runtimeMessages());
let ready = true;
for (const locale of locales) {
  const catalog = loadCatalog(locale);
  const total = [...expected.keys()].filter((key) => typeof catalog[key] === 'string' && catalog[key].trim()).length;
  const percent = 100 * total / expected.size;
  console.log(`${locale}: ${total}/${expected.size} strings (${percent.toFixed(2)}%)`);
  if (percent < 99) ready = false;
}
if (!ready && process.argv.includes('--check')) {
  console.error('Release blocked: each locale needs at least 99% coverage before launch.');
  process.exitCode = 1;
}
