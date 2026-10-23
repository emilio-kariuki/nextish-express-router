const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const { createNextishRouter } = require("../dist/src");

async function serve(t, source, options = {}, optionsArgument = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-api-"));
  let router;
  let server;
  t.after(async () => {
    await router?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, "route.js"), source);
  const settings = { logger: () => {}, ...options };
  router = optionsArgument
    ? await createNextishRouter({ ...settings, apiDir: path.relative(process.cwd(), directory) })
    : await createNextishRouter(directory, settings);
  const app = express();
  app.use(router);
  app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    router,
    request: (url = "/", init = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      ...init,
      signal: AbortSignal.timeout(3000),
    }),
  };
}

for (const [name, middleware] of [
  ["async", async () => { throw new Error("middleware failed"); }],
  ["sync", () => { throw new Error("middleware failed"); }],
]) {
  test(`${name} global middleware failures reach Express error handlers`, { timeout: 5000 }, async t => {
    const { request } = await serve(t, 'exports.GET = (_req, res) => res.end("unexpected");', {
      globalMiddleware: [middleware],
    });
    const response = await request();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "middleware failed" });
  });
}

test("promise rejections without a reason stop the request and reach Express error handlers", { timeout: 5000 }, async t => {
  const handler = 'exports.GET = (_req, res) => res.end("unexpected");';
  for (const [name, source, options] of [
    ["global middleware", handler, { globalMiddleware: [async () => Promise.reject()] }],
    ["route middleware", 'exports.middleware = async () => Promise.reject();' + handler],
    ["handler array", 'exports.GET = [async () => Promise.reject(), (_req, res) => res.end("unexpected")];'],
  ]) {
    await t.test(name, async subtest => {
      const { request } = await serve(subtest, source, options);
      const response = await request();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Rejected promise" });
    });
  }
});

test("global middleware runs in order before route middleware and handlers", { timeout: 5000 }, async t => {
  const { request } = await serve(t, `
    exports.middleware = (req, _res, next) => { req.steps.push('route'); next(); };
    exports.POST = (req, res) => res.json({ steps: req.steps, body: req.body });
  `, {
    globalMiddleware: [
      async (req, _res, next) => {
        await Promise.resolve();
        req.steps = ["async global"];
        next();
      },
      (req, _res, next) => {
        req.steps.push("sync global");
        next();
      },
    ],
  });
  const response = await request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    steps: ["async global", "sync global", "route"],
    body: { name: "Ada" },
  });
});

test("disabling body parsing leaves the request available to caller middleware", { timeout: 5000 }, async t => {
  const { request } = await serve(t, "exports.POST = (req, res) => res.json({ body: req.body });", {
    bodyParser: false,
    globalMiddleware: [express.text({ type: "application/json" })],
  });
  const body = JSON.stringify({ name: "Ada" });
  const response = await request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { body });
});

test("async route and route middleware failures use the same Express error path", { timeout: 5000 }, async t => {
  for (const [name, source] of [
    ["route handler", 'exports.GET = async () => { throw new Error("route failed"); };'],
    ["route middleware", 'exports.middleware = async () => { throw new Error("route failed"); }; exports.GET = (_req, res) => res.end("unexpected");'],
    ["handler array", 'exports.GET = [(_req, _res, next) => next(), async () => { throw new Error("route failed"); }];'],
  ]) {
    await t.test(name, async subtest => {
      const { request } = await serve(subtest, source);
      const response = await request();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "route failed" });
    });
  }
});

test("the options overload resolves relative directories and keeps the route prefix", { timeout: 5000 }, async t => {
  const { router, request } = await serve(t, 'exports.GET = (_req, res) => res.json({ ok: true });', {
    routePrefix: "/api",
  }, true);
  const response = await request("/api");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await request("/")).status, 404);
  await router.close();
  await router.close();
  assert.equal((await request("/api")).status, 200);
});
