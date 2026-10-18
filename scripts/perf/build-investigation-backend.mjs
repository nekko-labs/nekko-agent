// Isolated feasibility build. No installs or production output writes.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
const root = process.cwd();
const primary = resolve(root, '../..');
const require = createRequire(join(primary, 'package.json'));
const out = resolve('.shots/perf-investigation/source-backend/index.mjs');
mkdirSync(resolve(out, '..'), { recursive: true });
await require('esbuild').build({
  entryPoints: [join(root, 'apps/local-web-ui/src/index.ts')], outfile: out,
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  nodePaths: [join(root, '.shots/perf-investigation/deps/node_modules'), join(primary, 'node_modules')],
  alias: { '@nekko-agent/host': join(root, 'packages/host/src/index.ts'), '@nekko-agent/shared': join(root, 'packages/shared/src/index.ts'), '@nekko-agent/core': join(root, 'packages/core/src/index.ts'), 'nekko-agent/run': join(root, 'apps/cli/src/run.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
console.log(out);
