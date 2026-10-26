import express from "express";
import path from "path";
import { mountDirectoryRoutes } from "./loader";
import type { CreateRouterOptions, NextishRouter } from "./types";
import { wrapAsync } from "./utils";

export { mountDirectoryRoutes } from "./loader";
export { generateOpenAPI } from "./openapi";
export type { JSONSchema, OpenAPIOptions, RouteDocumentation } from "./openapi";
export type {
  CreateRouterOptions,
  HttpMethod,
  NextishRouter,
  RouteDefinition,
  RouteHandler,
  RouteInfo,
  RouteMount,
  RouteModule,
  RouteValidator,
  RouteValidators,
  ValidationResult,
} from "./types";

/**
 * createNextishRouter(apiDirOrOptions?, maybeOptions?)
 * - If first arg is string -> treated as apiDir path, second arg is options
 * - Otherwise pass options containing apiDir
 */
export async function createNextishRouter(
  apiDirOrOptions?: string | CreateRouterOptions,
  maybeOptions?: CreateRouterOptions
): Promise<NextishRouter> {
  const options = typeof apiDirOrOptions === "string"
    ? { ...maybeOptions, apiDir: apiDirOrOptions }
    : { ...apiDirOrOptions };
  const apiDir = path.resolve(options.apiDir ?? "api");

  const router = express.Router();

  // Apply default body parsers (unless explicitly disabled)
  if (options.bodyParser !== false) {
    router.use(express.json());
    router.use(express.urlencoded({ extended: true }));
  }

  for (const middleware of options.globalMiddleware ?? []) {
    if (middleware.length !== 4) router.use(wrapAsync(middleware));
  }

  const close = await mountDirectoryRoutes(router, { ...options, apiDir });

  for (const middleware of options.globalMiddleware ?? []) {
    if (middleware.length === 4) router.use(wrapAsync(middleware));
  }

  return Object.assign(router, { close, getRoutes: close.getRoutes });
}
