const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const express = require("express");
const { z } = require("zod");
const { registerRouteHandlers } = require("../dist/src/handlers");
const { generateOpenAPI } = require("../dist/src/openapi");
const { zodRoute } = require("../dist/src/zod");

async function serve(t, module, { route = "/:id", inherited = [], before = [], factory = express } = {}) {
  const app = factory();
  app.use(factory.json());
  for (const middleware of before) app.use(middleware);
  registerRouteHandlers(app.route(route), module, "zod-test-route", inherited);
  app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await once(server, "listening");
  return (url = "/42", options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    ...options,
    signal: AbortSignal.timeout(3000),
  });
}

function post(body) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

test("Zod routes expose parsed params, query, and body without replacing Express inputs", async t => {
  const request = await serve(t, {
    POST: zodRoute({
      schemas: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        query: z.object({ limit: z.coerce.number().int().min(1).default(10) }),
        body: z.object({
          name: z.string().trim().min(1).transform(value => value.toUpperCase()),
          tags: z.array(z.string()).default([]),
        }),
      },
      handler: (req, res) => res.json({
        parsed: req.validated,
        raw: { params: req.params, query: req.query, body: req.body },
      }),
    }),
  });
  const response = await request("/42?limit=3", post({ name: " Ada " }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    parsed: { params: { id: 42 }, query: { limit: 3 }, body: { name: "ADA", tags: [] } },
    raw: { params: { id: "42" }, query: { limit: "3" }, body: { name: " Ada " } },
  });
  const defaults = await request("/42", post({ name: "Ada" }));
  assert.equal(defaults.status, 200);
  assert.deepEqual((await defaults.json()).parsed.query, { limit: 10 });
});

test("Zod query parsing supports a getter-only req.query", async t => {
  const query = Object.freeze({ page: "7" });
  const request = await serve(t, {
    GET: zodRoute({
      schemas: { query: z.object({ page: z.coerce.number() }) },
      handler: (req, res) => {
        assert.equal(req.query, query);
        res.json(req.validated);
      },
    }),
  }, {
    before: [(req, _res, next) => {
      Object.defineProperty(req, "query", { get: () => query, configurable: true });
      next();
    }],
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { query: { page: 7 } });
});

test("invalid Zod inputs stop the handler and never publish a partially parsed request", async t => {
  let currentRequest;
  let handled = 0;
  const request = await serve(t, {
    POST: zodRoute({
      schemas: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        query: z.object({ limit: z.coerce.number().int().positive() }),
        body: z.object({ name: z.string().min(1) }),
      },
      handler: (_req, res) => { handled += 1; res.end(); },
    }),
  }, {
    before: [(req, _res, next) => { currentRequest = req; next(); }],
  });
  for (const [part, url, body, field] of [
    ["params", "/bad?limit=1", { name: "Ada" }, "id"],
    ["query", "/42?limit=bad", { name: "Ada" }, "limit"],
    ["body", "/42?limit=1", { name: "" }, "name"],
  ]) {
    const response = await request(url, post(body));
    assert.equal(response.status, 400, part);
    const result = await response.json();
    assert.equal(result.error, `Invalid ${part}`);
    assert.deepEqual(result.issues[0].path, [field]);
    assert.equal(Object.hasOwn(currentRequest, "validated"), false, part);
  }
  assert.equal(handled, 0);
});

test("directory, route, and method middleware and shared validators run before Zod parsing", async t => {
  const steps = [];
  const middleware = name => (_req, _res, next) => { steps.push(name); next(); };
  const schema = name => z.object({}).transform(value => { steps.push(`schema.${name}`); return value; });
  const request = await serve(t, {
    middleware: middleware("route"),
    validate: Object.fromEntries(["params", "query", "body"].map(part => [part, async req => {
      await Promise.resolve();
      assert.equal(Object.hasOwn(req, "validated"), false);
      steps.push(`shared.${part}`);
    }])),
    POST: zodRoute({
      schemas: { params: schema("params"), query: schema("query"), body: schema("body") },
      middleware: [middleware("method"), (req, _res, next) => { req.body = {}; next(); }],
      handler: [
        (req, _res, next) => { assert.deepEqual(req.validated, { params: {}, query: {}, body: {} }); next(); },
        (_req, res) => { steps.push("handler"); res.json(steps); },
      ],
    }),
  }, { inherited: [middleware("directory")] });
  const response = await request("/42", post({ ignored: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    "directory", "route", "method", "shared.params", "shared.query", "shared.body",
    "schema.params", "schema.query", "schema.body", "handler",
  ]);
});

test("shared route validation cannot be bypassed by a Zod route", async t => {
  let parsed = false;
  let handled = false;
  const request = await serve(t, {
    validate: { params: () => ({ ok: false, status: 401, body: { error: "shared denied" } }) },
    GET: zodRoute({
      schemas: { params: z.object({ id: z.string() }).transform(value => { parsed = true; return value; }) },
      handler: (_req, res) => { handled = true; res.end(); },
    }),
  });
  const response = await request();
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "shared denied" });
  assert.equal(parsed, false);
  assert.equal(handled, false);
});

