import { z } from 'zod';

import { healthResponseSchema } from './health.js';
import { MFE_SCHEMA_VERSION, mfeConfigSchema, mfeEventSchema } from './mfe.js';
import { publicClientConfigSchema } from './public-config.js';

export const OPENAPI_VERSION = '3.1.0';
export const API_VERSION = '0.1.0';
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const toJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
  });
  return rest;
};

const withMeta = (
  schema: z.ZodType,
  id: string,
  title: string,
  description: string,
): Record<string, unknown> => ({
  $schema: JSON_SCHEMA_DIALECT,
  $id: id,
  title,
  description,
  ...toJsonSchema(schema),
});

const jsonResponse = (description: string, schemaRef: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schemaRef}` },
    },
  },
});

/** OpenAPI 3.1 document for the endpoints implemented so far. */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'on4net IDPN API',
      version: API_VERSION,
      description:
        'OpenID Connect identity provider. This document only lists implemented endpoints; ' +
        'OIDC and Admin API operations are added as they land.',
    },
    paths: {
      '/healthz': {
        get: {
          operationId: 'getHealth',
          summary: 'Liveness probe',
          responses: {
            '200': jsonResponse('Service is running', 'HealthResponse'),
          },
        },
      },
      '/api/v1/clients/{clientId}/public-config': {
        get: {
          operationId: 'getPublicClientConfig',
          summary: 'Public configuration of a client',
          parameters: [
            {
              name: 'clientId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': jsonResponse('Public configuration', 'PublicClientConfig'),
            '404': { description: 'Unknown or disabled client' },
            '429': { description: 'Rate limited' },
          },
        },
      },
    },
    components: {
      schemas: {
        HealthResponse: toJsonSchema(healthResponseSchema),
        PublicClientConfig: toJsonSchema(publicClientConfigSchema),
      },
    },
  };
}

export const renderOpenApiDocument = (): string =>
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

export const buildMfeConfigJsonSchema = (): Record<string, unknown> =>
  withMeta(
    mfeConfigSchema,
    'https://idpn.example.com/contracts/mfe-config.schema.json',
    'IdpnMfeConfig',
    `Micro-frontend configuration contract, schema version ${MFE_SCHEMA_VERSION}.`,
  );

export const buildMfeEventJsonSchema = (): Record<string, unknown> =>
  withMeta(
    mfeEventSchema,
    'https://idpn.example.com/contracts/mfe-event.schema.json',
    'IdpnEvent',
    `Micro-frontend event contract, schema version ${MFE_SCHEMA_VERSION}.`,
  );

export const renderMfeConfigJsonSchema = (): string =>
  `${JSON.stringify(buildMfeConfigJsonSchema(), null, 2)}\n`;

export const renderMfeEventJsonSchema = (): string =>
  `${JSON.stringify(buildMfeEventJsonSchema(), null, 2)}\n`;
