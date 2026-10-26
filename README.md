# nextish-express-router for Express 4 and 5

Directory-based API routing for Express 4 and 5. Requires Node.js **22.13.0 or newer**.

The current implementation includes:

- Per-method handlers, middleware, and validation.
- Route groups using `(name)` directories that do not appear in URLs.
- Shared middleware inherited by directory.
- Conflict detection for route patterns and duplicate route or middleware files.
- Optional Zod 4 validation with typed, parsed values in `req.validated`.
- Route inspection through `getRoutes()` and OpenAPI 3.1 generation.
- CommonJS and native ESM route loading on Express 4 and 5.
- Atomic development reloads for routes, middleware, and eagerly imported local helpers.

The source package is version **0.1.0** and is not currently available on the public npm registry. From a checkout of this repository, build an installable tarball:

```sh
pnpm install --frozen-lockfile
npm pack
```

`npm pack` builds the package and creates `nextish-express-router-0.1.0.tgz`. In your application, install that file alongside Express:

```sh
npm install /path/to/nextish-express-router-0.1.0.tgz express@5
```

The router uses your application's Express peer dependency: Express **4.22.3 or newer within 4.x**, or **5.x**. Replace `express@5` with `express@4` above to use Express 4.

For TypeScript, install matching declarations with `npm install --save-dev @types/express@5` for Express 5, or `npm install --save-dev @types/express@4` for Express 4.

Create `api/hello/route.js`:

```js
exports.GET = (req, res) => res.json({ message: "Hello" });
```

Mount the API from your CommonJS server:

