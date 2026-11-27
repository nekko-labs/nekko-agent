// Run from a Mac with the installed system translation languages. Only new
// source strings are translated; existing entries can be edited and are kept.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from '../build-docs.mjs';
import { build as design } from '../build-design-system.mjs';
import { catalogDir, extract, loadCatalog, locales, pageSources, protect, unprotect } from './catalog.mjs';
import { runtimeMessages } from './runtime-messages.mjs';

const entries = extract(pageSources(new Map([...build(), ...design()])), runtimeMessages());
const tags = process.argv.length > 2 ? process.argv.slice(2) : locales;
if (!tags.every((tag) => locales.includes(tag))) throw new Error('Unknown site locale');
const work = mkdtempSync(join(tmpdir(), 'nekko-translations-'));
const binary = join(work, 'translate');
const batchSize = 48;
mkdirSync(catalogDir, { recursive: true });
try {
  const compile = spawn('swiftc', [fileURLToPath(new URL('./translate.swift', import.meta.url)), '-o', binary], { stdio: 'inherit' });
  if ((await once(compile, 'exit'))[0] !== 0) throw new Error('Could not compile offline Swift translator');
  for (const locale of tags) {
    const catalog = loadCatalog(locale);
    const missing = [...entries].filter(([id]) => !Object.hasOwn(catalog, id));
    console.log(`${locale}: ${missing.length}/${entries.size} strings to refresh`);
    if (!missing.length) continue;
    const child = spawn(binary, [locale], { stdio: ['pipe', 'pipe', 'inherit'] });
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const destination = join(catalogDir, `${locale}.json`);
    const save = () => {
      const next = join(catalogDir, `.${locale}.${process.pid}.tmp`);
      const pairs = Object.keys(catalog).sort().map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(catalog[id])}`);
      writeFileSync(next, `{\n${pairs.join(',\n')}\n}\n`);
      renameSync(next, destination);
    };
    let unresolved = 0;
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = new Map(missing.slice(start, start + batchSize).map(([id, text]) => [id, protect(text)]));
      child.stdin.write(JSON.stringify([...batch].map(([id, { source }]) => ({ id, source }))) + '\n');
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error(`${locale}: translator stopped in batch at ${start}`);
        const pair = JSON.parse(value);
        if (pair === null) break;
        const [id, result] = pair;
        if (!batch.has(id)) throw new Error(`Unknown result: ${id}`);
        const translated = unprotect(result.trim(), batch.get(id).saved);
        if (translated) catalog[id] = translated;
        else unresolved++;
      }
      save();
      if (start % (batchSize * 10) === 0 || start + batchSize >= missing.length) {
        console.log(`${locale}: ${Math.min(start + batchSize, missing.length)}/${missing.length}`);
      }
    }
    child.stdin.end();
    if ((await closed)[0] !== 0) throw new Error(`${locale}: translator exited with an error`);
    if (unresolved) console.warn(`${locale}: ${unresolved} strings with missing protected terms remain English`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
