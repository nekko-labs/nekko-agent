// Check known generated footers in new PR metadata and commits. Do not scan diffs
// or rewrite anything: provider mentions, human credits and sign-offs are valid.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const generated = [
  /^\s*(?:🤖\s*)?(?:Generated|Created) with (?:\[Claude Code\](?:\([^\r\n]*?\))?|Claude Code)\s*[.!]?\s*$/im,
  /https:\/\/claude\.ai\/(?:code\/)?session(?:s?\/|_)[\w-]+/i,
];

const coauthorPrefix = 'co-authored-by:';
const generatedName = /^(?:claude|anthropic)$|^claude[ -](?:code|opus|sonnet|haiku)(?:[ -]|$)/;
const generatedDomain = /^(?:[\w-]+\.)?(?:anthropic\.com|claude\.ai)$/;

function hasGeneratedCoauthor(line) {
  const trailer = line.trim().toLowerCase();
  if (!trailer.startsWith(coauthorPrefix)) return false;
  const open = trailer.indexOf('<', coauthorPrefix.length);
  if (open === -1) return false;
  const name = trailer.slice(coauthorPrefix.length, open).trim();
  if (generatedName.test(name)) return true;
  const close = trailer.indexOf('>', open + 1);
  if (close === -1) return false;
  const email = trailer.slice(open + 1, close);
  const at = email.lastIndexOf('@');
  return at > 0 && !/\s/.test(email) && generatedDomain.test(email.slice(at + 1));
}

function hasGeneratedAttribution(text = '') {
  return text.split('\n').some(line => hasGeneratedCoauthor(line) || generated.some(re => re.test(line)));
}

export function attributionViolations(pr, commits) {
  return [
    ['PR title', pr.title], ['PR body', pr.body],
    ...commits.map(({ sha, commit }) => [`commit ${sha.slice(0, 12)}`, commit.message]),
  ].filter(([, text]) => hasGeneratedAttribution(text ?? '')).map(([where]) => where);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, file] = process.argv.slice(2);
  const violations = input === '--commit-msg'
    ? (hasGeneratedAttribution(readFileSync(file, 'utf8')) ? ['commit message'] : [])
    : attributionViolations(JSON.parse(readFileSync(input, 'utf8')).pull_request, JSON.parse(readFileSync(file, 'utf8')).flat());
  if (violations.length) {
    console.error(`Remove generated attribution or session links from: ${violations.join(', ')}.`);
    process.exitCode = 1;
  }
}
