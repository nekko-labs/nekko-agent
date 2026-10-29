/**
 * Reading the environment variables this app uses.
 *
 * `NEKKO_` is the only prefix; it is what the docs and help text advertise.
 */
export const ENV_PREFIXES = ['NEKKO_'] as const;

/**
 * The value of `NEKKO_<name>`. An empty string counts as set (it is how a
 * caller turns a default off), so this checks presence rather than truthiness.
 *
 * `process` is reached through `globalThis` rather than referenced directly:
 * this package is also imported by the renderer, which is typed without node
 * and where `process` may genuinely not exist.
 */
export function brandEnv(name: string, env?: Record<string, string | undefined>): string | undefined {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  for (const prefix of ENV_PREFIXES) {
    const value = source[`${prefix}${name}`];
    if (value !== undefined) return value;
  }
  return undefined;
}
