#!/usr/bin/env node
/**
 * Record how the user's installed Claude Code behaves when driven headless,
 * for the Claude Code harness provider (TASKS.md CL0, CL4).
 *
 * Runs the unmodified `claude` binary in a throwaway CLAUDE_CONFIG_DIR, so it
 * never sees or touches anyone's Claude login, and writes every stream-json
 * line it prints to <out>/<scenario>.jsonl. It never reads credential files.
 *
 *   node scripts/claude-code-probe.mjs --out <dir>              # unauthenticated only
 *   ANTHROPIC_API_KEY=<test key> node scripts/claude-code-probe.mjs --out <dir> --auth [--only a,b]
 *
 * Scenarios: version, auth status, a turn with no credentials, and with --auth
 * a plain turn, a two-turn session over one process, a resume by session id,
 * an interrupt by signal and by stream-json control message, steering with a
 * second message mid-turn, and a tool call that needs permission.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The child's environment: the caller's, minus every auth source but a test key. */
export function probeEnv(base, configDir, withKey) {
  const env = { ...base, CLAUDE_CONFIG_DIR: configDir };
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    delete env[k];
  }
  if (!withKey) delete env.ANTHROPIC_API_KEY;
  return env;
}

/** One stream-json user line. */
export function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

const WIN = process.platform === 'win32';

/**
 * The installed binary. On Windows npm installs a .cmd shim, which only a
 * shell starts, so it is found with where.exe and quoted for cmd.
 */
function claudeBin() {
  if (!WIN) return 'claude';
  const found = execFileSync('where.exe', ['claude']).toString().split(/\r?\n/).filter(Boolean);
  const bin = found.find((p) => /\.(cmd|exe)$/i.test(p));
  if (!bin) throw new Error('claude is not installed (where.exe found no .cmd or .exe)');
  return `"${bin}"`;
}

function claude(args, env, cwd) {
  return spawn(claudeBin(), args, { env, cwd, shell: WIN, stdio: ['pipe', 'pipe', 'pipe'] });
}

const STREAM = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/** Run one scenario: write `inputs` (strings or {after, line}) and collect stdout lines. */
function run(name, args, inputs, env, cwd, out, { timeoutMs = 120_000, onLine } = {}) {
  return new Promise((done) => {
    const child = claude(args, env, cwd);
    const lines = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lines.push(line);
        onLine?.(line, child);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(join(out, `${name}.jsonl`), lines.join('\n') + '\n');
      if (stderr) writeFileSync(join(out, `${name}.stderr.txt`), stderr);
      console.log(`${name}: exit ${code}, ${lines.length} lines`);
      done({ code, lines });
    });
    for (const input of inputs) child.stdin.write(input);
    if (!onLine) child.stdin.end();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const outArg = argv[argv.indexOf('--out') + 1];
  if (!argv.includes('--out') || !outArg) throw new Error('Usage: claude-code-probe.mjs --out <dir> [--auth]');
  const auth = argv.includes('--auth');
  if (auth && !process.env.ANTHROPIC_API_KEY) throw new Error('--auth needs ANTHROPIC_API_KEY set to a test key');

  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const configDir = mkdtempSync(join(tmpdir(), 'claude-probe-config-'));
  const cwd = mkdtempSync(join(tmpdir(), 'claude-probe-work-'));
  const env = probeEnv(process.env, configDir, auth);
  try {
    const shell = WIN;
    const bin = claudeBin();
    writeFileSync(join(out, 'version.txt'), execFileSync(bin, ['--version'], { env, shell }).toString());
    try {
      writeFileSync(join(out, 'auth-status.json'), execFileSync(bin, ['auth', 'status'], { env, shell }).toString());
    } catch (e) {
      // Exit 1 when signed out; the JSON is still on stdout.
      writeFileSync(join(out, 'auth-status.json'), String(e.stdout ?? ''));
    }
    if (!auth) {
      await run('turn-no-credentials', STREAM, [userLine('Say hi.')], env, cwd, out);
      return;
    }
    const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
    const wanted = (name) => !only || only.includes(name);
    const LONG = 'Count slowly from 1 to 200, one number per line.';
    const PARTIAL = [...STREAM, '--include-partial-messages'];
    const firstDelta = (line) => line.includes('"text_delta"');
    let init;

    if (wanted('turn') || wanted('resume')) {
      const first = await run('turn', STREAM, [userLine('Reply with the single word: ready')], env, cwd, out);
      init = first.lines.map((l) => JSON.parse(l)).find((e) => e.type === 'system' && e.subtype === 'init');
    }

    // Two turns over one process: the second line is written after the first result.
    if (wanted('two-turns')) {
      let sent = 1;
      await run('two-turns', STREAM, [userLine('Remember the number 7. Reply ok.')], env, cwd, out, {
        onLine: (line, child) => {
          if (JSON.parse(line).type !== 'result') return;
          if (sent === 1) {
            sent = 2;
            child.stdin.write(userLine('What number did I ask you to remember?'));
          } else child.stdin.end();
        },
      });
    }

    if (wanted('resume') && init?.session_id) {
      await run('resume', [...STREAM, '--resume', init.session_id], [userLine('What single word did you reply with before?')], env, cwd, out);
    }

    // Interrupt by signal once text starts streaming. On Windows the child is
    // the cmd shim, so only a tree kill reaches Claude Code.
    if (wanted('interrupt')) {
      let interrupted = false;
      await run('interrupt', PARTIAL, [userLine(LONG)], env, cwd, out, {
        onLine: (line, child) => {
          if (interrupted || !firstDelta(line)) return;
          interrupted = true;
          if (WIN) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          else child.kill('SIGINT');
        },
        timeoutMs: 60_000,
      });
    }

    // Interrupt over stdin with the control message the Agent SDK sends,
    // which init's `interrupt_receipt_v1` capability suggests the CLI takes.
    // The process should stay up and answer a follow-up turn.
    if (wanted('interrupt-control')) {
      let step = 0;
      await run('interrupt-control', PARTIAL, [userLine(LONG)], env, cwd, out, {
        onLine: (line, child) => {
          if (step === 0 && firstDelta(line)) {
            step = 1;
            child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'probe-interrupt-1', request: { subtype: 'interrupt' } }) + '\n');
          } else if (step === 1 && JSON.parse(line).type === 'result') {
            step = 2;
            child.stdin.write(userLine('Reply with the single word: still-here'));
          } else if (step === 2 && JSON.parse(line).type === 'result') {
            child.stdin.end();
          }
        },
        timeoutMs: 90_000,
      });
    }

    // Steering: a second user line while the first turn is still streaming.
    if (wanted('steer')) {
      let step = 0;
      let results = 0;
      await run('steer', [...PARTIAL, '--replay-user-messages'], [userLine(LONG)], env, cwd, out, {
        onLine: (line, child) => {
          if (step === 0 && firstDelta(line)) {
            step = 1;
            child.stdin.write(userLine('Stop counting. Instead reply with the single word: steered'));
          } else if (JSON.parse(line).type === 'result' && ++results >= 2) {
            child.stdin.end();
          }
        },
        timeoutMs: 90_000,
      });
    }

    // A tool that needs permission, with nobody to answer: shows the deny path.
    if (wanted('permission-denied')) {
      await run('permission-denied', [...STREAM, '--permission-prompts', 'none'], [userLine('Create a file named probe.txt containing hello.')], env, cwd, out);
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
