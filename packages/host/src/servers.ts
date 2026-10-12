import { execFile } from 'child_process';

/**
 * Stop a local model server (Ollama / LM Studio / vLLM / any local endpoint) by
 * terminating whatever process is listening on its port. There's no portable
 * HTTP "shutdown" across these servers, so we resolve the listening PID from the
 * OS and kill its process tree. Best-effort and clearly reported: the UI shows
 * the returned message either way.
 */
export async function stopLocalServer(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  const port = portOf(baseUrl);
  if (!port) return { ok: false, message: 'Could not work out the server port from its URL.' };

  const pids = await pidsOnPort(port);
  if (pids.length === 0) {
    return { ok: false, message: `Nothing is listening on port ${port}; it may already be stopped.` };
  }

  let killed = 0;
  for (const pid of pids) {
    if (await killTree(pid)) killed++;
  }
  return killed > 0
    ? { ok: true, message: `Stopped the server on port ${port}.` }
    : { ok: false, message: `Couldn't stop the process on port ${port} (it may need elevated permissions).` };
}

/** Extract the TCP port from a base URL, defaulting by scheme. */
function portOf(baseUrl: string): number | null {
  try {
    const u = new URL(baseUrl);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    const m = baseUrl.match(/:(\d{2,5})(?:\D|$)/);
    return m ? Number(m[1]) : null;
  }
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      // taskkill/lsof exit non-zero when nothing matches; treat as "no output".
      resolve(err && !stdout ? null : stdout ?? '');
    });
  });
}

/** PIDs listening on a TCP port (Windows via netstat, POSIX via lsof). */
async function pidsOnPort(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'tcp']);
    if (!out) return [];
    const pids = new Set<number>();
    for (const line of out.split('\n')) {
      // e.g. "  TCP    0.0.0.0:11434   0.0.0.0:0   LISTENING   12345"
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? '';
      if (local.endsWith(`:${port}`)) {
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  }
  // macOS / Linux
  const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (!out) return [];
  return [...new Set(out.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Kill a process and its children. Returns whether the kill was issued cleanly. */
async function killTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const out = await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return out !== null;
  }
  try {
    process.kill(pid, 'SIGTERM');
    // Escalate shortly after if it's still alive.
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 1500);
    return true;
  } catch {
    return false;
  }
}