test("Zod routes await async refinements and transformations", async t => {
  const request = await serve(t, {
    POST: zodRoute({
      schemas: {
        body: z.object({
          token: z.string()
            .refine(async value => { await Promise.resolve(); return value === "allowed"; }, "Unknown token")
            .transform(async value => { await Promise.resolve(); return value.length; }),
        }),
      },
      handler: async (req, res) => { await Promise.resolve(); res.json(req.validated.body); },
    }),
  });
  const accepted = await request("/42", post({ token: "allowed" }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { token: 7 });
  const denied = await request("/42", post({ token: "denied" }));
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).issues[0].message, "Unknown token");
});

test("thrown transforms and empty rejections use the existing validation failure response", async t => {
  let handled = false;
  const request = await serve(t, {
    POST: zodRoute({
      schemas: {
        body: z.object({ mode: z.string() }).transform(async ({ mode }) => {
          if (mode === "empty") return Promise.reject();
          throw new Error("Transform failed");
        }),
      },
      handler: (_req, res) => { handled = true; res.end(); },
    }),
  });
  for (const [mode, message] of [["throw", "Transform failed"], ["empty", "Validation failed"]]) {
    const response = await request("/42", post({ mode }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: message });
  }
  assert.equal(handled, false);
});

test("Zod method middleware and handler failures reach Express error middleware", async t => {
  const request = await serve(t, {
    GET: zodRoute({
      schemas: {},
      middleware: async () => { throw new Error("Middleware failed"); },
      handler: (_req, res) => res.end("unexpected"),
    }),
    POST: zodRoute({
      schemas: {},
      handler: async () => Promise.reject(),
    }),
  });
  const middleware = await request();
  assert.equal(middleware.status, 503);
  assert.deepEqual(await middleware.json(), { error: "Middleware failed" });
  const handler = await request("/42", post({}));
  assert.equal(handler.status, 503);
  assert.deepEqual(await handler.json(), { error: "Rejected promise" });
});

test("Zod documentation uses input schemas and preserves explicit metadata overrides", () => {
  const override = { type: "string", format: "date-time" };
  const responses = { 201: { description: "Created", schema: { type: "object" } } };
  const route = zodRoute({
    schemas: {
      query: z.object({ page: z.coerce.number().default(1) }),
      body: z.object({ name: z.string().transform(value => value.length) }),
      params: z.date(),
    },
    docs: { summary: "Create an item", tags: ["items"], responses, schemas: { params: override } },
    handler: (_req, res) => res.end(),
  });
  assert.equal(route.docs.summary, "Create an item");
  assert.deepEqual(route.docs.tags, ["items"]);
  assert.deepEqual(route.docs.responses, responses);
  assert.deepEqual(route.docs.schemas.params, override);
  assert.equal(route.docs.schemas.body.properties.name.type, "string");
  assert.equal(route.docs.schemas.query.properties.page.default, 1);
  assert.equal(route.docs.schemas.query.required, undefined);
  assert.deepEqual(route.docs.schemas.body.required, ["name"]);

  const explicit = zodRoute({ schemas: { body: z.bigint() }, docs: { schemas: { body: false } }, handler: () => {} });
  assert.equal(explicit.docs.schemas.body, false);
  assert.throws(() => zodRoute({ schemas: { body: z.bigint() }, handler: () => {} }), /provide docs\.schemas\.body/);
});

