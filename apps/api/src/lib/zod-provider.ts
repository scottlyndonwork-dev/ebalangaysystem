import type {
  FastifySchemaCompiler,
  FastifyTypeProvider,
  FastifySerializerCompiler,
} from 'fastify';
import type { z } from 'zod';

/** Route schemas are Zod schemas from @ebalangay/shared; this wires them into Fastify's types. */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this['schema'] extends z.ZodType ? z.output<this['schema']> : unknown;
  serializer: this['schema'] extends z.ZodType ? z.input<this['schema']> : unknown;
}

export class RequestValidationError extends Error {
  override name = 'RequestValidationError';
  constructor(
    readonly part: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Invalid request ${part}`);
  }
}

export const validatorCompiler: FastifySchemaCompiler<z.ZodType> =
  ({ schema, httpPart }) =>
  (data) => {
    const result = schema.safeParse(data);
    return result.success
      ? { value: result.data }
      : { error: new RequestValidationError(httpPart ?? 'body', result.error.issues) };
  };

/** Responses are parsed through their schema so unknown fields never leak. */
export const serializerCompiler: FastifySerializerCompiler<z.ZodType> =
  ({ schema }) =>
  (data) =>
    JSON.stringify(schema.parse(data));
