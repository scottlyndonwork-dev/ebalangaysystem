import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { API_VERSION } from '../version.js';

const isZod = (s: unknown): s is z.ZodType => s instanceof z.ZodType;
const toJson = (schema: unknown, io: 'input' | 'output') =>
  isZod(schema)
    ? z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' })
    : schema;

/** OpenAPI from the same Zod schemas routes validate with. Served at /docs when enabled. */
export const swaggerPlugin = fp(
  async (app) => {
    if (!app.env.DOCS_ENABLED) return;
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: { title: 'eBalangay API', version: API_VERSION },
        components: {
          securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
      },
      transform: ({ schema, url }) => {
        if (!schema) return { schema, url };
        const { body, querystring, params, headers, response, ...rest } = schema as Record<
          string,
          unknown
        >;
        const out: Record<string, unknown> = { ...rest };
        if (body) out.body = toJson(body, 'input');
        if (querystring) out.querystring = toJson(querystring, 'input');
        if (params) out.params = toJson(params, 'input');
        if (headers) out.headers = toJson(headers, 'input');
        if (response && typeof response === 'object') {
          out.response = Object.fromEntries(
            Object.entries(response).map(([code, s]) => [code, toJson(s, 'output')]),
          );
        }
        return { schema: out, url };
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  },
  { name: 'swagger', dependencies: ['infra'] },
);
