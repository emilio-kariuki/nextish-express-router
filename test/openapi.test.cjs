const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { generateOpenAPI } = require("../dist/src/openapi");

const options = { title: "Example API", version: "1.2.3" };
const route = (path, method = "GET", docs, file = "/private/api/route.js") => ({ path, method, file, docs });

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test("OpenAPI includes options, metadata, parsed-input schemas, and documented responses", () => {
  const input = route("/users/:id", "POST", {
    summary: "Update a user",
    description: "Creates a revision.",
    operationId: "updateUser",
    tags: ["Users"],
    schemas: {
      params: { type: "object", properties: { id: { type: "string", pattern: "^[0-9]+$" } } },
      query: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search text" },
          page: { type: "integer", minimum: 1, default: 1 },
        },
        required: ["search"],
      },
      body: {
        type: "object", properties: { name: { type: "string", minLength: 1 } },
        required: ["name"], additionalProperties: false,
      },
    },
    responses: {
      201: { description: "Updated user", schema: { type: "object", properties: { id: { type: "integer" } } } },
      204: { description: "No content" },
      "4XX": { description: "Client error", schema: { type: "string" }, contentType: "text/plain" },
    },
  });
  const document = generateOpenAPI([input], {
    ...options,
    description: "A useful API",
    servers: [{ url: "https://api.example.test/v1", description: "Production" }, { url: "/api" }],
  });
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.info, { ...options, description: "A useful API" });
  assert.deepEqual(document.servers, [{ url: "https://api.example.test/v1", description: "Production" }, { url: "/api" }]);
  const operation = document.paths["/users/{id}"].post;
  assert.equal(operation.summary, "Update a user");
  assert.equal(operation.description, "Creates a revision.");
  assert.equal(operation.operationId, "updateUser");
  assert.deepEqual(operation.tags, ["Users"]);
  assert.deepEqual(operation.parameters, [
    { name: "id", in: "path", required: true, schema: input.docs.schemas.params.properties.id },
    { name: "page", in: "query", required: false, schema: input.docs.schemas.query.properties.page },
    { name: "search", in: "query", required: true, schema: input.docs.schemas.query.properties.search },
  ]);
  assert.deepEqual(operation.requestBody, { content: { "application/json": { schema: input.docs.schemas.body } } });
  assert.deepEqual(operation.responses, {
    201: { description: "Updated user", content: { "application/json": { schema: input.docs.responses[201].schema } } },
    204: { description: "No content" },
    "4XX": { description: "Client error", content: { "text/plain": { schema: { type: "string" } } } },
  });
  assert.ok(!JSON.stringify(document).includes(input.file));
});

test("undocumented routes still have required path parameters and a valid default response", () => {
  const document = generateOpenAPI([route("/users/:id"), route("/")], options);
  assert.deepEqual(document.paths["/"].get, { responses: { default: { description: "Response" } } });
  assert.deepEqual(document.paths["/users/{id}"].get.parameters, [
    { name: "id", in: "path", required: true, schema: { type: "string" } },
  ]);
  assert.equal("servers" in document, false);
  assert.deepEqual(generateOpenAPI([], options).paths, {});
});

