// The demo project (a small bakery website) as every take expects it: a git
// repository at its first commit, with an old-menu folder to delete. The
// first run commits whatever is there; later runs throw away a take's edits.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=Sunny Side Bakery', '-c', 'user.email=hello@example.com', ...a], { cwd: dir, stdio: 'pipe' }).toString();

export function resetBakery(dir) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`No demo project at ${dir}. Pass --project <dir> or set NEKKO_DEMO_PROJECT.`);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(dir, 'old-menu'), { recursive: true });
    writeFileSync(join(dir, 'old-menu', 'winter-menu.txt'), 'Winter menu (retired)\nMince pie £1.80\nStollen slice £2.40\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Bakery website');
    return;
  }
  git(dir, 'reset', '-q', '--hard', 'HEAD');
  git(dir, 'clean', '-q', '-fd');
}
