import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Exercise the real entry point, not a second copy of its routing logic. Keep
// runtime dependencies external, like scripts/bundle.mjs, and inline CLI version.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')).version;
let bundleDir: string;
const profiles: string[] = [];

beforeAll(async () => {
  // Node resolves the external packages through this checkout, not a global install.
  bundleDir = mkdtempSync(join(root, 'node_modules/.cli-entry-'));
  await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    outfile: join(bundleDir, 'index.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    external: ['fastify', '@fastify/static', '@fastify/websocket'],
    banner: { js: "import { createRequire as __nekkoCreateRequire } from 'node:module'; const require = __nekkoCreateRequire(import.meta.url);" },
    plugins: [{ name: 'inline-cli-version', setup(b) {
      b.onLoad({ filter: /[\\/]apps[\\/]cli[\\/]dist[\\/]version\.js$/ }, () => ({
        contents: `export const VERSION = ${JSON.stringify(version)};`, loader: 'js',
      }));
    } }],
  });
});

afterAll(() => {
  for (const dir of [...profiles, bundleDir].filter(Boolean)) rmSync(dir, { recursive: true, force: true });
});

function invoke(args: string[]): Promise<{ code: number | string; stdout: string; stderr: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'nekko-cli-entry-'));
  profiles.push(profile);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(bundleDir, 'index.mjs'), ...args], {
      cwd: profile,
      // No real app profile, CLI link, relay, credentials, or daemon is available.
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
        XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile,
        NEKKO_DATA_DIR: join(profile, 'data'), NEKKOD_PATH: join(profile, 'no-daemon'),
        NEKKO_RENDERER_DIR: join(profile, 'no-renderer'),
      },
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) { reject(error); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

describe('Local Web UI embedded CLI', () => {
  it.each([['--help'], ['help'], ['scheduled-task', '--help'], ['local', '--help'], ['computer', '--help'], ['migrate', '--help']])('shows help without starting the server: %j', async (...args) => {
    const result = await invoke(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nekko Agent CLI');
    expect(result.stderr).toBe('');
  });

  it.each([['--version'], ['version']])('prints only the CLI version: %j', async (...args) => {
    expect(await invoke(args)).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });
  });

  it.each(['scheduled-task', 'scheduled-tasks', 'workflow', 'workflows', 'local', 'computer', 'workspace', 'tasks', 'train'])('preserves %s usage failures instead of starting a server', async (command) => {
    const result = await invoke([command, 'invalid', '--url', 'http://127.0.0.1:1']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: nekko-agent');
    expect(result.stdout).toBe('');
  });

  it('rejects an unknown command without falling through to server startup', async () => {
    const result = await invoke(['not-a-command']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command: not-a-command');
    expect(result.stdout).toBe('');
  });

  it('preserves the unreachable-remote exit code', async () => {
    const result = await invoke(['scheduled-task', 'list', '--url', 'http://127.0.0.1:1']);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('fetch failed');
    expect(result.stdout).toBe('');
  });

  it('keeps no-argument invocation on the server startup path', async () => {
    const result = await invoke([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Renderer not found|not supported/);
    expect(result.stdout).not.toContain('Nekko Agent CLI');
  });

  it('passes leading target flags and every scheduled-task alias through to the real HTTP client', async () => {
    const requests: Array<{ url: string | undefined; token: string | undefined; body: string }> = [];
    const workflows = [{ id: 'task-1', name: 'Nightly check', enabled: true }];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ url: req.url, token: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/workflows:list' ? { workflows, runs: [] } : []));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      for (const command of ['scheduled-task', 'scheduled-tasks', 'workflow', 'workflows']) {
        const result = await invoke(['--url', `http://127.0.0.1:${port}`, '--token', 'fixture-token', command, 'list', '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(workflows);
        expect(result.stderr).toBe('');
      }
      for (const command of ['local', 'computer']) {
        const result = await invoke([command, 'list', '--url', `http://127.0.0.1:${port}`, '--token', 'fixture-token', '--json']);
        expect(result).toEqual({ code: 0, stdout: '[]\n', stderr: '' });
      }
      expect(requests).toEqual([
        ...Array.from({ length: 4 }, () => '/api/workflows:list'),
        '/api/engine:models', '/api/remote:devices',
      ].map((url) => ({ url, token: 'Bearer fixture-token', body: '{"args":[]}' })));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
});
