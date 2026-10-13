// The banner `npm run dev` prints once the app is actually up: what is
// running, where, and how to stop it. Pure, so it can be tested as text.

const ART = [
  '   /\\_/\\    _   _      _    _             _                    _   ',
  '  ( o.o )  | \\ | | ___| | _| | _____     / \\   __ _  ___ _ __ | |_ ',
  '   > ^ <   |  \\| |/ _ \\ |/ / |/ / _ \\   / _ \\ / _` |/ _ \\ \'_ \\| __|',
  '  /|   |\\  | |\\  |  __/   <|   < (_) | / ___ \\ (_| |  __/ | | | |_ ',
  ' (_|___|_) |_| \\_|\\___|_|\\_\\_|\\_\\___/ /_/   \\_\\__, |\\___|_| |_|\\__|',
  '                                                |___/  dev build    ',
];

/**
 * @param {{ version?: string, api?: { url: string, enabled: boolean } | null, renderer?: string, dataDir?: string, pid?: number, color?: boolean }} info
 */
export function devBanner(info) {
  const c = info.color ? { dim: (s) => `\x1b[2m${s}\x1b[22m`, accent: (s) => `\x1b[38;5;141m${s}\x1b[39m`, ok: (s) => `\x1b[32m${s}\x1b[39m`, key: (s) => `\x1b[1m${s}\x1b[22m` }
    : { dim: (s) => s, accent: (s) => s, ok: (s) => s, key: (s) => s };
  const row = (label, value) => `  ${c.dim(label.padEnd(10))} ${value}`;
  const lines = [
    '',
    ...ART.map((l) => c.accent(l)),
    '',
    `  ${c.ok('●')} Nekko Agent${info.version ? ` ${info.version}` : ''} is running${info.pid ? c.dim(` (pid ${info.pid})`) : ''}`,
    '',
    row('API', info.api ? (info.api.enabled ? info.api.url : `${info.api.url} ${c.dim('(off: switch it on in Settings > Server)')}`) : c.dim('not reported')),
  ];
  if (info.renderer) lines.push(row('Renderer', `${info.renderer} ${c.dim('(hot reload)')}`));
  if (info.dataDir) lines.push(row('Data', info.dataDir));
  lines.push(
    '',
    `  ${c.key('q')} or ${c.key('Enter')}  stop cleanly ${c.dim('(engine and model servers shut down first)')}`,
    `  ${c.key('Ctrl+C')}      same, and press again to force`,
    '',
  );
  return lines.join('\n');
}
