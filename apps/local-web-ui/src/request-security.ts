import type { FastifyReply, FastifyRequest } from 'fastify';
import { hostAllowed, originAllowed, tokenMatches } from './security.js';

export interface RequestSecurityOptions {
  host: string;
  port: number;
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

/**
 * Only origin-form request targets (`/path?query`) are served. The router
 * accepts other forms (an absolute URL) and normalizes them, so a check on the
 * raw target alone could disagree with the route that answers.
 */
export function isOriginForm(target: string | undefined): boolean {
  return typeof target === 'string' && target.startsWith('/');
}

/** Whether a request is an API call: decided on the route that matched, as well as on the raw target. */
export function isApiRequest(routeUrl: string | undefined, target: string): boolean {
  return (routeUrl ?? '').startsWith('/api/') || target.startsWith('/api/');
}

export function createApiSecurityHook(options: RequestSecurityOptions) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const target = req.raw.url ?? '';
    if (!isOriginForm(target)) {
      reply.code(400).send({ error: 'invalid request target' });
      return;
    }
    if (!isApiRequest(req.routeOptions.url, target)) return;
    if (!hostAllowed(req.headers.host, options.host, options.port, options.allowedHosts)) {
      reply.code(400).send({ error: 'invalid host' });
      return;
    }
    if (!originAllowed(req.headers.origin, req.protocol, req.headers.host, options.allowedOrigins)) {
      reply.code(403).send({ error: 'origin not allowed' });
      return;
    }
    if (!options.token) return;
    const header = req.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!tokenMatches(options.token, bearer)) reply.code(401).send({ error: 'unauthorized' });
  };
}
