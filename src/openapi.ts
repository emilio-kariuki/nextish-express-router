import type { RouteInfo } from "./types";

export type JSONSchema = boolean | Record<string, unknown>;

export type RouteDocumentation = {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  bodyRequired?: boolean;
  schemas?: { params?: JSONSchema; query?: JSONSchema; body?: JSONSchema };
  responses?: Record<string, { description: string; schema?: JSONSchema; contentType?: string }>;
};

export type OpenAPIOptions = {
  title: string;
  version: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
};

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Method = typeof METHODS[number];
type Parameter = {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: JSONSchema;
  style?: "deepObject";
  explode?: true;
  "x-nextish-catch-all"?: true;
};
type Operation = Pick<RouteDocumentation, "summary" | "description" | "operationId" | "tags"> & {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: JSONSchema }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: JSONSchema }> }>;
};
type PathParameter = { name: string; catchAll: boolean; optional: boolean };

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) {
    throw new TypeError(`${context} must be ${nonempty ? "a nonempty" : "a"} string`);
  }
  return value;
}

function cloneSchema(value: JSONSchema, context: string): JSONSchema {
  if (typeof value === "boolean") return value;
  object(value, context);
  try {
    const result: unknown = JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || ["function", "symbol", "bigint"].includes(typeof item) ||
          (typeof item === "number" && !Number.isFinite(item))) {
        throw new TypeError("not a JSON value");
      }
      return item;
    }));
    return typeof result === "boolean" ? result : object(result, context);
  } catch {
    throw new TypeError(`${context} must contain only serializable JSON values`);
  }
}

// Visit schema keywords, leaving literal data in examples, const, and defaults untouched.
function visitSchemas(schema: JSONSchema, visit: (schema: Record<string, unknown>) => boolean | void): void {
  if (typeof schema === "boolean" || visit(schema) === false) return;
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
    const children = schema[key];
    if (children && typeof children === "object" && !Array.isArray(children)) {
      for (const child of Object.values(children)) {
        if (typeof child === "boolean" || (child && typeof child === "object" && !Array.isArray(child))) {
          visitSchemas(child as JSONSchema, visit);
        }
      }
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems", "items", "not", "if", "then", "else",
    "contains", "propertyNames", "additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]) {
    const children = Array.isArray(schema[key]) ? schema[key] : [schema[key]];
    for (const child of children as unknown[]) {
      if (typeof child === "boolean" || (child && typeof child === "object" && !Array.isArray(child))) {
        visitSchemas(child as JSONSchema, visit);
      }
    }
  }
}

function embeddedSchema(schema: JSONSchema, location: string, context: string): JSONSchema {
  const result = cloneSchema(schema, context);
  visitSchemas(result, node => {
    if (typeof node.$id === "string") return false;
    for (const key of ["$ref", "$dynamicRef"]) {
      const ref = node[key];
      if (typeof ref !== "string" || !ref.startsWith("#")) continue;
      if (ref !== "#" && !ref.startsWith("#/")) {
        throw new TypeError(`${context}: local schema anchors require an explicit $id`);
      }
      node[key] = location + ref.slice(1);
    }
  });
  return result;
}

