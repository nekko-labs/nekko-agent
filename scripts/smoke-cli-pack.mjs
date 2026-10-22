import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'nekko-agent-cli-pack-'));
const tarballs = join(temp, 'tarballs');
const unpacked = join(temp, 'package');
const installed = join(temp, 'installed');
const binDir = join(installed, 'node_modules/.bin');
const executables = ['nekko-agent'];
let mcp;
let mcpClosed;
const dataDir = join(temp, 'data');
const workspace = join(temp, 'workspace');
// The CLI's local mode runs nekkod. The published package gets it from its
// platform dependency; here, from this checkout's build (CI builds it first).
const nekkod = ['debug', 'release']
  .map((profile) => join(root, 'target', profile, process.platform === 'win32' ? 'nekkod.exe' : 'nekkod'))
  .find((p) => existsSync(p));
if (!nekkod) throw new Error('Build nekkod first (cargo build -p nekkod): the CLI runs its local engine on it.');
const cliEnv = { ...process.env, NEKKO_URL: '', NEKKO_DATA_DIR: dataDir, NEKKOD_PATH: nekkod };
mkdirSync(tarballs);
mkdirSync(installed);
mkdirSync(dataDir);
mkdirSync(workspace);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}

function jsonCommand(args, executable = 'nekko-agent') {
  const output = run(join(binDir, executable), args, {
    cwd: temp,
    env: cliEnv,
  });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Expected JSON from ${args.join(' ')}:\n${output}`, { cause: error });
  }
}

try {
  run('npm', ['run', 'build:publish', '--workspace=apps/cli']);
  const packed = run('npm', ['pack', '--workspace=apps/cli', '--pack-destination', tarballs]);
  const tarball = join(tarballs, packed.split('\n').at(-1));
  run('tar', ['-xzf', tarball, '-C', temp]);
  const packageJson = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'));
  const runTypes = join(unpacked, 'dist/run.d.ts');
  // Both spellings of a bin path are valid and npm has normalized between them
  // across versions, so compare what the entry points at rather than how it is
  // written. Asserting the exact string is what made this check fail on a
  // package that was correct (see the `./` prefix dropped in #151).
  const binTarget = (value) => (typeof value === 'string' ? value.replace(/^\.\//, '') : undefined);
  const bins = Object.fromEntries(
    Object.entries(packageJson.bin ?? {}).map(([name, value]) => [name, binTarget(value)]),
  );
  if (executables.some((name) => bins[name] !== 'dist/index.js')) {
    throw new Error(
      `Packed package is missing the nekko-agent bin entry (got ${JSON.stringify(packageJson.bin)}).`,
    );
  }
  if (packageJson.name !== 'nekko-agent' || packageJson.repository?.url !== 'git+https://github.com/nekko-labs/nekko-agent.git') {
    throw new Error('Published package identity must be nekko-agent.');
  }
  const packedDist = readdirSync(join(unpacked, 'dist')).sort();
  const expectedDist = ['engine.js', 'index.d.ts', 'index.js', 'run.d.ts', 'run.js'];
  if (JSON.stringify(packedDist) !== JSON.stringify(expectedDist)) {
    throw new Error(`Packed package contains unexpected dist files: ${packedDist.join(', ')}`);
  }
  statSync(join(unpacked, 'dist/index.js'));
  statSync(runTypes);
  if (packageJson.exports?.['./run']?.types !== './dist/run.d.ts') {
    throw new Error('The ./run export does not declare dist/run.d.ts.');
  }

  run('npm', ['install', '--prefix', unpacked, '--ignore-scripts', '--no-package-lock']);
  symlinkSync('..', join(unpacked, 'node_modules/nekko-agent'), 'dir');
  const runImport = run(
    process.execPath,
    ['-e', "import('nekko-agent/run').then((m) => console.log(typeof m.runCli))"],
    { cwd: unpacked, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (runImport !== 'function') throw new Error(`nekko-agent/run import failed: ${runImport}`);
  console.log(`nekko-agent/run import: ${runImport}`);

  run('npm', ['install', '--prefix', installed, '--ignore-scripts', '--no-package-lock', tarball]);
  for (const executable of executables) {
    const options = { cwd: temp, env: cliEnv };
    const help = run(join(binDir, executable), ['--help'], options);
    if (!help.startsWith('Nekko Agent CLI (nekko-agent ')) {
      throw new Error(`${executable} --help did not identify Nekko Agent.`);
    }
    const version = run(join(binDir, executable), ['--version'], options);
    if (version !== packageJson.version) throw new Error(`${executable} --version returned ${version}.`);
    const humanStatus = run(join(binDir, executable), ['status'], options);
    if (!humanStatus.startsWith('Nekko Agent, ')) throw new Error(`${executable} status used the wrong identity.`);
    const status = jsonCommand(['status', '--json'], executable);
    if (!Array.isArray(status.workspaces)) throw new Error(`${executable} status did not return workspaces.`);
    console.log(`${executable}: installed binary help, version, and status passed`);
  }

  const status = jsonCommand(['status', '--json']);
  if (!Array.isArray(status.workspaces)) throw new Error('status did not return workspaces.');
  console.log(`status --json: ${JSON.stringify(status)}`);

  const added = jsonCommand(['workspace', 'add', workspace, '--json']);
  if (!added.some((item) => item.path === workspace)) {
    throw new Error('workspace add returned the wrong path.');
  }
  console.log(`workspace add: ${JSON.stringify(added)}`);
  const listed = jsonCommand(['workspace', 'list', '--json']);
  if (!listed.some((item) => item.path === workspace)) {
    throw new Error('workspace list did not contain the added workspace.');
  }
  console.log(`workspace list: ${JSON.stringify(listed)}`);

  for (const executable of executables) {
    mcp = spawn(join(binDir, executable), ['mcp'], {
      cwd: temp,
      env: cliEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcpClosed = new Promise((resolveClosed) => mcp.once('close', resolveClosed));
    let buffer = '';
    const waiters = new Map();
    mcp.stdout.setEncoding('utf8');
    mcp.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          waiter(message);
        }
      }
    });
    const request = (id, method, params = {}) =>
      new Promise((resolveResponse, reject) => {
        const timer = setTimeout(() => {
          if (waiters.delete(id)) reject(new Error(`Timed out waiting for MCP response ${id}.`));
        }, 10_000);
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolveResponse(message);
        });
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const initialize = await request(1, 'initialize', { protocolVersion: '2025-06-18' });
    if (initialize.result?.protocolVersion !== '2025-06-18') {
      throw new Error(`Unexpected MCP protocol version: ${initialize.result?.protocolVersion}`);
    }
    if (initialize.result?.serverInfo?.name !== 'nekko-agent' || initialize.result?.serverInfo?.title !== 'Nekko Agent') {
      throw new Error('MCP initialize did not identify Nekko Agent.');
    }
    console.log(`${executable} MCP initialize: ${JSON.stringify(initialize)}`);
    mcp.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const tools = await request(2, 'tools/list');
    if (!tools.result?.tools?.some((tool) => tool.name === 'nekko-agent_status') ||
        !tools.result.tools.every((tool) => tool.name.startsWith('nekko-agent_'))) {
      throw new Error('MCP tools/list must advertise only canonical nekko-agent_* tools, including nekko-agent_status.');
    }
    console.log(`${executable} MCP tools/list: ${tools.result.tools.length} canonical tools`);
    const canonical = await request(3, 'tools/call', { name: 'nekko-agent_status', arguments: {} });
    if (canonical.result?.isError || !canonical.result?.content?.[0]?.text?.includes('"workspaces"')) {
      throw new Error('MCP nekko-agent_status returned no status payload.');
    }
    console.log(`${executable} MCP tools/call: nekko-agent_status ok`);
    // Closing stdin is how an MCP client ends a session; the engine stops with it.
    mcp.stdin.end();
    await mcpClosed;
    mcp = undefined;
  }
  console.log(`CLI package smoke test passed: ${packageJson.name}@${packageJson.version}`);
} finally {
  if (mcp) {
    mcp.kill();
    await mcpClosed;
  }
  rmSync(temp, { recursive: true, force: true });
}
