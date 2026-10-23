const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(__dirname, "..");
const handler = value => `exports.GET = (_req, res) => res.send(${JSON.stringify(value)});`;

async function fixture(t, files = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-express5-"));
  const realDirectory = await fs.realpath(directory);
  const apiDir = path.join(directory, "api");
  const logs = [];
  const disposers = [];
  const servers = [];
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const file of Object.keys(require.cache)) {
      if (file.startsWith(realDirectory + path.sep)) delete require.cache[file];
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.cp(path.join(root, "dist/src"), path.join(directory, "dist/src"), { recursive: true });
  await fs.copyFile(path.join(root, "package.json"), path.join(directory, "package.json"));
  await fs.mkdir(path.join(directory, "node_modules"));
  await fs.mkdir(apiDir);
  for (const dependency of ["express", "chokidar", "path-to-regexp", "zod"]) {
    const installed = dependency === "express"
      ? path.dirname(require.resolve("express5/package.json"))
      : await fs.realpath(path.join(root, "node_modules", dependency));
    await fs.symlink(installed, path.join(directory, "node_modules", dependency), "dir");
  }
  const isolatedRequire = createRequire(path.join(directory, "consumer.cjs"));
  const express = isolatedRequire("express");
  const core = isolatedRequire("nextish-express-router");
  assert.match(isolatedRequire("express/package.json").version, /^5\./);
  assert.ok(isolatedRequire.resolve("nextish-express-router").startsWith(realDirectory + path.sep));
  const write = async (relative, source) => {
    const file = path.join(apiDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), ".nextish-update.tmp");
    await fs.writeFile(temporary, source);
    await fs.rename(temporary, file);
  };
  for (const [file, source] of Object.entries(files)) await write(file, source);
  const optionsFor = options => ({ apiDir, logger: message => logs.push(message), ...options });
  return {
    apiDir, logs, express, core, write,
    remove: relative => fs.rm(path.join(apiDir, relative), { recursive: true }),
    polling() {
      // These tests exercise reload transactions; native event delivery is covered separately.
      const chokidar = isolatedRequire("chokidar").default;
      const watch = chokidar.watch;
      t.mock.method(chokidar, "watch", (directory, options) => watch(directory, { ...options, usePolling: true }));
    },
    async mount(options = {}) {
      const router = await core.createNextishRouter(optionsFor(options));
      disposers.push(router.close);
      return router;
    },
    async mountOn(parent, options = {}) {
      const dispose = await core.mountDirectoryRoutes(parent, optionsFor(options));
      disposers.push(dispose);
      return dispose;
    },
    async serve(parent) {
      const app = parent.listen ? parent : express().use(parent);
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return (url = "/", options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        ...options, signal: AbortSignal.timeout(5000),
      });
    },
  };
}

