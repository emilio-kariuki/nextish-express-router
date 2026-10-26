const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createNextishRouter } = require("../dist/src");

async function serve(t, version, files, globalMiddleware = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-error-middleware-"));
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
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(apiDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
  }
  router = await createRouter({ apiDir, globalMiddleware, logger: () => {} });
  const errors = [];
  const app = express();
  app.use(router);
  app.use((error, _req, res, _next) => {
    errors.push(error);
    res.status(503).json({ error: error.message });
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    errors,
    request: (url = "/b", options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      ...options, signal: AbortSignal.timeout(3000),
    }),
  };
}

const handler = `(req, res) => {
  if (req.query.fail) throw new Error('route failed');
  res.send('ok');
}`;
const catchError = `(error, _req, res, _next) => res
  .set('x-caught-error', error.message).status(599).send('caught')`;
const middleware = `exports.middleware = [(_req, _res, next) => next(), ${catchError}];`;

for (const version of [4, 5]) {
  for (const [name, files, globalMiddleware] of [
    ["directory middleware", { "middleware.js": middleware, "b/route.js": `exports.GET = ${handler};` }],
    ["route middleware", { "b/route.js": `${middleware} exports.GET = ${handler};` }],
    ["method middleware", { "b/route.js": `exports.GET = { middleware: [${catchError}], handler: ${handler} };` }],
    ["handler array", { "b/route.js": `exports.GET = [${handler}, ${catchError}];` }],
    ["global middleware", { "b/route.js": `exports.GET = ${handler};` }, [
      (_req, _res, next) => next(),
      (error, _req, res, _next) => res.set("x-caught-error", error.message).status(599).send("caught"),
    ]],
  ]) {
    test(`Express ${version} ${name} skips error handlers on success and catches route errors`, async t => {
      const { request, errors } = await serve(t, version, files, globalMiddleware);
      const success = await request();
      assert.equal(success.status, 200);
      assert.equal(await success.text(), "ok");
      const failure = await request("/b?fail=yes");
      assert.equal(failure.status, 599);
      assert.equal(await failure.text(), "caught");
      assert.equal(failure.headers.get("x-caught-error"), "route failed");
      assert.deepEqual(errors, []);
    });
  }

  test(`Express ${version} a default directory error handler only protects its descendants`, async t => {
    const { request } = await serve(t, version, {
      "b/middleware.js": `exports.default = ${catchError};`,
      "b/child/route.js": `exports.GET = ${handler};`,
      "c/route.js": `exports.GET = ${handler};`,
    });
    const caught = await request("/b/child?fail=yes");
    assert.equal(caught.status, 599);
    assert.equal(await caught.text(), "caught");
    const outside = await request("/c?fail=yes");
    assert.equal(outside.status, 503);
    assert.deepEqual(await outside.json(), { error: "route failed" });
  });

  for (const [name, errorHandler, message] of [
    ["sync throw", "(_error, _req, _res, _next) => { throw new Error('error handler failed'); }", "error handler failed"],
    ["async rejection", "async (_error, _req, _res, _next) => { await Promise.resolve(); throw new Error('error handler failed'); }", "error handler failed"],
    ["empty rejection", "async (_error, _req, _res, _next) => Promise.reject()", "Rejected promise"],
    ["next(error)", "(error, _req, _res, next) => next(error)", "route failed"],
  ]) {
    test(`Express ${version} error middleware forwards ${name} once`, async t => {
      const { request, errors } = await serve(t, version, {
        "b/route.js": `exports.GET = [${handler}, ${errorHandler}];`,
      });
      const response = await request("/b?fail=yes");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: message });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, message);
    });
  }

  test(`Express ${version} handler-array error middleware can recover and resume normal handlers`, async t => {
    const { request, errors } = await serve(t, version, {
      "b/route.js": `exports.GET = [
        async () => { throw new Error('recoverable'); },
        async (error, req, _res, next) => { await Promise.resolve(); req.caught = error.message; next(); },
        (req, res) => res.send(req.caught),
      ];`,
    });
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "recoverable");
    assert.deepEqual(errors, []);
  });

  test(`Express ${version} global error middleware catches parser and global middleware errors`, async t => {
    const { request, errors } = await serve(t, version, {
      "b/route.js": `exports.GET = ${handler}; exports.POST = ${handler};`,
    }, [
      async (req, _res, next) => {
        if (req.query.fail) throw new Error("global failed");
        next();
      },
      async (error, _req, res, _next) => {
        await Promise.resolve();
        res.status(599).send(error.type ?? error.message);
      },
    ]);
    const globalFailure = await request("/b?fail=yes");
    assert.equal(globalFailure.status, 599);
    assert.equal(await globalFailure.text(), "global failed");
    const parserFailure = await request("/b", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    assert.equal(parserFailure.status, 599);
    assert.equal(await parserFailure.text(), "entity.parse.failed");
    assert.deepEqual(errors, []);
  });
}