for (const [version, factory] of [[4, express], [5, require("express5")]]) {
  test(`Express ${version} required, optional, and default Zod bodies agree with OpenAPI`, { timeout: 10000 }, async t => {
    const body = z.object({ name: z.string() });
    for (const [name, schema, required, expected] of [
      ["required", body, true, undefined],
      ["optional", body.optional(), false, null],
      ["default", body.default({ name: "Ada" }), false, { name: "Ada" }],
      ["prefault", z.object({ name: z.string().transform(async value => value.toUpperCase()) }).prefault({ name: "Ada" }), false, { name: "ADA" }],
    ]) {
      const definition = zodRoute({
        schemas: { body: schema },
        handler: (req, res) => res.json({ parsed: req.validated.body ?? null, raw: req.body ?? null }),
      });
      const document = generateOpenAPI([{ path: "/", method: "POST", file: `/${name}/route.js`, docs: definition.docs }], {
        title: "Body presence", version: "1",
      });
      assert.equal(document.paths["/"].post.requestBody.required, required, name);
      const request = await serve(t, { POST: definition }, { route: "/", factory });
      const absent = await request("/", { method: "POST" });
      if (required) {
        assert.equal(absent.status, 400, name);
        assert.equal((await absent.json()).error, "Invalid body");
      } else {
        assert.equal(absent.status, 200, name);
        assert.deepEqual(await absent.json(), { parsed: expected, raw: version === 4 ? {} : null }, name);
      }
      const present = await request("/", post({}));
      assert.equal(present.status, 400, `${name}: an explicit empty object must still be validated`);
    }
  });
}

test("body normalization preserves explicit JSON, chunked bodies, and middleware inputs", async t => {
  class EmptyBody {}
  const populated = Object.defineProperty({}, "name", { value: "From middleware" });
  const instance = new EmptyBody();
  const fallback = zodRoute({
    schemas: { body: z.object({ name: z.string() }).default({ name: "Default" }) },
    handler: (req, res) => res.json({ parsed: req.validated.body, raw: req.body }),
  });
  const custom = zodRoute({
    schemas: { body: z.instanceof(EmptyBody) },
    docs: { schemas: { body: true } },
    middleware: (req, _res, next) => { req.body = instance; next(); },
    handler: (req, res) => res.json({ parsed: req.validated.body === instance, raw: req.body === instance }),
  });
  const override = zodRoute({
    schemas: { body: z.object({ name: z.string() }) },
    docs: { bodyRequired: false },
    middleware: (req, _res, next) => { req.body = populated; next(); },
    handler: (req, res) => res.json({ parsed: req.validated.body, same: req.body === populated }),
  });
  const request = await serve(t, { GET: fallback, POST: fallback, PUT: override, PATCH: custom }, { route: "/" });
  for (const options of [{}, { method: "POST", headers: { "content-length": "0" } }]) {
    const response = await request("/", options);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { parsed: { name: "Default" }, raw: {} });
  }
  for (const options of [post({}), {
    method: "POST", headers: { "content-type": "application/json" }, body: Readable.from(["{}"]), duplex: "half",
  }]) {
    const response = await request("/", options);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid body");
  }
  const fromMiddleware = await request("/", { method: "PUT" });
  assert.equal(fromMiddleware.status, 200);
  assert.deepEqual(await fromMiddleware.json(), { parsed: { name: "From middleware" }, same: true });
  const classInstance = await request("/", { method: "PATCH" });
  assert.equal(classInstance.status, 200);
  assert.deepEqual(await classInstance.json(), { parsed: true, raw: true });
  const document = generateOpenAPI([{ path: "/", method: "PUT", file: "/route.js", docs: override.docs }], {
    title: "Explicit presence", version: "1",
  });
  assert.equal(document.paths["/"].put.requestBody.required, false);
  assert.equal(zodRoute({
    schemas: { body: z.object({}).optional() }, docs: { bodyRequired: true }, handler: () => {},
  }).docs.bodyRequired, true);
});

