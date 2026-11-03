/**
 * `redact()` from crates/nekkod/src/logs.rs, for the app log's writes: the
 * same ECMAScript patterns in the same order, held to the same golden
 * (crates/nekkod/tests/golden/log-redact.json) by logRedact.test.ts.
 */
export const REDACTED = '[redacted]';

const USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const SCHEME = /\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const QUERY = /([?&](?:room|key|pair|code|token|access_token|refresh_token|id_token|sig|signature|auth|password|secret|apikey|api_key)=)[^&\s#]+/gi;
const PAIRS = /(?<![A-Za-z0-9])((?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|x-api-key|key)["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi;
const TOKENS = /(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const HEX = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** A long base64-ish run that looks like a key, not a path or a word. */
function looksLikeKey(run: string): boolean {
  if (!(/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run))) return false;
  return !run.includes('/') || run.split('/').every((part) => part.length >= 24 || part === '');
}

/** One line with anything that looks like a secret replaced by `[redacted]`. */
export function redact(line: string): string {
  if (PRIVATE_KEY.test(line)) return `${REDACTED} private key`;
  return line
    .replace(USERINFO, (_m, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(SCHEME, (_m, name: string) => `${name} ${REDACTED}`)
    .replace(QUERY, (_m, key: string) => `${key}${REDACTED}`)
    .replace(PAIRS, (_m, key: string, value: string) =>
      value.startsWith(REDACTED) || /^(bearer|basic)$/i.test(value) ? `${key}${value}` : `${key}${REDACTED}`)
    .replace(TOKENS, REDACTED)
    .replace(HEX, REDACTED)
    .replace(RUN, (run) => (looksLikeKey(run) ? REDACTED : run));
}
