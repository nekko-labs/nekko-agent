#!/usr/bin/env node
import { prepareUserDataRoot } from '@nekko-agent/host';
import { runCli, CliError, EXIT_CODES } from './run.js';
import { runBackend } from './backend.js';
import { BACKEND_FLAG } from './engine.js';

if (process.argv.includes(BACKEND_FLAG)) {
  // Started by the local engine (nekkod) as its TS host backend; see backend.ts.
  runBackend(process.env.NEKKO_DATA_DIR ?? prepareUserDataRoot()).catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
} else {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = e instanceof CliError ? e.exitCode : EXIT_CODES.providerFailure;
  });
}
