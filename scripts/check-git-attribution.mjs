// Check known generated footers in new PR metadata and commits. Do not scan diffs
// or rewrite anything: provider mentions, human credits and sign-offs are valid.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const generated = [
  /^\s*Co-Authored-By:\s*(?:(?:Claude(?:[ -](?:Code|Opus|Sonnet|Haiku)(?:[ -][\w.-]+)*)?|Anthropic)\s*<|[^\r\n<]*<[^\s>]+@(?:[\w-]+\.)?(?:anthropic\.com|claude\.ai)>)/im,
  /^\s*(?:🤖\s*)?(?:Generated|Created) with (?:\[Claude Code\](?:\([^\r\n]*?\))?|Claude Code)\s*[.!]?\s*$/im,
  /https:\/\/claude\.ai\/(?:code\/)?session(?:s?\/|_)[\w-]+/i,
];

export function attributionViolations(pr, commits) {
  return [
    ['PR title', pr.title], ['PR body', pr.body],
    ...commits.map(({ sha, commit }) => [`commit ${sha.slice(0, 12)}`, commit.message]),
  ].filter(([, text]) => generated.some(re => re.test(text ?? ''))).map(([where]) => where);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, file] = process.argv.slice(2);
  const violations = input === '--commit-msg'
    ? (generated.some(re => re.test(readFileSync(file, 'utf8'))) ? ['commit message'] : [])
    : attributionViolations(JSON.parse(readFileSync(input, 'utf8')).pull_request, JSON.parse(readFileSync(file, 'utf8')).flat());
  if (violations.length) {
    console.error(`Remove generated attribution or session links from: ${violations.join(', ')}.`);
    process.exitCode = 1;
  }
}
