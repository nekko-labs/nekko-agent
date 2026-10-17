import { join, resolve } from 'node:path';

export const repo = resolve(__dirname, '../../..');
/** Everything the suite writes stays in the ignored .shots directory. */
export const shots = join(repo, '.shots/e2e');
export const build = join(shots, 'build');
export const index = join(build, 'index.html');
