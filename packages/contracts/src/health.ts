import { z } from 'zod';

/** Liveness probe served by the API (`GET /healthz`). */
export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal('on4net-idpn-api'),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
