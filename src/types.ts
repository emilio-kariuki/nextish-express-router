import type express from "express";
import type { RouteDocumentation } from "./openapi";

export type RouteInfo = {
  path: string;
  method: HttpMethod | "ALL";
  file: string;
  docs?: RouteDocumentation;
};

export type RouteMount = (() => Promise<void>) & {
  /** Inspect the last successfully published routes. */
  getRoutes(): RouteInfo[];
};

export type NextishRouter = express.Router & {
  /** Stop file watching without closing the HTTP server or removing handlers. */
  close(): Promise<void>;
  /** Inspect the last successfully published routes. */
  getRoutes(): RouteInfo[];
};

export type CreateRouterOptions = {
  /**
   * Absolute or relative path to the api directory.
   * Default: "./api"
   */
  apiDir?: string;
  /**
   * File extensions to consider.
   */
  extensions?: string[];
  /**
   * Prefix that will be added to all routes (e.g. '/api')
   */
  routePrefix?: string;
  /**
   * Whether to watch files and reload handlers in dev.
   */
  watch?: boolean;
  /**
   * Refresh affected CommonJS and ESM modules. Defaults to the value of watch.
   */
  devMode?: boolean;
  /**
   * If false, do NOT mount automatic body parsers.
   * Default: true
   */
  bodyParser?: boolean;
  /**
   * Optional global middleware applied to the router.
   */
  globalMiddleware?: Array<express.RequestHandler>;
  /**
   * Optional log function
   */
  logger?: (msg: string) => void;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export type RouteHandler = express.RequestHandler | express.RequestHandler[];

export type ValidationResult = void | {
  ok: boolean;
  status?: number;
  body?: unknown;
};

export type RouteValidator = (
  req: express.Request
) => ValidationResult | Promise<ValidationResult>;

export type RouteValidators = Partial<Record<"params" | "query" | "body", RouteValidator>>;

export type RouteDefinition = {
  handler: RouteHandler;
  middleware?: RouteHandler;
  validate?: RouteValidators;
  docs?: RouteDocumentation;
};

export type RouteModule = Partial<Record<HttpMethod | Lowercase<HttpMethod>, RouteHandler | RouteDefinition>> & {
  default?: RouteHandler | RouteDefinition;
  handler?: RouteHandler | RouteDefinition;
  middleware?: RouteHandler;
  config?: Record<string, unknown>;
  validate?: RouteValidators;
  docs?: RouteDocumentation;
};
