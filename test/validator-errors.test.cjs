const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createNextishRouter } = require("../dist/src");

async function serve(t, version, source, { globalMiddleware = [], errorHandler } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-validator-errors-"));
  const realDirectory = await fs.realpath(directory);
  const apiDir = path.join(directory, "api");
  let router;
  let server;
  t.after(async () => {
    await router?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const file of Object.keys(require.cache)) {
      if (file.startsWith(realDirectory + path.sep)) delete require.cache[file];
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  let express = require("express");
  let createRouter = createNextishRouter;
  if (version === 5) {
    await fs.cp(path.join(__dirname, "../dist/src"), path.join(directory, "dist/src"), { recursive: true });
    await fs.mkdir(path.join(directory, "node_modules"));
    for (const dependency of ["express", "chokidar", "path-to-regexp"]) {
      const installed = dependency === "express"
        ? path.dirname(require.resolve("express5/package.json"))
        : await fs.realpath(path.join(__dirname, "../node_modules", dependency));
      await fs.symlink(installed, path.join(directory, "node_modules", dependency), "dir");
    }
    const isolatedRequire = createRequire(path.join(directory, "consumer.cjs"));
    express = isolatedRequire("express");
    createRouter = isolatedRequire("./dist/src").createNextishRouter;
  }
  await fs.mkdir(apiDir);
  await fs.writeFile(path.join(apiDir, "route.js"), source);
  router = await createRouter({ apiDir, globalMiddleware, logger: () => {} });
  const app = express();
  app.set("env", "production");
  app.use(router);
  if (errorHandler) app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (url = "/", options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    ...options, signal: AbortSignal.timeout(3000),
  });
}

for (const version of [4, 5]) {
  for (const scope of ["shared", "method"]) {
    test(`Express ${version} ${scope} validators distinguish returned failures from thrown errors`, async t => {
      const failure = new Error("private database connection failed");
      const errors = [];
      const requests = [];
      const request = await serve(t, version, `
        const validate = Object.fromEntries(['params', 'query', 'body'].map(part => [part, req => {
          req.validationSteps.push(part);
          if (req.query.part !== part) return;
          if (req.query.mode === 'throw') throw req.validationError;
          if (req.query.mode === 'reject') return Promise.reject(req.validationError);
          if (req.query.mode === 'empty') return Promise.reject();
          if (req.query.mode === 'custom') return { ok: false, status: 422, body: { invalid: part } };
          return Promise.resolve({ ok: false });
        }]));
        const handler = (req, res) => { req.validationSteps.push('handler'); res.send('accepted'); };
        ${scope === "shared" ? "exports.validate = validate; exports.GET = handler;" : "exports.GET = { validate, handler };"}
      `, {
        globalMiddleware: [(req, _res, next) => {
          req.validationError = failure;
          req.validationSteps = [];
          requests.push(req.validationSteps);
          next();
        }],
        errorHandler: (error, _req, res, _next) => {
          errors.push(error);
          res.status(503).send("validator error");
        },
      });
      const parts = ["params", "query", "body"];
      for (const part of parts) {
        for (const mode of ["throw", "reject", "empty", "default", "custom"]) {
          const label = `${part}: ${mode}`;
          const before = errors.length;
          const response = await request(`/?part=${part}&mode=${mode}`);
          if (mode === "default" || mode === "custom") {
            assert.equal(response.status, mode === "custom" ? 422 : 400, label);
            assert.deepEqual(await response.json(), mode === "custom" ? { invalid: part } : { error: `Invalid ${part}` }, label);
            assert.equal(errors.length, before, label);
          } else {
            assert.equal(response.status, 503, label);
            assert.equal(await response.text(), "validator error", label);
            assert.equal(errors.length, before + 1, label);
            if (mode === "empty") {
              assert.ok(errors.at(-1) instanceof Error, label);
              assert.equal(errors.at(-1).message, "Rejected promise", label);
            } else {
              assert.equal(errors.at(-1), failure, label);
            }
          }
          assert.deepEqual(requests.at(-1), parts.slice(0, parts.indexOf(part) + 1), label);
        }
      }
      const success = await request();
      assert.equal(success.status, 200);
      assert.equal(await success.text(), "accepted");
      assert.deepEqual(requests.at(-1), [...parts, "handler"]);
    });
  }

  test(`Express ${version} unhandled validator exceptions use the default 500 response`, async t => {
    const request = await serve(t, version, `
      exports.validate = { query: req => {
        const error = new Error('private database connection failed');
        if (req.query.mode === 'throw') throw error;
        return Promise.reject(error);
      } };
      exports.GET = (_req, res) => res.send('unexpected');
    `);
    for (const mode of ["throw", "reject"]) {
      const response = await request(`/?mode=${mode}`);
      assert.equal(response.status, 500, mode);
      const body = await response.text();
      assert.match(body, /Internal Server Error/, mode);
      assert.doesNotMatch(body, /private database connection failed|unexpected/, mode);
    }
  });

  test(`Express ${version} Zod parse failures still return 400 with issues`, async t => {
    const request = await serve(t, version, `
      const { z } = require(${JSON.stringify(require.resolve("zod"))});
      const { zodRoute } = require(${JSON.stringify(require.resolve("../dist/src/zod"))});
      exports.POST = zodRoute({
        schemas: { body: z.object({ name: z.string() }) },
        handler: (req, res) => res.json(req.validated.body),
      });
    `);
    const post = body => request("/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const invalid = await post({ name: 123 });
    assert.equal(invalid.status, 400);
    const body = await invalid.json();
    assert.equal(body.error, "Invalid body");
    assert.ok(body.issues.length > 0);
    const valid = await post({ name: "Ada" });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { name: "Ada" });
  });
}