```js
const express = require("express");
const { createNextishRouter } = require("nextish-express-router");

async function main() {
  const app = express();
  const api = await createNextishRouter();
  app.use("/api", api);
  app.listen(3000);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

`GET /api/hello` now returns JSON. The returned `NextishRouter` works anywhere an Express router does.

With no argument, `createNextishRouter()` loads `./api`. These are alternative ways to choose the directory:

```js
await createNextishRouter(); // ./api
await createNextishRouter("api"); // Same as the default
await createNextishRouter("routes"); // ./routes
await createNextishRouter({ apiDir: "routes", watch: true }); // Custom directory with watching
```

Relative paths resolve from `process.cwd()` (the working directory where you start Node), independently of the server file's location. Absolute paths are also supported. The included example uses an absolute path so its routes stay beside the source or compiled server.

Routes are loaded from files named `route.<extension>`. Directory conventions are relative to `apiDir`:

| File | Express 4 path | Express 5 path |
| --- | --- | --- |
| `api/route.js` | `/` | `/` |
| `api/about/route.js` | `/about` | `/about` |
| `api/users/[id]/route.js` | `/users/:id` | `/users/:id` |
| `api/files/[...rest]/route.js` | `/files/:rest(.+)` | `/files/*rest` |
| `api/docs/[[...rest]]/route.js` | `/docs/:rest(*)?` | `/docs{/*rest}` |

`[id]` captures one segment. `[...rest]` requires a nonempty remainder; `[[...rest]]` also matches `/docs` and `/docs/`. For `/files/one/two`, Express 4 supplies `req.params.rest` as `"one/two"`; Express 5 supplies `["one", "two"]`. Parameter names contain ASCII letters, digits, or underscores; numeric names are quoted automatically in Express 5 patterns. Express 5 also accepts other names such as `[user-id]`; Express 4 rejects them clearly. Static folder names match literally, and Express 4 does not support `?` in folder names. Static routes take priority over dynamic routes, then required catch-alls, then optional catch-alls. Hidden files and directories and symbolic links are skipped. Next.js layouts are not included.

Wrap an entire directory name in parentheses to create a **route group**, as in Next.js. Group names organize files and are omitted from the URL:

```text
api/(public)/route.ts                  → /
api/(public)/about/route.ts            → /about
api/(admin)/middleware.ts              → middleware for routes inside (admin)
api/(admin)/users/[id]/route.ts         → /users/:id
api/(admin)/(reports)/stats/route.ts    → /stats
```

Groups can be nested or placed between ordinary, dynamic, and catch-all directories. They do not affect route priority. A route directly inside a group uses its parent's URL. Existing `routePrefix` and `app.use()` prefixes still apply.

Middleware follows the physical folder tree: API-root middleware runs first, then ancestor middleware including each enclosing group's middleware. A group's middleware applies only to its descendants, even when another group has routes under the same URL prefix. Route manifests, OpenAPI paths, and route logs omit group names from URLs; manifest source filenames retain the complete filesystem path.

Groups share the same URL namespace. For example, `(public)/users/route.js` and `(admin)/users/route.js` conflict because both map to `/users`, even if they export different HTTP methods. Renaming a group preserves its URLs; with `watch: true`, group routes and middleware participate in the same atomic reloads as ordinary directories.

Each effective route pattern must come from one file per mount. For example, `users/[id]/route.js` conflicts with `users/[slug]/route.js`, and `route.ts` conflicts with `route.js` when both extensions are enabled, even if they export different methods. Conflicts report both files; case handling follows the receiving Express router. Static/dynamic/catch-all overlaps remain allowed. This check does not include routes registered by your application or separate mounts.

Export a handler function, an array of handlers, or a `RouteDefinition` object as `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD`. A definition has a required `handler` and optional `middleware`, `validate`, and `docs`; `handler` and `middleware` each accept a function or array. Lowercase method names also work; uppercase wins when both are present. If no method handlers exist, `default` or `handler` accepts the same forms and handles all methods (`default` wins). An explicit HEAD handler takes priority; otherwise HEAD uses GET's definition, including its middleware and validators. Express provides implicit OPTIONS as usual.

TypeScript route modules can use the public types:

```ts
import type { RequestHandler } from "express";
import type { RouteDefinition } from "nextish-express-router";

export const GET: RequestHandler = (_req, res) => {
  res.json({ message: "Hello" });
};

export const POST: RouteDefinition = {
  middleware(_req, res, next) {
    res.set("Cache-Control", "no-store");
    next();
  },
  validate: {
    body(req) {
      if (typeof req.body?.name !== "string" || req.body.name.length === 0) {
        return { ok: false, body: { error: "Name is required" } };
      }
    }
  },
  handler(req, res) {
    res.status(201).json({ name: req.body.name });
  }
};
```

Top-level `middleware` and `validate` exports still apply to every method in that route file. Use `RouteValidators` to type shared validators. Shared and method validators compose: a method definition cannot disable or replace shared validation.

For inherited middleware, add `middleware.<extension>` files inside `apiDir`, using the same configured extensions as routes:

```text
api/middleware.js             → every discovered route
api/blog/middleware.js        → /blog and its descendant routes
api/blog/route.js             → /blog
api/blog/[id]/route.js        → /blog/:id
```

Export a function or array as named `middleware` or `default`; named `middleware` wins when both are present. For example:

```js
// api/middleware.js
exports.middleware = (_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  next();
};

// api/blog/middleware.js
exports.middleware = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};
```

Directory middleware runs from the API root to the route's own directory, including for a route in the same directory. Children cannot remove ancestor middleware. It runs only for matching loaded route methods, not arbitrary unmatched URLs. Each directory may contain only one middleware file; for example, enabling both `middleware.ts` and `middleware.js` is an error that reports both filenames.

The request order is body parsers, `globalMiddleware`, directory middleware (root to leaf), route-module `middleware`, method `middleware`, shared validators (`params`, `query`, `body`), method validators (`params`, `query`, `body`), then the method's handlers. Middleware must call `next()` or send a response; returning a fulfilled promise alone does not advance the request.

Each validator receives the whole Express request and returns `void` or `{ ok: boolean, status?: number, body?: unknown }`, directly or in a promise. Validators are awaited. A returned `{ ok: false }` stops the request with HTTP 400 by default and can set `status` and `body`. A thrown or rejected validator error goes to `next(error)`, which Express answers with HTTP 500 by default.

For schema validation with inferred output types, install the optional Zod 4 peer dependency:

```sh
npm install zod@4
```

Import the adapter from `nextish-express-router/zod`:

```ts
import { z } from "zod";
import { zodRoute } from "nextish-express-router/zod";

export const POST = zodRoute({
  schemas: {
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
    body: z.object({ name: z.string().trim().min(1) })
  },
  docs: {
    summary: "Create a user",
    responses: {
      "201": { description: "Created user", schema: { type: "object" } }
    }
  },
  handler(req, res) {
    // name is a trimmed string; limit is a number, with its default applied.
    res.status(201).json({
      name: req.validated.body.name,
      limit: req.validated.query.limit
    });
  }
});
```

`zodRoute` accepts `schemas.params`, `schemas.query`, and `schemas.body`, plus a handler or handler array, optional middleware, and documentation. It awaits async parsing, refinements, and transformations. Handlers receive inferred parsed values in `req.validated`; the original `req.params`, `req.query`, and `req.body` stay unchanged, including Express 5's read-only query property. Only supplied schema parts appear in `req.validated`, and it is assigned after every part succeeds. Parse failures return HTTP 400 with `{ error, issues }` before the handler runs. Shared validators still run first, and middleware runs before parsed values are available.

The adapter derives documentation from each schema's **input** JSON Schema. If Zod cannot represent an input schema, provide an explicit `docs.schemas.params`, `query`, or `body` override. See [the example route](example/api/blog/route.ts) for POST-only validation. The core router and OpenAPI generator work without Zod installed.

For ordinary noncoercing body schemas, `zodRoute` documents a required body. An unrefined outer `.optional()`, `.default()`, or `.prefault()` wrapper, or an unrefined `z.any()`, `z.unknown()`, `z.undefined()`, or `z.void()`, documents an optional body. This inference does not parse data or run refinements or default factories. Set `docs.bodyRequired` explicitly for coercion, preprocessing or transformation pipelines, custom, lazy, or composed schemas, and refined optional wrappers. An explicit boolean overrides inference; otherwise ambiguous cases leave the flag unspecified. The flag requires a corresponding `docs.schemas.body`.

For an absent HTTP body, the adapter treats Express 4's plain empty parser object as `undefined` while leaving `req.body` unchanged. This lets body-level optional values and defaults behave consistently across Express versions. An explicit JSON `{}`, a transfer-encoded body, or a nonempty middleware-supplied value remains a real input.

Handlers and middleware can be async. Unexpected throws and rejections go to Express error middleware: register your `(error, req, res, next)` handler after mounting the API. Four-argument error handlers also work inside `globalMiddleware`, directory `middleware` files, and route handler arrays, and they keep their position in the chain. Validation failures are handled separately as described above. Invalid route or middleware modules and conflicts reject initial router creation before routes are registered. A route module with no handler is invalid. Watched changes rebuild handler chains atomically; a failed reload is logged and keeps the last working routes and middleware until fixed. Removing a middleware file removes its middleware after a successful reload.

Inspect the current routes with `api.getRoutes()`. It returns detached records of `{ path, method, file, docs? }` from the last successful publication; modifying a record does not change routing. Failed reloads leave the manifest unchanged. Each record describes an exported method, or `ALL` for a fallback; implicit HEAD and automatic OPTIONS do not add records.

Generate an OpenAPI 3.1 document from that snapshot:

```js
const { generateOpenAPI } = require("nextish-express-router");

const spec = generateOpenAPI(api.getRoutes(), {
  title: "Users API",
  version: "1.0.0",
  servers: [{ url: "/api" }]
});
```

Manifest paths include `routePrefix` and exclude an outer `app.use("/api", api)` prefix; use `servers` for that base URL. The manifest includes absolute source filenames for local inspection; generated specifications omit them. No documentation endpoint is mounted automatically. `generateOpenAPI` requires `title` and `version`; `description` and `servers: [{ url, description? }]` are optional.

Route files can export shared `docs`, and each method definition can supply its own `docs`. Method fields take precedence; `schemas` merge by request part and `responses` merge by status, with method entries winning. `RouteDocumentation` supports `summary`, `description`, `operationId`, `tags`, `schemas: { params?, query?, body? }`, `bodyRequired?: boolean`, and `responses: { [status]: { description, schema?, contentType? } }`. Schemas are JSON Schema objects or booleans. Response statuses may be explicit codes, ranges such as `"4XX"`, or `"default"`.

Path parameters are required; query parameter requirements come from the object's `required` list. Params/query schemas must have direct object properties; composed schemas and parameter references need a flat `docs.schemas` override. Individual property constraints, defaults, and descriptions are retained. Object-valued query fields use `style: "deepObject"` and `explode: true`, encoding a filter as `filter[name]=Ada`. Configure Express 5 with `app.set("query parser", "extended")` to parse these bracket keys. Only explicitly typed scalar children are supported; nested objects, arrays, and opaque child schemas are rejected. Scalar and array query fields retain OpenAPI's default query serialization.

Body schemas use `application/json`, and `docs.bodyRequired` controls the OpenAPI request body's `required` flag; an unspecified flag uses OpenAPI's optional-body default. Response schemas use `application/json` by default, or the supplied `contentType`. An operation with no documented responses gets a valid `default` response. Body and response JSON Pointer references remain resolvable after embedding, including draft-07 schema-valued `dependencies` and `additionalItems`; local schema anchors need an explicit `$id`. Literal data in defaults and examples is preserved.

The generator supports full-segment parameters and terminal catch-alls in either Express version. Optional catch-alls generate both base and wildcard paths. Wildcard parameters carry `x-nextish-catch-all: true`; OpenAPI tools may need custom handling for multiple path segments. Custom regex, mixed parameter segments, and other unsupported Express patterns fail clearly. `ALL` expands to OpenAPI's GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH, and TRACE operations. Explicit operation IDs gain `_<method>` for `ALL` and `_base` or `_catchAll` for optional variants. Duplicate operations, duplicate operation IDs, and equivalent templates with different parameter names are rejected, including when combining separate manifests.

`createNextishRouter()` uses the defaults. Customize them with `createNextishRouter(apiDir)`, `createNextishRouter(options)`, or `createNextishRouter(apiDir, options)`:

- `apiDir`: absolute or relative directory to scan; default `"api"`, resolved relative to `process.cwd()`.
- `extensions`: default `[".ts", ".js", ".tsx", ".jsx", ".cjs", ".mjs"]`; use only the extensions emitted by your build for compiled routes.
- `routePrefix`: prefix added to every route; default `""`. A leading slash is optional. It combines with the path passed to `app.use()`.
- `watch`: reload route files, directory middleware, and their discovered local dependencies when they are added, changed, or removed; default `false`.
- `devMode`: refresh affected CommonJS and ESM modules when loading; defaults to the value of `watch`. Set `false` to retain cached modules even when watching.
- `bodyParser`: mount `express.json()` and `express.urlencoded({ extended: true })`; default `true`. Set `false` to provide your own parsers before the API.
- `globalMiddleware`: array of handlers run before all routes; default none.
- `logger`: `(message: string) => void`; default `console.log`. Set `() => {}` to silence route and reload logs.

For filesystems that miss native watch events, set `CHOKIDAR_USEPOLLING=1` when running with `watch: true`. Polling increases filesystem I/O.

With `watch: true` and `devMode: true`, editing an eagerly imported local service, validator, or other helper refreshes the affected routes and middleware. Discovery follows transitive CommonJS and ESM dependencies, including helpers outside `apiDir`, loaded during module initialization. Dependencies under `node_modules`, native addons, and imports or requires first executed inside request handlers are excluded; restart for changes to those files. Failed imports keep the last working handlers and manifest. ESM cache-busting is scoped to route loading and its local imports, so unrelated application imports keep their normal module URLs.

Synchronous CommonJS `require()` of a native ESM helper is not reloaded automatically: this loader cannot refresh Node's synchronous ESM cache. Use a native ESM route with `import` for ESM helpers that need reloading, or restart after changing them.

Public types include `CreateRouterOptions`, `HttpMethod`, `NextishRouter`, `RouteDefinition`, `RouteDocumentation`, `RouteHandler`, `RouteInfo`, `RouteMount`, `RouteModule`, `RouteValidator`, `RouteValidators`, `ValidationResult`, `JSONSchema`, and `OpenAPIOptions`. The optional `/zod` entry exports `zodRoute`, `ZodRouteSchemas`, `ZodRouteRequest`, `ZodRouteHandler`, and `ZodRouteOptions`.

For direct mounting, `await mountDirectoryRoutes(appOrRouter, options)` returns a callable `RouteMount`: call `mount.getRoutes()` to inspect it and `await mount()` to clean up. It mounts routes onto an existing Express application or router; configure its body parsers and global middleware yourself. `bodyParser` and `globalMiddleware` are convenience options applied by `createNextishRouter`.

Keep the returned router and call `await api.close()` during shutdown, or call the cleanup function returned by `mountDirectoryRoutes`. Cleanup stops watching and prevents late reload publication; it does not close your HTTP server or remove active handlers. Call `server.close()` separately. [The example server](example/server.ts) handles SIGINT, SIGTERM, and startup failures.

**Limitations:** Route `docs` must be structured-cloneable plain data. ESM route modules reloaded in dev mode remain in Node's module cache until the process exits. Memory can grow during long watch sessions; restart periodically.

The package's CommonJS build supports both `require("nextish-express-router")` and native ESM named imports such as `import { createNextishRouter } from "nextish-express-router"`. Route and middleware files may use CommonJS (`.cjs`, or `.js` in a CommonJS package) or native ESM (`.mjs`, or `.js` under `"type": "module"`). ESM top-level `await` is supported and finishes before the new routes are published.

Recognizing `.ts`, `.tsx`, or `.jsx` filenames does not transpile them. Compile routes to Node-compatible CommonJS or ESM JavaScript, or install a compatible runtime loader such as `tsx`:

```sh
npm install --save-dev typescript tsx @types/node
node --import tsx server.ts
```

This repository builds with TypeScript 5.9. For compiled deployments, point `apiDir` at the emitted JavaScript directory, select the emitted extensions, and use `watch: false`. The example's production start script sets `NODE_ENV=production` and disables watching.

From this repository, run the included example with pnpm:

```sh
pnpm install
pnpm dev        # TypeScript development with watching
pnpm build      # Emits dist/src and dist/example
pnpm start      # Runs dist/example/server.js in production, without watching
pnpm lint       # Checks code style
pnpm typecheck  # Checks TypeScript without emitting files
pnpm test       # Builds, then runs Node's test runner
```

The example responds at `http://localhost:3000/api/blog`. Its POST accepts JSON such as `{"name":"Ada"}`; GET, PUT, PATCH, and DELETE require no name. The example is a request/validation demonstration and does not persist data.

The larger [todo API example](example/todo/README.md) implements users, their projects, and project todos with complete CRUD flows, completion filtering, route groups, inherited middleware, Zod validation, and an OpenAPI endpoint. Run `npm run todo:dev` from the repository root, or `npm run build` followed by `npm run todo:start` for compiled JavaScript. It listens at `http://127.0.0.1:3001`, uses seeded in-memory data that resets on restart, and has no authentication.
