import type express from "express";
import { z } from "zod";
import type { RouteDocumentation } from "./openapi";
import type { RouteDefinition, RouteHandler } from "./types";

const PARTS = ["params", "query", "body"] as const;

export type ZodRouteSchemas = Partial<Record<typeof PARTS[number], z.ZodType>>;

export type ZodRouteRequest<Schemas extends ZodRouteSchemas> = express.Request & {
  validated: { [Part in keyof Schemas]: z.output<Schemas[Part]> };
};

export type ZodRouteHandler<Schemas extends ZodRouteSchemas> = (
  req: ZodRouteRequest<Schemas>,
  res: express.Response,
  next: express.NextFunction
) => unknown;

export type ZodRouteOptions<Schemas extends ZodRouteSchemas> = {
  schemas: Schemas;
  handler: ZodRouteHandler<Schemas> | ZodRouteHandler<Schemas>[];
  middleware?: RouteHandler;
  docs?: RouteDocumentation;
};

function inferBodyRequired(schema: z.ZodType | undefined): boolean | undefined {
  if (!schema) return undefined;
  const def = schema.def;
  if (["object", "array", "tuple", "record", "map", "set", "string", "number", "int", "boolean", "bigint", "date", "enum", "null"].includes(def.type)
      && !("coerce" in def && def.coerce)) return true;
  if (!def.checks?.length && ["optional", "default", "prefault", "any", "unknown", "undefined", "void"].includes(def.type)) return false;
  // shortcut: opaque or composed schemas need docs.bodyRequired; never probe them by parsing.
  return undefined;
}

/** Parse request inputs once, then expose their inferred output types to handlers. */
export function zodRoute<Schemas extends ZodRouteSchemas>(
  options: ZodRouteOptions<Schemas>
): RouteDefinition {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Invalid zodRoute options: expected an object");
  }
  const { schemas, middleware, handler, docs } = options;
  if (docs?.bodyRequired !== undefined && typeof docs.bodyRequired !== "boolean") {
    throw new TypeError("Invalid zodRoute docs.bodyRequired: expected a boolean");
  }
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    throw new TypeError("Invalid zodRoute schemas: expected an object");
  }
  for (const part of Object.keys(schemas)) {
    if (!PARTS.includes(part as typeof PARTS[number])) {
      throw new TypeError(`Invalid zodRoute schema: ${part}; expected params, query, or body`);
    }
  }
  const documentation = { ...docs?.schemas };
  const entries = PARTS.flatMap(part => {
    const schema = schemas[part];
    if (schema === undefined) return [];
    if (!(schema instanceof z.ZodType)) {
      throw new TypeError(`Invalid zodRoute schemas.${part}: expected a Zod 4 schema`);
    }
    if (documentation[part] === undefined) {
      try {
        documentation[part] = z.toJSONSchema(schema, { io: "input" });
      } catch (error) {
        throw Object.assign(new TypeError(`Cannot document zodRoute schemas.${part}; provide docs.schemas.${part}: ${error instanceof Error ? error.message : "JSON Schema conversion failed"}`), { cause: error });
      }
    }
    return [[part, schema] as const];
  });
  const bodyRequired = docs?.bodyRequired ?? inferBodyRequired(schemas.body);

  return {
    middleware,
    docs: { ...docs, schemas: documentation, ...(bodyRequired === undefined ? {} : { bodyRequired }) },
    validate: {
      params: async req => {
        const validated: Partial<Record<typeof PARTS[number], unknown>> = {};
        for (const [part, schema] of entries) {
          let input = req[part];
          if (part === "body" && input !== null && typeof input === "object" && Reflect.ownKeys(input).length === 0) {
            const prototype = Object.getPrototypeOf(input);
            const length = req.get("content-length");
            // Express 4's parser creates {} even when the request carries no body.
            if ((prototype === Object.prototype || prototype === null) && req.get("transfer-encoding") === undefined
                && (length === undefined || Number(length) === 0)) input = undefined;
          }
          const result = await schema.safeParseAsync(input);
          if (!result.success) {
            return { ok: false, body: { error: `Invalid ${part}`, issues: result.error.issues } };
          }
          validated[part] = result.data;
        }
        Object.assign(req, { validated });
      },
    },
    handler: handler as RouteHandler,
  };
}