async function update(logs, change, prefix = "Loaded routes:\n") {
  const before = logs.length;
  await change();
  const deadline = Date.now() + 5000;
  while (!logs.slice(before).some(message => message.startsWith(prefix))) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${prefix}: ${logs.slice(before).join("\n")}`);
    await delay(10);
  }
}

async function expectText(request, url, text) {
  const response = await request(url);
  assert.equal(response.status, 200, url);
  assert.equal(await response.text(), text, url);
}

test("Express 5 package discovery matches static, dynamic, catch-all, and numeric parameters", { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    "fixed/route.cjs": handler("static"),
    "[id]/route.js": "exports.GET = (req, res) => res.json({ kind: 'dynamic', params: req.params });",
    "[...rest]/route.mjs": "await Promise.resolve(); export const GET = (req, res) => res.json({ kind: 'required', params: req.params });",
    "docs/[[...rest]]/route.cjs": "exports.GET = (req, res) => res.json({ kind: 'optional', params: req.params });",
    "numbers/[0]/route.js": "exports.GET = (req, res) => res.json({ kind: 'numeric', params: req.params });",
    "numeric-rest/[...123]/route.js": "exports.GET = (req, res) => res.json({ kind: 'numeric catch-all', params: req.params });",
    "literal(a)+!/route.js": handler("literal"),
  });
  const router = await f.mount();
  const request = await f.serve(router);
  await expectText(request, "/fixed", "static");
  await expectText(request, "/literal(a)+!", "literal");
  for (const [url, expected] of [
    ["/value", { kind: "dynamic", params: { id: "value" } }],
    ["/one/two", { kind: "required", params: { rest: ["one", "two"] } }],
    ["/one%2Ftwo/three", { kind: "required", params: { rest: ["one/two", "three"] } }],
    ["/docs", { kind: "optional", params: {} }],
    ["/docs/", { kind: "optional", params: {} }],
    ["/docs/one/two", { kind: "optional", params: { rest: ["one", "two"] } }],
    ["/numbers/42", { kind: "numeric", params: { 0: "42" } }],
    ["/numeric-rest/a/b", { kind: "numeric catch-all", params: { 123: ["a", "b"] } }],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.deepEqual(await response.json(), expected, url);
  }
  assert.equal((await request("/")).status, 404);
  assert.ok(router.getRoutes().some(route => route.path === "/docs{/*rest}"));
  assert.ok(router.getRoutes().some(route => route.path === '/numbers/:"0"'));
});

test("Express 5 optional root catch-alls preserve route prefixes and OpenAPI paths", { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    "[[...rest]]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
  });
  const rootRouter = await f.mount();
  const rootRequest = await f.serve(rootRouter);
  assert.deepEqual(await (await rootRequest("/")).json(), {});
  assert.deepEqual(await (await rootRequest("/one/two")).json(), { rest: ["one", "two"] });
  const prefixed = await f.mount({ routePrefix: "/api" });
  const request = await f.serve(prefixed);
  for (const url of ["/api", "/api/"]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.deepEqual(await response.json(), {}, url);
  }
  assert.deepEqual(await (await request("/api/one/two")).json(), { rest: ["one", "two"] });
  assert.equal((await request("/outside")).status, 404);
  const document = f.core.generateOpenAPI(prefixed.getRoutes(), { title: "Express 5", version: "1" });
  assert.ok(document.paths["/api"].get);
  assert.ok(document.paths["/api/{rest}"].get);
});

test("Express 5 conflicts report filenames and respect parent case sensitivity", { timeout: 10000 }, async t => {
  // Distinct parameter directories preserve literal casing on case-insensitive filesystems.
  const f = await fixture(t, {
    "[id]/Users/route.js": handler("upper"),
    "[slug]/users/route.cjs": handler("lower"),
  });
  await assert.rejects(f.mount(), error => {
    assert.match(error.message, /Route conflict:/);
    assert.ok(error.message.includes(path.join(f.apiDir, "[id]/Users/route.js")));
    assert.ok(error.message.includes(path.join(f.apiDir, "[slug]/users/route.cjs")));
    return true;
  });
  for (const kind of ["application", "router"]) {
    const parent = kind === "application" ? f.express() : f.express.Router({ caseSensitive: true });
    if (kind === "application") parent.enable("case sensitive routing");
    const dispose = await f.mountOn(parent);
    assert.equal(dispose.getRoutes().length, 2);
    const request = await f.serve(parent);
    await expectText(request, "/value/Users", "upper");
    await expectText(request, "/value/users", "lower");
    assert.equal((await request("/value/USERS")).status, 404, kind);
  }
});

for (const kind of ["application", "router"]) {
  test(`Express 5 ${kind} mounts preserve explicit HEAD and downstream OPTIONS/CORS`, { timeout: 10000 }, async t => {
    const f = await fixture(t, {
      "route.js": `
        exports.GET = (_req, res) => res.set('x-handler', 'get').send('get');
        exports.HEAD = (_req, res) => res.set('x-handler', 'head').status(204).end();
      `,
      "implicit/route.js": "exports.GET = (_req, res) => res.set('x-handler', 'implicit').send('body');",
      "automatic/route.js": handler("get"),
    });
    const parent = kind === "application" ? f.express() : f.express.Router();
    parent.post("/automatic", (_req, res) => res.send("post"));
    await f.mountOn(parent);
    parent.options("/", (_req, res) => res.set("access-control-allow-origin", "https://example.com").status(204).end());
    parent.put("/automatic", (_req, res) => res.send("put"));
    const request = await f.serve(parent);
    for (const [url, status, name] of [["/", 204, "head"], ["/implicit", 200, "implicit"]]) {
      const response = await request(url, { method: "HEAD" });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("x-handler"), name);
      assert.equal(await response.text(), "");
    }
    const explicit = await request("/", { method: "OPTIONS" });
    assert.equal(explicit.status, 204);
    assert.equal(explicit.headers.get("access-control-allow-origin"), "https://example.com");
    const automatic = await request("/automatic", { method: "OPTIONS" });
    assert.equal(automatic.status, 200);
    assert.deepEqual(new Set(automatic.headers.get("allow").split(",").map(method => method.trim())),
      new Set(["POST", "GET", "HEAD", "PUT"]));
  });

  test(`Express 5 ${kind} mounts keep parent middleware, parameter caching, and dispatch scope`, { timeout: 10000 }, async t => {
    const f = await fixture(t, {
      "items/[id]/route.js": `exports.GET = (req, res) => res.json({
        steps: req.steps, calls: req.paramCalls, id: req.params.id, tenant: req.params.tenant, baseUrl: req.baseUrl,
      });`,
      "escape/middleware.js": "exports.middleware = (_req, _res, next) => next('router');",
      "escape/route.js": handler("unexpected middleware escape"),
      "leave/route.js": "exports.GET = (_req, _res, next) => next('router');",
      "skip/route.js": "exports.GET = (_req, _res, next) => next('route');",
    });
    const parent = kind === "application" ? f.express()
      : f.express.Router({ mergeParams: true, caseSensitive: true, strict: true });
    if (kind === "application") {
      parent.enable("case sensitive routing");
      parent.enable("strict routing");
    }
    parent.use((req, _res, next) => { req.steps = ["parent"]; req.paramCalls = 0; next(); });
    parent.param("id", (req, _res, next, id) => {
      req.steps.push("first param"); req.paramCalls++; req.params.id = id.toUpperCase(); next();
    });
    parent.get("/items/:id", (_req, _res, next) => next());
    parent.get("/unrelated", (_req, res) => res.send("unrelated"));
    await f.mountOn(parent);
    parent.param("id", (req, _res, next) => { req.steps.push("later param"); next(); });
    parent.get("/escape", (_req, res) => res.send("inside"));
    parent.get("/leave", (_req, res) => res.send("inside"));
    parent.get("/skip", (_req, res) => res.send("after"));
    const outer = f.express();
    const base = kind === "router" ? "/tenants/acme" : "";
    outer.use(kind === "router" ? "/tenants/:tenant" : "/", parent);
    outer.use((_req, res) => res.status(401).send("outside"));
    const request = await f.serve(outer);
    const response = await request(`${base}/items/value`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      steps: ["parent", "first param", "later param"], calls: 1, id: "VALUE", baseUrl: base,
      ...(kind === "router" ? { tenant: "acme" } : {}),
    });
    for (const route of ["escape", "leave"]) {
      const escaped = await request(`${base}/${route}`);
      assert.equal(escaped.status, 401);
      assert.equal(await escaped.text(), "outside");
    }
    await expectText(request, `${base}/skip`, "after");
    await expectText(request, `${base}/unrelated`, "unrelated");
    assert.equal((await request(`${base}/Items/value`)).status, 401);
    assert.equal((await request(`${base}/items/value/`)).status, 401);
  });
}

test("Express 5 directory middleware reloads are atomic, recover from errors, and preserve in-flight chains", { timeout: 15000 }, async t => {
  const child = value => `exports.middleware = (req, _res, next) => { req.steps.push(${JSON.stringify(value)}); next(); };`;
  const f = await fixture(t, {
    "middleware.js": `exports.middleware = (req, res, next) => {
      if (req.get('authorization') !== 'allowed') return res.status(401).send('denied');
      req.steps = ['root']; next();
    };`,
    "child/middleware.js": child("old"),
    "child/route.js": "exports.GET = (req, res) => res.json(req.steps);",
    "other/route.js": "exports.GET = (req, res) => res.json(req.steps);",
  });
  f.polling();
  let resume;
  let reached;
  const paused = new Promise(resolve => { reached = resolve; });
  const router = await f.mount({
    watch: true,
    globalMiddleware: [(req, _res, next) => {
      if (req.get("x-pause") !== "yes") return next();
      resume = next; reached();
    }],
  });
  const request = await f.serve(router);
  const init = { headers: { authorization: "allowed" } };
  const original = router.getRoutes();
  await update(f.logs, () => f.write("child/middleware.js", "exports.middleware = [];"), "Error reloading ");
  assert.deepEqual(router.getRoutes(), original);
  assert.equal((await request("/child")).status, 401);
  assert.deepEqual(await (await request("/child", init)).json(), ["root", "old"]);
  assert.deepEqual(await (await request("/other", init)).json(), ["root"]);
  const pending = request("/child", { headers: { authorization: "allowed", "x-pause": "yes" } });
  pending.catch(() => {});
  try {
    await paused;
    await update(f.logs, () => f.write("child/middleware.js", child("new")));
    assert.deepEqual(await (await request("/child", init)).json(), ["root", "new"]);
    assert.equal((await request("/child")).status, 401);
    resume();
    resume = undefined;
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ["root", "old"]);
  } finally {
    resume?.();
  }
  await update(f.logs, () => f.remove("child/middleware.js"));
  assert.deepEqual(await (await request("/child", init)).json(), ["root"]);
});

test("Express 5 inspection returns detached snapshots and close freezes one mount while another reloads", { timeout: 15000 }, async t => {
  const source = value => `exports.GET = {
    docs: { summary: ${JSON.stringify(value)}, tags: ['items'], responses: { 200: { description: 'OK', schema: { type: 'string' } } } },
    handler: (_req, res) => res.send(${JSON.stringify(value)}),
  };`;
  const f = await fixture(t, { "items/route.cjs": source("before") });
  f.polling();
  const frozen = await f.mount({ watch: true });
  const original = frozen.getRoutes();
  assert.equal(original.length, 1);
  assert.deepEqual(original[0], {
    path: "/items", method: "GET", file: path.join(f.apiDir, "items/route.cjs"),
    docs: { summary: "before", tags: ["items"], responses: { 200: { description: "OK", schema: { type: "string" } } } },
  });
  const changed = frozen.getRoutes();
  changed[0].path = "/tampered";
  changed[0].docs.tags.push("tampered");
  changed[0].docs.responses[200].schema.type = "number";
  changed.length = 0;
  assert.deepEqual(frozen.getRoutes(), original);
  const closing = frozen.close();
  assert.equal(frozen.close(), closing);
  await closing;
  const frozenLogs = f.logs.length;
  const liveLogs = [];
  const live = await f.mount({ watch: true, logger: message => liveLogs.push(message) });
  const app = f.express();
  app.use("/frozen", frozen);
  app.use("/live", live);
  const request = await f.serve(app);
  await update(liveLogs, () => f.write("items/route.cjs", source("after")));
  await expectText(request, "/frozen/items", "before");
  await expectText(request, "/live/items", "after");
  assert.deepEqual(frozen.getRoutes(), original);
  assert.equal(live.getRoutes()[0].docs.summary, "after");
  assert.equal(f.logs.length, frozenLogs);
  await frozen.close();
});

test("Express 5 Zod routes parse getter-only query inputs and expose transformed outputs", { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    "[id]/route.cjs": `
      const { z } = require('zod');
      const { zodRoute } = require('nextish-express-router/zod');
      exports.validate = { params: req => req.get('authorization') === 'allowed'
        ? undefined : { ok: false, status: 401, body: { error: 'shared denied' } } };
      exports.POST = zodRoute({
        schemas: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          query: z.object({ limit: z.coerce.number().int().positive().default(2) }),
          body: z.object({ name: z.string().trim().transform(async name => name.toUpperCase()) }),
        },
        handler: (req, res) => {
          let owner = req;
          while (owner && !Object.hasOwn(owner, 'query')) owner = Object.getPrototypeOf(owner);
          const descriptor = Object.getOwnPropertyDescriptor(owner, 'query');
          res.json({ parsed: req.validated, query: req.query, ownQuery: Object.hasOwn(req, 'query'), getter: typeof descriptor.get === 'function' });
        },
      });
    `,
  });
  const router = await f.mount();
  const request = await f.serve(router);
  const options = {
    method: "POST", headers: { "content-type": "application/json", authorization: "allowed" },
    body: JSON.stringify({ name: " Ada " }),
  };
  const response = await request("/42?limit=3", options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    parsed: { params: { id: 42 }, query: { limit: 3 }, body: { name: "ADA" } },
    query: { limit: "3" }, ownQuery: false, getter: true,
  });
  const defaults = await request("/42", options);
  assert.equal(defaults.status, 200);
  assert.deepEqual((await defaults.json()).parsed.query, { limit: 2 });
  const invalid = await request("/42?limit=bad", options);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "Invalid query");
  const unauthorized = await request("/42", { ...options, headers: { "content-type": "application/json" } });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "shared denied" });
  const document = f.core.generateOpenAPI(router.getRoutes(), { title: "Express 5 Zod", version: "1" });
  assert.equal(document.paths["/{id}"].post.requestBody.content["application/json"].schema.properties.name.type, "string");
});