function fields(schema: JSONSchema | undefined, context: string) {
  if (schema === undefined) return { properties: {}, required: [] as string[] };
  const source = object(cloneSchema(schema, context), context);
  if ((source.type !== undefined && source.type !== "object") ||
      ["$ref", "$dynamicRef", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"].some(key => key in source)) {
    throw new TypeError(`${context} must be an object schema with direct properties; provide a docs.schemas override`);
  }
  const properties = source.properties === undefined ? {} : object(source.properties, `${context}.properties`);
  const required = source.required === undefined ? [] : source.required;
  if (!Array.isArray(required) || required.some(name => typeof name !== "string" || !Object.prototype.hasOwnProperty.call(properties, name))) {
    throw new TypeError(`${context}.required must name declared properties`);
  }
  for (const [name, property] of Object.entries(properties)) {
    const value = cloneSchema(property as JSONSchema, `${context}.properties.${name}`);
    visitSchemas(value, node => {
      if ("$ref" in node || "$dynamicRef" in node) {
        throw new TypeError(`${context} parameter references cannot be expanded; provide a docs.schemas override`);
      }
    });
  }
  return { properties: properties as Record<string, JSONSchema>, required: required as string[] };
}

function pathVariants(route: RouteInfo) {
  const context = `OpenAPI path ${route.path} (${route.file})`;
  if (!route.path.startsWith("/")) throw new TypeError(`${context} must start with /`);
  const parameterName = '(?:\\w+|"(?:[^"\\\\]|\\\\.)+")';
  const optionalSlash = new RegExp(`\\{/\\*(${parameterName})\\}$`).test(route.path);
  const normalized = route.path.replace(new RegExp(`\\{/\\*(${parameterName})\\}`, "g"), "/{*$1}");
  const parameters: PathParameter[] = [];
  const segments = normalized.slice(1).split("/");
  let optionalIndex = -1;
  let baseTrailingSlash = false;
  const parts = segments.map((segment, index) => {
    const match = segment.match(new RegExp(`^(?::(${parameterName})(\\(\\.\\+\\)|\\(\\*\\)\\?)?|\\*(${parameterName})|\\{\\*(${parameterName})\\})$`));
    if (!match) {
      if (/[":*(){}?+\\[\]^$|#]/.test(segment)) {
        throw new TypeError(`${context}: unsupported Express pattern ${segment}; use plain parameters or a terminal catch-all`);
      }
      return segment;
    }
    const token = match[1] ?? match[3] ?? match[4];
    let name: string;
    try {
      name = token.startsWith('"') ? JSON.parse(token) as string : token;
    } catch {
      throw new TypeError(`${context}: invalid quoted parameter name ${token}`);
    }
    if (!name || /[{}/]/.test(name) || parameters.some(parameter => parameter.name === name)) {
      throw new TypeError(`${context}: invalid or repeated parameter name ${name}`);
    }
    const catchAll = Boolean(match[2] || match[3] || match[4]);
    const optional = match[2] === "(*)?" || Boolean(match[4]);
    // shortcut: richer Express patterns need an explicit path override before they can be documented.
    if (catchAll && index !== segments.length - 1) {
      throw new TypeError(`${context}: only terminal catch-alls can be represented in OpenAPI`);
    }
    if (optional) {
      optionalIndex = index;
      baseTrailingSlash = Boolean(match[4]) && !optionalSlash && index > 0;
    }
    parameters.push({ name, catchAll, optional });
    return `{${name}}`;
  });
  const variants = [{ path: "/" + parts.join("/"), parameters, suffix: "" }];
  if (optionalIndex !== -1) {
    variants[0].suffix = "_catchAll";
    variants.unshift({
      path: "/" + parts.slice(0, optionalIndex).join("/") + (baseTrailingSlash ? "/" : ""),
      parameters: parameters.filter(parameter => !parameter.optional),
      suffix: "_base",
    });
  }
  return { variants, parameters };
}

function pointer(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Generate OpenAPI 3.1 from a route snapshot; source filenames appear only in diagnostics. */
export function generateOpenAPI(routes: readonly RouteInfo[], options: OpenAPIOptions) {
  object(options, "OpenAPI options");
  const info: Pick<OpenAPIOptions, "title" | "version" | "description"> = {
    title: text(options.title, "OpenAPI title", true),
    version: text(options.version, "OpenAPI version", true),
  };
  if (options.description !== undefined) info.description = text(options.description, "OpenAPI description");
  if (options.servers !== undefined && !Array.isArray(options.servers)) {
    throw new TypeError("OpenAPI servers must be an array");
  }
  const servers = options.servers === undefined ? undefined : Array.from(options.servers, (server, index) => {
    object(server, `OpenAPI servers[${index}]`);
    return {
      url: text(server.url, `OpenAPI servers[${index}].url`, true),
      ...(server.description === undefined ? {} : { description: text(server.description, `OpenAPI servers[${index}].description`) }),
    };
  });
  if (!Array.isArray(routes)) throw new TypeError("OpenAPI routes must be an array");
  const paths: Record<string, Partial<Record<Method, Operation>>> = {};
  const templates = new Map<string, { path: string; file: string }>();
  const owners = new Map<string, string>();
  const operationIds = new Map<string, string>();

  const candidates = Array.from(routes).flatMap(route => {
    object(route, "OpenAPI route");
    text(route.path, "OpenAPI route.path", true);
    text(route.file, "OpenAPI route.file", true);
    const method = text(route.method, "OpenAPI route.method");
    if (method !== "ALL" && !METHODS.includes(method.toLowerCase() as Method)) {
      throw new TypeError(`Unsupported OpenAPI method ${method} (${route.file})`);
    }
    const { variants, parameters } = pathVariants(route);
    return variants.flatMap(variant => (method === "ALL" ? METHODS : [method.toLowerCase() as Method]).map(method => ({
      route, ...variant, allParameters: parameters, method,
    })));
  }).sort((a, b) => a.path.localeCompare(b.path, "en") || METHODS.indexOf(a.method) - METHODS.indexOf(b.method) || a.route.file.localeCompare(b.route.file, "en"));

  for (const candidate of candidates) {
    const { route, path, method } = candidate;
    const context = `${method.toUpperCase()} ${route.path} (${route.file})`;
    const template = path.replace(/\{[^{}]+\}/g, "{}");
    const existingTemplate = templates.get(template);
    if (existingTemplate && existingTemplate.path !== path) {
      throw new Error(`Conflicting OpenAPI paths ${existingTemplate.path} (${existingTemplate.file}) and ${path} (${route.file})`);
    }
    templates.set(template, { path, file: route.file });
    const operationKey = `${method} ${path}`;
    if (owners.has(operationKey)) {
      throw new Error(`Duplicate OpenAPI operation ${method.toUpperCase()} ${path}: ${owners.get(operationKey)} and ${route.file}`);
    }
    owners.set(operationKey, route.file);
    const docs = route.docs === undefined ? {} : object(route.docs, `${context} docs`) as RouteDocumentation;
    const schemas = docs.schemas === undefined ? {} : object(docs.schemas, `${context} docs.schemas`) as NonNullable<RouteDocumentation["schemas"]>;
    if (docs.bodyRequired !== undefined) {
      if (typeof docs.bodyRequired !== "boolean") throw new TypeError(`${context} docs.bodyRequired must be a boolean`);
      if (schemas.body === undefined) throw new TypeError(`${context} docs.bodyRequired requires docs.schemas.body`);
    }
    const params = fields(schemas.params, `${context} docs.schemas.params`);
    const query = fields(schemas.query, `${context} docs.schemas.query`);
    for (const name of Object.keys(params.properties)) {
      if (!candidate.allParameters.some(parameter => parameter.name === name)) {
        throw new TypeError(`${context}: schema names unknown path parameter ${name}`);
      }
    }
    const parameters: Parameter[] = candidate.parameters.map(parameter => ({
      name: parameter.name,
      in: "path",
      required: true,
      schema: cloneSchema(Object.prototype.hasOwnProperty.call(params.properties, parameter.name)
        ? params.properties[parameter.name] : { type: "string" }, `${context} parameter ${parameter.name}`),
      ...(parameter.catchAll ? { "x-nextish-catch-all": true as const } : {}),
    }));
    for (const name of Object.keys(query.properties).sort()) {
      const schema = cloneSchema(query.properties[name], `${context} query ${name}`);
      const parameter: Parameter = { name, in: "query", required: query.required.includes(name), schema };
      if (typeof schema !== "boolean" && schema.type === "object") {
        const properties = fields(schema, `${context} query ${name}`).properties;
        const children = [
          ...Object.values(properties),
          ...Object.values(schema.patternProperties === undefined ? {} : object(schema.patternProperties, `${context} query ${name}.patternProperties`)),
          ...(schema.additionalProperties === undefined || schema.additionalProperties === false ? [] : [schema.additionalProperties]),
        ];
        for (const child of children) {
          const type = child && typeof child === "object" && !Array.isArray(child) && "type" in child ? child.type : undefined;
          const types = Array.isArray(type) ? type : [type];
          if (!types.length || types.some(type => typeof type !== "string" || !["string", "number", "integer", "boolean", "null"].includes(type))) {
            throw new TypeError(`${context} query ${name}: deepObject supports only scalar child schemas`);
          }
        }
        parameter.style = "deepObject";
        parameter.explode = true;
      }
      parameters.push(parameter);
    }
    const operation: Operation = { responses: {} };
    for (const key of ["summary", "description"] as const) {
      if (docs[key] !== undefined) operation[key] = text(docs[key], `${context} docs.${key}`);
    }
    if (docs.tags !== undefined) {
      if (!Array.isArray(docs.tags)) throw new TypeError(`${context} docs.tags must be an array of strings`);
      operation.tags = Array.from(docs.tags, tag => text(tag, `${context} docs.tags`));
    }
    if (docs.operationId !== undefined) {
      const id = text(docs.operationId, `${context} docs.operationId`, true) +
        (route.method === "ALL" ? `_${method}` : "") + candidate.suffix;
      if (operationIds.has(id)) throw new Error(`Duplicate OpenAPI operationId ${id}: ${operationIds.get(id)} and ${route.file}`);
      operationIds.set(id, route.file);
      operation.operationId = id;
    }
    if (parameters.length) operation.parameters = parameters;
    const location = `#/paths/${pointer(path)}/${method}`;
    if (schemas.body !== undefined) {
      operation.requestBody = {
        ...(docs.bodyRequired === undefined ? {} : { required: docs.bodyRequired }),
        content: { "application/json": {
          schema: embeddedSchema(schemas.body, `${location}/requestBody/content/application~1json/schema`, `${context} docs.schemas.body`),
        } },
      };
    }
    const responses = docs.responses === undefined ? {} : object(docs.responses, `${context} docs.responses`);
    for (const status of Object.keys(responses).sort()) {
      if (!/^(?:[1-5](?:\d\d|XX)|default)$/.test(status)) throw new TypeError(`${context}: invalid OpenAPI response status ${status}`);
      const response = object(responses[status], `${context} response ${status}`);
      const description = text(response.description, `${context} response ${status}.description`);
      const contentType = response.contentType === undefined ? "application/json" : text(response.contentType, `${context} response ${status}.contentType`, true);
      operation.responses[status] = {
        description,
        ...(response.schema === undefined ? {} : { content: { [contentType]: {
          schema: embeddedSchema(response.schema as JSONSchema, `${location}/responses/${status}/content/${pointer(contentType)}/schema`, `${context} response ${status}.schema`),
        } } }),
      };
    }
    if (!Object.keys(operation.responses).length) operation.responses.default = { description: "Response" };
    (paths[path] ??= {})[method] = operation;
  }
  return { openapi: "3.1.0" as const, info, ...(servers === undefined ? {} : { servers }), paths };
}