test("object query parameters use deepObject encoding accepted by Express 5 and Zod", async t => {
  const express = require("express5");
  const { z } = require("zod");
  const { registerRouteHandlers } = require("../dist/src/handlers");
  const { zodRoute } = require("../dist/src/zod");
  const definition = zodRoute({
    schemas: {
      query: z.object({
        filter: z.object({ name: z.string(), page: z.string().regex(/^\d+$/).transform(Number) }),
        search: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    },
    handler: (req, res) => res.json(req.validated.query),
  });
  const document = generateOpenAPI([route("/users", "GET", definition.docs)], options);
  const parameters = document.paths["/users"].get.parameters;
  const filter = parameters.find(parameter => parameter.name === "filter");
  assert.equal(filter.style, "deepObject");
  assert.equal(filter.explode, true);
  assert.equal(filter.required, true);
  for (const name of ["search", "tags"]) {
    const parameter = parameters.find(parameter => parameter.name === name);
    assert.equal(parameter.style, undefined);
    assert.equal(parameter.explode, undefined);
    assert.equal(parameter.required, false);
    assert.deepEqual(parameter.schema, definition.docs.schemas.query.properties[name]);
  }

  const app = express();
  app.set("query parser", "extended");
  registerRouteHandlers(app.route("/users"), { GET: definition }, "query-route");
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/users`;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries({ name: "Ada", page: "2" })) {
    query.append(`${filter.name}[${name}]`, value);
  }
  query.set("search", "Ada Lovelace");
  query.append("tags", "new");
  query.append("tags", "active");
  const response = await fetch(`${base}?${query}`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    filter: { name: "Ada", page: 2 }, search: "Ada Lovelace", tags: ["new", "active"],
  });
  const flat = await fetch(`${base}?name=Ada&page=2`, { signal: AbortSignal.timeout(3000) });
  assert.equal(flat.status, 400);
});

test("deepObject rejects query children whose serialization is undefined", () => {
  for (const child of [
    { type: "object", properties: { name: { type: "string" } } },
    { type: "array", items: { type: "string" } },
    { anyOf: [{ type: "string" }, { type: "number" }] },
    {}, true,
  ]) {
    for (const constraints of [
      { properties: { nested: child } },
      { patternProperties: { ".*": child } },
      { additionalProperties: child },
    ]) {
      assert.throws(() => generateOpenAPI([route("/users", "GET", {
        schemas: { query: { type: "object", properties: { filter: { type: "object", ...constraints } } } },
      })], options), /query filter: deepObject supports only scalar child schemas/);
    }
  }
});

test("bodyRequired explicitly documents body presence and rejects invalid metadata", () => {
  for (const required of [true, false]) {
    const document = generateOpenAPI([route("/items", "POST", {
      schemas: { body: { type: "object" } }, bodyRequired: required,
    })], options);
    assert.equal(document.paths["/items"].post.requestBody.required, required);
  }
  for (const bodyRequired of [null, "true", 1]) {
    assert.throws(() => generateOpenAPI([route("/", "POST", {
      schemas: { body: true }, bodyRequired,
    })], options), /docs\.bodyRequired must be a boolean/);
  }
  assert.throws(() => generateOpenAPI([route("/", "POST", { bodyRequired: true })], options),
    /docs\.bodyRequired requires docs\.schemas\.body/);
});

test("Express 4 and 5 required catch-alls document their actual multi-segment behavior", () => {
  for (const source of ["/files/:rest(.+)", "/files/*rest"]) {
    const document = generateOpenAPI([route(source)], options);
    assert.deepEqual(Object.keys(document.paths), ["/files/{rest}"]);
    assert.deepEqual(document.paths["/files/{rest}"].get.parameters, [
      { name: "rest", in: "path", required: true, schema: { type: "string" }, "x-nextish-catch-all": true },
    ]);
  }
});

test("optional catch-alls emit base and wildcard paths with unique operation IDs", () => {
  for (const source of ["/docs/:rest(*)?", "/docs{/*rest}"]) {
    const document = generateOpenAPI([route(source, "GET", {
      operationId: "browse",
      schemas: { params: { type: "object", properties: { rest: { type: "string", minLength: 1 } } } },
    })], options);
    assert.deepEqual(Object.keys(document.paths), ["/docs", "/docs/{rest}"]);
    assert.equal(document.paths["/docs"].get.parameters, undefined);
    assert.equal(document.paths["/docs"].get.operationId, "browse_base");
    assert.equal(document.paths["/docs/{rest}"].get.operationId, "browse_catchAll");
    assert.deepEqual(document.paths["/docs/{rest}"].get.parameters[0].schema, { type: "string", minLength: 1 });
  }
  for (const source of ["/:rest(*)?", "/{*rest}"]) {
    const document = generateOpenAPI([route(source)], options);
    assert.deepEqual(Object.keys(document.paths), ["/", "/{rest}"]);
  }
  const withRequiredSlash = generateOpenAPI([route("/docs/{*rest}")], options);
  assert.deepEqual(Object.keys(withRequiredSlash.paths), ["/docs/", "/docs/{rest}"]);
});

test("numeric parameter names work across quoted Express 5 and Express 4 paths", () => {
  for (const source of ["/:123", '/:"123"']) {
    const document = generateOpenAPI([route(source)], options);
    assert.equal(document.paths["/{123}"].get.parameters[0].name, "123");
  }
  for (const source of ['/*"123"', '/:123(.+)']) {
    const document = generateOpenAPI([route(source)], options);
    assert.equal(document.paths["/{123}"].get.parameters[0]["x-nextish-catch-all"], true);
  }
  for (const source of ['/{*"123"}', '/docs{/*"123"}']) {
    const document = generateOpenAPI([route(source)], options);
    assert.equal(Object.keys(document.paths).length, 2);
  }
});

test("parameter names matching object prototype keys remain ordinary required parameters", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    const document = generateOpenAPI([route(`/:${name}`)], options);
    assert.deepEqual(document.paths[`/{${name}}`].get.parameters, [
      { name, in: "path", required: true, schema: { type: "string" } },
    ]);
  }
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"integer"}},"required":["__proto__"]}');
  const document = generateOpenAPI([route("/:__proto__", "GET", { schemas: { params: schema } })], options);
  assert.deepEqual(document.paths["/{__proto__}"].get.parameters[0].schema, { type: "integer" });
});

test("ALL expands only OpenAPI methods with deterministic unique operation IDs", () => {
  const document = generateOpenAPI([route("/service", "ALL", { operationId: "service" })], options);
  assert.deepEqual(Object.keys(document.paths["/service"]), ["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  for (const [method, operation] of Object.entries(document.paths["/service"])) {
    assert.equal(operation.operationId, `service_${method}`);
  }
  const optional = generateOpenAPI([route("/{*rest}", "ALL", { operationId: "all" })], options);
  const operationIds = Object.values(optional.paths).flatMap(path => Object.values(path).map(operation => operation.operationId));
  assert.equal(operationIds.length, 16);
  assert.equal(new Set(operationIds).size, 16);
});

test("duplicate operations, parameter aliases, and operation IDs fail with source diagnostics", () => {
  assert.throws(() => generateOpenAPI([
    route("/users/:id", "GET", undefined, "/one.js"),
    route("/users/:id", "GET", undefined, "/two.js"),
  ], options), /Duplicate OpenAPI operation.*one\.js.*two\.js/);
  assert.throws(() => generateOpenAPI([
    route("/users/:id", "GET", undefined, "/one.js"),
    route("/users/:slug", "POST", undefined, "/two.js"),
  ], options), /Conflicting OpenAPI paths.*one\.js.*two\.js/);
  assert.throws(() => generateOpenAPI([
    route("/service", "ALL", undefined, "/one.js"),
    route("/service", "GET", undefined, "/two.js"),
  ], options), /Duplicate OpenAPI operation.*one\.js.*two\.js/);
  assert.throws(() => generateOpenAPI([
    route("/one", "GET", { operationId: "same" }, "/one.js"),
    route("/two", "POST", { operationId: "same" }, "/two.js"),
  ], options), /Duplicate OpenAPI operationId same.*one\.js.*two\.js/);
  assert.throws(() => generateOpenAPI([
    route("/docs", "GET", undefined, "/one.js"),
    route("/docs{/*rest}", "GET", undefined, "/two.js"),
  ], options), /Duplicate OpenAPI operation/);
});

test("disjoint methods and static versus dynamic paths can coexist", () => {
  const document = generateOpenAPI([
    route("/users/:id", "POST"), route("/users/:id"), route("/users/new"),
  ], options);
  assert.deepEqual(Object.keys(document.paths["/users/{id}"]), ["get", "post"]);
  assert.ok(document.paths["/users/new"].get);
});

test("output is independent of route order and does not mutate or retain input references", () => {
  const routes = freeze([
    route("/z", "PUT", { tags: ["z"], schemas: { body: { default: { x: [1] } } } }),
    route("/a", "POST", { responses: { 200: { description: "OK", schema: { type: "array", items: { type: "string" } } } } }),
    route("/z", "GET"),
  ]);
  const configuration = freeze({ ...options, servers: [{ url: "/api" }] });
  const before = JSON.stringify({ routes, configuration });
  const document = generateOpenAPI(routes, configuration);
  assert.deepEqual(document, generateOpenAPI([...routes].reverse(), configuration));
  document.servers[0].url = "/elsewhere";
  document.paths["/z"].put.tags.push("new");
  document.paths["/z"].put.requestBody.content["application/json"].schema.default.x.push(2);
  document.paths["/a"].post.responses[200].content["application/json"].schema.items.type = "integer";
  assert.equal(JSON.stringify({ routes, configuration }), before);
});

test("body and response schemas keep local JSON Pointer references resolvable after embedding", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    $ref: "#/$defs/node",
    default: { $ref: "literal example data" },
  };
  const document = generateOpenAPI([route("/a~b", "POST", {
    schemas: { body: schema }, responses: { 200: { description: "OK", contentType: "application/custom+json", schema } },
  })], options);
  const operation = document.paths["/a~b"].post;
  const body = operation.requestBody.content["application/json"].schema;
  const response = operation.responses[200].content["application/custom+json"].schema;
  const resolve = ref => ref.slice(2).split("/").reduce((value, key) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
  assert.equal(resolve(body.$ref), body.$defs.node);
  assert.equal(resolve(body.$defs.node.properties.next.$ref), body.$defs.node);
  assert.equal(resolve(response.$ref), response.$defs.node);
  assert.equal(body.default.$ref, "literal example data");
  assert.equal(schema.$ref, "#/$defs/node");
});

test("draft-07 schema dependencies and additionalItems references resolve without changing literal data", () => {
  const schema = freeze({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: {
      gate: { required: ["dependent"] },
      item: { type: "integer" },
    },
    properties: {
      trigger: { type: "boolean" },
      dependent: { type: "string" },
      values: {
        type: "array", items: [{ type: "string" }], additionalItems: { $ref: "#/definitions/item" },
      },
    },
    dependencies: { trigger: { $ref: "#/definitions/gate" }, dependent: ["trigger"] },
    default: { $ref: "#/definitions/gate", dependencies: { trigger: { $ref: "#/definitions/item" } } },
    examples: [{ additionalItems: { $ref: "#/definitions/item" } }],
  });
  const before = JSON.stringify(schema);
  const document = generateOpenAPI([route("/legacy", "POST", {
    schemas: { body: schema }, responses: { 200: { description: "OK", schema } },
  })], options);
  const operation = document.paths["/legacy"].post;
  const resolve = ref => ref.slice(2).split("/").reduce((value, key) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
  for (const embedded of [operation.requestBody, operation.responses[200]]) {
    const result = embedded.content["application/json"].schema;
    assert.equal(resolve(result.dependencies.trigger.$ref), result.definitions.gate);
    assert.equal(resolve(result.properties.values.additionalItems.$ref), result.definitions.item);
    assert.deepEqual(result.dependencies.dependent, ["trigger"]);
    assert.notEqual(result.dependencies.dependent, schema.dependencies.dependent);
    assert.deepEqual(result.default, schema.default);
    assert.deepEqual(result.examples, schema.examples);
  }
  assert.equal(JSON.stringify(schema), before);
});

test("explicit schema resource IDs retain their own references and boolean schemas survive", () => {
  const schema = { $id: "https://example.test/schema/node", $defs: { node: { type: "string" } }, $ref: "#/$defs/node" };
  const document = generateOpenAPI([route("/items", "POST", {
    schemas: { body: schema, query: { type: "object", properties: { disabled: false } } },
    responses: { 200: { description: "Anything", schema: true }, 400: { description: "Impossible", schema: false } },
  })], options);
  const operation = document.paths["/items"].post;
  assert.deepEqual(operation.requestBody.content["application/json"].schema, schema);
  assert.equal(operation.parameters[0].schema, false);
  assert.equal(operation.responses[200].content["application/json"].schema, true);
  assert.equal(operation.responses[400].content["application/json"].schema, false);
});

test("unrepresentable Express patterns fail clearly instead of generating misleading paths", () => {
  for (const source of ["/users/:id(\\d+)", "/file.:ext", "/optional/:id?", "/literal+", "/:id/:id", "/files/*rest/after", '/:"\\w"']) {
    assert.throws(() => generateOpenAPI([route(source)], options), /OpenAPI path.*private\/api\/route\.js/, source);
  }
  assert.throws(() => generateOpenAPI([route("relative")], options), /must start with/);
  assert.throws(() => generateOpenAPI([route("/", "CONNECT")], options), /Unsupported OpenAPI method CONNECT/);
});

test("unexpandable parameter schemas and unknown path fields require an explicit correction", () => {
  for (const schema of [
    { $ref: "#/definitions/query" },
    { anyOf: [{ type: "object", properties: {} }] },
    { type: "string" },
    { type: "object", properties: { value: { $ref: "#/$defs/value" } } },
  ]) {
    assert.throws(() => generateOpenAPI([route("/", "GET", { schemas: { query: schema } })], options), /docs\.schemas.*override/);
  }
  assert.throws(() => generateOpenAPI([route("/:id", "GET", {
    schemas: { params: { type: "object", properties: { typo: { type: "string" } } } },
  })], options), /unknown path parameter typo/);
  assert.throws(() => generateOpenAPI([route("/", "GET", {
    schemas: { query: { type: "object", properties: {}, required: ["missing"] } },
  })], options), /required must name declared properties/);
  assert.throws(() => generateOpenAPI([route("/", "POST", {
    schemas: { body: { $anchor: "node", $ref: "#node" } },
  })], options), /local schema anchors require an explicit \$id/);
});

test("invalid documentation and non-JSON schemas fail at the generator boundary", () => {
  for (const docs of [
    { summary: 2 }, { operationId: "" }, { tags: "tag" }, { tags: [3] }, { tags: Array(1) }, { schemas: [] },
    { schemas: { body: [] } }, { schemas: { body: { type: undefined } } },
    { schemas: { body: { default: Infinity } } }, { schemas: { body: { default: 1n } } },
    { responses: { 200: { description: 1 } } }, { responses: { 999: { description: "bad" } } },
  ]) {
    assert.throws(() => generateOpenAPI([route("/", "GET", docs)], options), /private\/api\/route\.js/, JSON.stringify(docs, (_key, value) => typeof value === "bigint" ? "bigint" : value));
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => generateOpenAPI([route("/", "POST", { schemas: { body: cyclic } })], options), /serializable JSON/);
  assert.throws(() => generateOpenAPI([], { title: "", version: "1" }), /OpenAPI title/);
  assert.throws(() => generateOpenAPI([], { title: "API", version: 1 }), /OpenAPI version/);
  assert.throws(() => generateOpenAPI([], { ...options, servers: [{ url: false }] }), /servers\[0\]\.url/);
  assert.throws(() => generateOpenAPI([], { ...options, servers: {} }), /servers must be an array/);
  assert.throws(() => generateOpenAPI([], { ...options, servers: Array(1) }), /servers\[0\]/);
  assert.throws(() => generateOpenAPI(Array(1), options), /OpenAPI route must be an object/);
});
