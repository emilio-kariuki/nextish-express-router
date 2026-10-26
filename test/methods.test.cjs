const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const express = require("express");
const { createNextishRouter, mountDirectoryRoutes } = require("../dist/src");

async function fixture(t, files) {
  const apiDir = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-methods-"));
  const realDirectory = await fs.realpath(apiDir);
  const logs = [];
  const disposers = [];
  const servers = [];
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const cached of Object.keys(require.cache)) {
      if (cached.startsWith(realDirectory + path.sep)) delete require.cache[cached];
    }
    await fs.rm(apiDir, { recursive: true, force: true });
  });
  const write = async (relative, source) => {
    const file = path.join(apiDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), ".nextish-route.tmp");
    await fs.writeFile(temporary, source);
    await fs.rename(temporary, file);
  };
  for (const [file, source] of Object.entries(files)) await write(file, source);
  return {
    apiDir, logs, write,
    async mount(options = {}) {
      const router = await createNextishRouter({ apiDir, logger: message => logs.push(message), ...options });
      disposers.push(router.close);
      return router;
    },
    async serve(router) {
      const app = express();
      app.use(router);
      app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return (url = "/", init = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        ...init,
        signal: AbortSignal.timeout(3000),
      });
    },
  };
}

async function update(logs, change, prefix = "Loaded routes:\n") {
  const before = logs.length;
  await change();
  const deadline = Date.now() + 4000;
  while (!logs.slice(before).some(message => message.startsWith(prefix))) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${prefix}: ${logs.slice(before).join("\n")}`);
    await delay(10);
  }
}

test("method middleware and validators stay isolated and run around shared validation in order", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "[id]/route.js": `
      const validators = prefix => Object.fromEntries(['params', 'query', 'body'].map(name => [name, async req => {
        await Promise.resolve();
        req.steps.push(prefix + '.' + name);
      }]));
      exports.middleware = (req, _res, next) => { req.steps.push('route'); next(); };
      exports.validate = validators('shared');
      exports.GET = (req, res) => { req.steps.push('get handler'); res.json(req.steps); };
      exports.POST = {
        middleware: [
          async (req, _res, next) => { await Promise.resolve(); req.steps.push('post async middleware'); next(); },
          (req, _res, next) => { req.steps.push('post middleware'); next(); },
        ],
        validate: validators('post'),
        handler: [
          async (req, _res, next) => { await Promise.resolve(); req.steps.push('first handler'); next(); },
          (req, res) => {
            req.steps.push('last handler');
            res.json({ steps: req.steps, id: req.params.id, body: req.body });
          },
        ],
      };
    `,
  });
  const request = await f.serve(await f.mount({
    globalMiddleware: [(req, _res, next) => { req.steps = ["global"]; next(); }],
  }));
  const get = await request("/item");
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), ["global", "route", "shared.params", "shared.query", "shared.body", "get handler"]);
  const post = await request("/item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), {
    steps: [
      "global", "route", "post async middleware", "post middleware",
      "shared.params", "shared.query", "shared.body", "post.params", "post.query", "post.body",
      "first handler", "last handler",
    ],
    id: "item",
    body: { name: "Ada" },
  });
});

test("method validation adds to shared validation, including when its rules are empty", { timeout: 5000 }, async t => {
  const f = await fixture(t, {
    "route.js": `
      exports.validate = { query: async req => req.query.token === 'valid'
        ? undefined : { ok: false, status: 401, body: { error: 'shared denied' } } };
      exports.GET = { validate: { query: () => ({ ok: true }) }, handler: (_req, res) => res.send('get') };
      exports.POST = { validate: {}, handler: (_req, res) => res.send('post') };
    `,
  });
  const request = await f.serve(await f.mount());
  for (const method of ["GET", "POST"]) {
    const denied = await request("/", { method });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "shared denied" });
    const allowed = await request("/?token=valid", { method });
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), method.toLowerCase());
  }
});

test("method validator failures stop requests and preserve default and custom responses", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "route.js": `
      exports.POST = {
        validate: Object.fromEntries(['params', 'query', 'body'].map(name => [name, req => {
          if (req.query.fail !== name) return;
          if (req.query.mode === 'throw') throw new Error('bad ' + name);
          return Promise.resolve().then(() => {
            if (req.query.mode === 'reject') return Promise.reject(new Error('rejected ' + name));
            if (req.query.mode === 'empty rejection') return Promise.reject();
            if (req.query.mode === 'custom') return { ok: false, status: 422, body: { failed: name } };
            return { ok: false };
          });
        }])),
        handler: (_req, res) => res.send('accepted'),
      };
    `,
  });
  const request = await f.serve(await f.mount());
  for (const name of ["params", "query", "body"]) {
    for (const [mode, status, body] of [
      ["default", 400, { error: `Invalid ${name}` }],
      ["custom", 422, { failed: name }],
      ["throw", 503, { error: `bad ${name}` }],
      ["reject", 503, { error: `rejected ${name}` }],
      ["empty rejection", 503, { error: "Rejected promise" }],
    ]) {
      const response = await request(`/?fail=${name}&mode=${encodeURIComponent(mode)}`, { method: "POST" });
      assert.equal(response.status, status, `${name}: ${mode}`);
      assert.deepEqual(await response.json(), body, `${name}: ${mode}`);
    }
  }
  const response = await request("/", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "accepted");
});

test("method middleware and handler arrays forward sync errors and async rejections to Express", { timeout: 8000 }, async t => {
  const failures = [
    ["sync", "() => { throw new Error('method failed'); }", "method failed"],
    ["async", "async () => { throw new Error('method failed'); }", "method failed"],
    ["empty", "async () => Promise.reject()", "Rejected promise"],
  ];
  const files = {};
  for (const [name, handler] of failures) {
    files[`middleware-${name}/route.js`] = `exports.POST = {
      middleware: [${handler}], handler: (_req, res) => res.end('unexpected'),
    };`;
    files[`handler-${name}/route.js`] = `exports.POST = {
      handler: [(_req, _res, next) => next(), ${handler}],
    };`;
  }
  const f = await fixture(t, files);
  const request = await f.serve(await f.mount());
  for (const field of ["middleware", "handler"]) {
    for (const [name, , error] of failures) {
      const response = await request(`/${field}-${name}`, { method: "POST" });
      assert.equal(response.status, 503, `${field}: ${name}`);
      assert.deepEqual(await response.json(), { error }, `${field}: ${name}`);
    }
  }
});

test("method definitions preserve uppercase precedence, HEAD dispatch and all-method fallbacks", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "route.js": `
      exports.GET = { handler: (_req, res) => res.set('x-handler', 'get').send('get body') };
      exports.get = (_req, res) => res.status(500).end();
      exports.HEAD = {
        middleware: (_req, res, next) => { res.set('x-handler', 'head'); next(); },
        handler: (_req, res) => res.status(204).end(),
      };
      exports.head = (_req, res) => res.status(500).end();
      exports.default = { handler: (_req, res) => res.status(500).end() };
    `,
    "implicit/route.js": "exports.get = { handler: (_req, res) => res.set('x-handler', 'implicit').send('body') };",
    "lower/route.js": `
      exports.get = { handler: (_req, res) => res.status(500).end() };
      exports.head = { handler: (_req, res) => res.set('x-handler', 'lower head').status(204).end() };
    `,
    "default/route.js": `
      exports.middleware = (req, _res, next) => { req.steps = ['route']; next(); };
      exports.validate = { query: req => { req.steps.push('shared validation'); } };
      exports.default = {
        middleware: (req, _res, next) => { req.steps.push('default middleware'); next(); },
        validate: { body: req => { req.steps.push('default validation'); } },
        handler: [
          (req, _res, next) => { req.steps.push('default handler'); next(); },
          (req, res) => res.json({ method: req.method, steps: req.steps }),
        ],
      };
      exports.handler = (_req, res) => res.status(500).end();
    `,
    "handler/route.js": "exports.handler = { handler: (req, res) => res.send('handler ' + req.method) };",
  });
  const request = await f.serve(await f.mount());
  const get = await request();
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("x-handler"), "get");
  assert.equal(await get.text(), "get body");
  assert.equal((await request("/", { method: "POST" })).status, 404);
  for (const [url, status, header] of [["/", 204, "head"], ["/lower", 204, "lower head"], ["/implicit", 200, "implicit"]]) {
    const head = await request(url, { method: "HEAD" });
    assert.equal(head.status, status);
    assert.equal(head.headers.get("x-handler"), header);
    assert.equal(await head.text(), "");
  }
  const fallback = await request("/default", { method: "PATCH" });
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), {
    method: "PATCH",
    steps: ["route", "default middleware", "shared validation", "default validation", "default handler"],
  });
  const handler = await request("/handler", { method: "DELETE" });
  assert.equal(handler.status, 200);
  assert.equal(await handler.text(), "handler DELETE");
});

test("malformed method definitions reject before publication and identify their file and field", { timeout: 10000 }, async t => {
  const handler = "(_req, res) => res.send('unexpected')";
  for (const [name, source, field] of [
    ["missing handler", "exports.POST = {};", "POST.handler"],
    ["null handler", "exports.POST = { handler: null };", "POST.handler"],
    ["empty handler array", "exports.POST = { handler: [] };", "POST.handler"],
    ["sparse handler array", "exports.POST = { handler: Array(1) };", "POST.handler"],
    ["invalid handler array", `exports.POST = { handler: [${handler}, false] };`, "POST.handler"],
    ["invalid middleware", `exports.POST = { handler: ${handler}, middleware: [false] };`, "POST.middleware"],
    ["empty middleware", `exports.POST = { handler: ${handler}, middleware: [] };`, "POST.middleware"],
    ["sparse middleware", `exports.POST = { handler: ${handler}, middleware: Array(1) };`, "POST.middleware"],
    ["null validators", `exports.POST = { handler: ${handler}, validate: null };`, "POST.validate"],
    ["array validators", `exports.POST = { handler: ${handler}, validate: [] };`, "POST.validate"],
    ["invalid validator", `exports.POST = { handler: ${handler}, validate: { body: false } };`, "POST.validate.body"],
    ["null shared validators", "exports.validate = null;", "validate"],
  ]) {
    await t.test(name, async subtest => {
      const f = await fixture(subtest, { "route.js": `exports.GET = ${handler}; ${source}` });
      const app = express();
      app.get("/unrelated", (_req, res) => res.send("unrelated"));
      const before = app._router.stack.slice();
      await assert.rejects(mountDirectoryRoutes(app, { apiDir: f.apiDir, logger: message => f.logs.push(message) }), error => {
        assert.ok(error instanceof TypeError);
        assert.ok(error.message.includes(`Invalid ${field} export`), error.message);
        assert.ok(error.message.includes(path.join(f.apiDir, "route.js")), error.message);
        return true;
      });
      assert.deepEqual(app._router.stack, before);
      const request = await f.serve(app);
      assert.equal((await request("/")).status, 404);
      const unrelated = await request("/unrelated");
      assert.equal(unrelated.status, 200);
      assert.equal(await unrelated.text(), "unrelated");
      assert.equal(f.logs.length, 0);
    });
  }
});

test("an invalid method definition on reload preserves every old method and recovers on a valid edit", { timeout: 10000 }, async t => {
  const source = version => `
    for (const method of ['GET', 'POST']) exports[method] = {
      middleware: (req, _res, next) => { req.version = ${JSON.stringify(version)}; next(); },
      validate: { query: async () => ({ ok: true }) },
      handler: (req, res) => res.send(req.version + ' ' + req.method),
    };
  `;
  const f = await fixture(t, { "route.js": source("old") });
  const request = await f.serve(await f.mount({ watch: true }));
  await update(f.logs, () => f.write("route.js", `${source("rejected")} exports.POST.validate = { body: false };`), "Error reloading ");
  assert.ok(f.logs.some(message => message.includes("Invalid POST.validate.body export")));
  for (const method of ["GET", "POST"]) {
    const response = await request("/", { method });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `old ${method}`);
  }
  assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 1);
  await update(f.logs, () => f.write("route.js", source("recovered")));
  for (const method of ["GET", "POST"]) {
    const response = await request("/", { method });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `recovered ${method}`);
  }
});