test("body presence inference never runs custom parsers, refinements, or default factories", t => {
  let calls = 0;
  const custom = value => { calls++; return value; };
  const schemas = [
    [z.object({}).refine(async value => { custom(value); return true; }), true],
    [z.array(z.string()), true],
    [z.string(), true],
    [z.coerce.string(), undefined],
    [z.coerce.boolean(), undefined],
    [z.object({}).optional().refine(async value => { custom(value); return false; }), undefined],
    [z.preprocess(custom, z.object({})), undefined],
    [z.object({}).transform(custom), undefined],
    [z.custom(custom), undefined],
    [z.lazy(() => { calls++; return z.object({}); }), undefined],
    [z.object({}).default(() => { calls++; return {}; }), false],
    [z.object({}).prefault(() => { calls++; return {}; }), false],
  ];
  for (const [body, expected] of schemas) {
    // Public Zod methods are prototype accessors; guard their shared parser instead.
    for (const method of ["run", "parse"]) {
      t.mock.method(body._zod, method, () => { throw new Error(`Unexpected ${method} during route creation`); });
    }
    const definition = zodRoute({ schemas: { body }, docs: { schemas: { body: true } }, handler: () => {} });
    assert.equal(definition.docs.bodyRequired, expected, body.type);
  }
  assert.equal(calls, 0);
});

test("malformed adapter schemas fail at route creation with field context", () => {
  for (const options of [undefined, null, false, "invalid", []]) {
    assert.throws(() => zodRoute(options), /Invalid zodRoute options/);
  }
  for (const schemas of [undefined, null, false, "invalid", []]) {
    assert.throws(() => zodRoute({ schemas, handler: () => {} }), /Invalid zodRoute schemas/);
  }
  for (const part of ["params", "query", "body"]) {
    for (const schema of [null, {}, () => {}, "string", z]) {
      assert.throws(() => zodRoute({ schemas: { [part]: schema }, handler: () => {} }),
        new RegExp(`Invalid zodRoute schemas\\.${part}: expected a Zod 4 schema`));
    }
  }
  assert.throws(() => zodRoute({ schemas: { headers: z.object({}) }, handler: () => {} }), /headers; expected params, query, or body/);
  for (const bodyRequired of [null, "true", 1]) {
    assert.throws(() => zodRoute({ schemas: {}, docs: { bodyRequired }, handler: () => {} }), /docs\.bodyRequired/);
  }
});

test("Zod handler types infer outputs, defaults, absent fields, and arrays in strict consumers", { timeout: 30000 }, () => {
  const ts = require("typescript");
  const file = path.join(__dirname, "zod-types.virtual.ts");
  const source = `
    import { z } from "zod";
    import { zodRoute, type ZodRouteRequest, type ZodRouteOptions } from "../dist/src/zod";
    import type { RouteDefinition, RouteModule } from "../dist/src/types";

    const schemas = {
      params: z.object({ id: z.coerce.number() }),
      query: z.object({ limit: z.coerce.number().default(10), search: z.string().optional() }),
      body: z.object({ name: z.string().transform(async name => name.length) }),
    };
    const route: RouteDefinition = zodRoute({ schemas, handler(req, res) {
      const id: number = req.validated.params.id;
      const limit: number = req.validated.query.limit;
      const search: string | undefined = req.validated.query.search;
      const length: number = req.validated.body.name;
      // @ts-expect-error parsed values are output types, not the input strings
      const wrong: string = req.validated.params.id;
      res.json({ id, limit, search, length, wrong });
    }});
    const module: RouteModule = { POST: route };
    const options: ZodRouteOptions<typeof schemas> = { schemas, handler: [
      (req, _res, next) => { const length: number = req.validated.body.name; void length; next(); },
      (req, res) => res.json(req.validated.params.id),
    ] };
    zodRoute(options);
    const inspect = (req: ZodRouteRequest<typeof schemas>) => req.validated.query.limit.toFixed();
    zodRoute({ schemas: { query: z.object({ page: z.coerce.number().default(1) }) }, handler(req, res) {
      const page: number = req.validated.query.page;
      // @ts-expect-error no body schema was supplied
      req.validated.body;
      res.json(page);
    }});
    // @ts-expect-error schema values must be Zod schemas
    zodRoute({ schemas: { body: "string" }, handler: () => {} });
    // @ts-expect-error a handler is required
    zodRoute({ schemas: {} });
    void module; void inspect;
  `;
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === file
    ? ts.createSourceFile(file, source, languageVersion, true)
    : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
});
