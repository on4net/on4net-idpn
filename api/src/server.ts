import { healthResponseSchema, type HealthResponse } from '@idpn/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Builds the HTTP application. Only the operational endpoints exist at this stage;
 * OIDC and Admin API routes are mounted here as they are implemented.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async (_request, reply) => {
    const payload: HealthResponse = { status: 'ok', service: 'on4net-idpn-api' };
    return reply.header('Cache-Control', 'no-store').send(healthResponseSchema.parse(payload));
  });

  return app;
}
