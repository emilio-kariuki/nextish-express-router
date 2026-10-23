import type express from "express";
import type { RouteDefinition, RouteModule, RouteValidators } from "./types";
import { wrapAsync } from "./utils";

const HTTP_METHODS = ["head", "get", "post", "put", "patch", "delete", "options"] as const;
const VALIDATORS = ["params", "query", "body"] as const;

export function getHandlers(value: unknown, file: string, name: string): express.RequestHandler[] {
  const parts = Array.isArray(value) ? value : [value];
  if (parts.length === 0 || [...parts].some(part => typeof part !== "function")) {
    throw new TypeError(`Invalid ${name} export in ${file}: expected a function or a non-empty array of functions`);
  }
  return (parts as express.RequestHandler[]).map(wrapAsync);
}

function getValidation(value: unknown, file: string, name: string): express.RequestHandler[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${name} export in ${file}`);
  }
  const validators = value as RouteValidators;
  for (const part of VALIDATORS) {
    if (validators[part] !== undefined && typeof validators[part] !== "function") {
      throw new TypeError(`Invalid ${name}.${part} export in ${file}`);
    }
  }
  return [wrapAsync(async (req, res, next) => {
    try {
      for (const part of VALIDATORS) {
        const result = await validators[part]?.(req);
        if (result && result.ok === false) {
          res.status(result.status ?? 400).json(result.body ?? { error: `Invalid ${part}` });
          return;
        }
      }
      next();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Validation failed" });
    }
  })];
}

export function registerRouteHandlers(
  resource: express.IRoute,
  mod: unknown,
  file: string,
  inheritedMiddleware: express.RequestHandler[] = []
): string[] {
  if (mod === null || (typeof mod !== "object" && typeof mod !== "function")) {
    throw new TypeError(`Invalid route module: ${file}`);
  }
  const routeModule = mod as RouteModule;
  const sharedValidation = getValidation(routeModule.validate, file, "validate");
  const common = [
    ...inheritedMiddleware,
    ...(routeModule.middleware === undefined ? [] : getHandlers(routeModule.middleware, file, "middleware")),
  ];
  const handlers = (value: unknown, name: string) => {
    const definition = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as RouteDefinition
      : undefined;
    return [
      ...common,
      ...(definition?.middleware === undefined ? [] : getHandlers(definition.middleware, file, `${name}.middleware`)),
      ...sharedValidation,
      ...getValidation(definition?.validate, file, `${name}.validate`),
      ...getHandlers(definition === undefined ? value : definition.handler, file, definition ? `${name}.handler` : name),
    ];
  };
  const methods: string[] = [];
  for (const method of HTTP_METHODS) {
    const upper = method.toUpperCase() as Uppercase<typeof method>;
    const handler = routeModule[upper] === undefined ? routeModule[method] : routeModule[upper];
    if (handler !== undefined) {
      resource[method](...handlers(handler, upper));
      methods.push(upper);
    }
  }
  if (methods.length === 0) {
    const handler = routeModule.default === undefined ? routeModule.handler : routeModule.default;
    if (handler === undefined) throw new TypeError(`No handler exported in route file: ${file}`);
    resource.all(...handlers(handler, "default/handler"));
    methods.push("ALL");
  }
  return methods;
}
