#!/usr/bin/env node
import { runCli, CliError, EXIT_CODES } from './run.js';

runCli(process.argv.slice(2)).catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exitCode = e instanceof CliError ? e.exitCode : EXIT_CODES.providerFailure;
});
