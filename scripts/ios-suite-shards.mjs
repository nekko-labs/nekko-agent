// Native iOS's matrix and batch reporter (#2035). A matrix result is success only
// after every leg succeeds; missing, skipped or unknown results must never pass.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BATCH_BRANCH, BATCH_CONTEXT } from './ios-batch.mjs';

export const SUITE_SHARDS = ['fixtures', 'pairing', 'journeys'];

export function validateShard(shard) {
  if (!SUITE_SHARDS.includes(shard)) throw new Error(`Unknown Native iOS suite shard: ${shard}`);
  return shard;
}

export const batchState = result => result === 'success' ? 'success' : result === 'cancelled' ? 'error' : 'failure';

const gh = args => execFileSync('gh', args, { encoding: 'utf8' }).trim();

/** Only the aggregate job calls this, never an individual matrix leg. */
export function reportBatch({ result, batch, repository, sha, url }, request = gh) {
  const prs = JSON.parse(batch);
  // Validate the entire batch before posting anything, not partway through it.
  if (!Array.isArray(prs) || !prs.length || prs.some(pr => !Number.isSafeInteger(pr?.number) || pr.number < 1 || !/^[0-9a-f]{40}$/.test(pr.sha))) {
    throw new Error('Invalid Native iOS batch');
  }
  const state = batchState(result);
  // A newer compose already gave these heads their status. Preserve that status.
  if (state === 'error' && request(['api', `repos/${repository}/git/ref/heads/${BATCH_BRANCH}`, '--jq', '.object.sha']) !== sha) {
    return { state, reported: 0, superseded: true };
  }
  const numbers = prs.map(pr => `#${pr.number}`).join(', ');
  for (const pr of prs) {
    request(['api', '-X', 'POST', `repos/${repository}/statuses/${pr.sha}`,
      '-f', `state=${state}`, '-f', `context=${BATCH_CONTEXT}`, '-f', `target_url=${url}`,
      '-f', `description=Native iOS ${state === 'error' ? 'cancelled or timed out' : state} on the batch ${numbers}`]);
  }
  return { state, reported: prs.length, superseded: false };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'shard' && args.length === 1) {
    console.log(validateShard(args[0]));
  } else if (command === 'report' && !args.length) {
    const { RESULT: result, BATCH: batch, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, URL: url } = process.env;
    const outcome = reportBatch({ result, batch, repository, sha, url });
    console.log(JSON.stringify(outcome));
    if (outcome.state !== 'success' && !outcome.superseded) process.exitCode = 1;
  } else {
    throw new Error('Usage: ios-suite-shards.mjs shard <fixtures|pairing|journeys> | report');
  }
}
