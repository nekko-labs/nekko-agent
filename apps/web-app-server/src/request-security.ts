import type { FastifyReply, FastifyRequest } from 'fastify';
import { hostAllowed, originAllowed, tokenMatches } from './security.js';

export interface RequestSecurityOptions {
  host: string;
  port: number;
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export function createApiSecurityHook(options: RequestSecurityOptions) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.url.startsWith('/api/')) return;
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
