import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function validateBindSecurity(host: string, token: string, allowUnauthenticated: boolean): void {
  if (!isLoopbackHost(host) && !token && !allowUnauthenticated) {
    throw new Error(
      `Refusing to bind Nekko Agent to ${host} without authentication. Set NEKKO_TOKEN=<strong-random-token>, or explicitly set NEKKO_ALLOW_UNAUTHENTICATED=1 when another trusted auth layer protects this service.`,
    );
  }
}

export function tokenMatches(expected: string, supplied?: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function hostAllowed(hostHeader: string | undefined, configuredHost: string, port: number, allowlist: string[]): boolean {
  if (!hostHeader) return false;
  const defaults = [`${configuredHost}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  const literal = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1]
    ?? hostHeader.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/)?.[1];
  if (literal && isIP(literal)) return true;
  return [...defaults, ...allowlist].some((allowed) => allowed.toLowerCase() === hostHeader.toLowerCase());
}

export function originAllowed(
  origin: string | undefined,
  protocol: string,
  hostHeader: string | undefined,
  allowlist: string[],
): boolean {
  if (!origin) return true;
  if (allowlist.includes(origin)) return true;
  try {
    return new URL(origin).protocol === `${protocol}:` && new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}
