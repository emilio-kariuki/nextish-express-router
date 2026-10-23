const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const chokidar = require("chokidar").default;
const express = require("express");
const { createNextishRouter, mountDirectoryRoutes } = require("../dist/src");

const middleware = name => `exports.middleware = (req, _res, next) => {
  (req.steps ??= []).push(${JSON.stringify(name)}); next();
};`;
const handler = "exports.GET = (req, res) => res.json(req.steps ?? []);";

async function fixture(t, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-directory-middleware-"));
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
    for (const cached of Object.keys(require.cache)) {
      if (cached.startsWith(realDirectory + path.sep)) delete require.cache[cached];
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(apiDir);
  const write = async (relative, source) => {
    const file = path.join(apiDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), ".nextish-middleware.tmp");
    await fs.writeFile(temporary, source);
    await fs.rename(temporary, file);
  };
  for (const [file, source] of Object.entries(files)) await write(file, source);
  return {
    apiDir, logs, disposers, write,
    remove: relative => fs.rm(path.join(apiDir, relative), { recursive: true }),
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

async function expectSteps(request, url, steps, init) {
  const response = await request(url, init);
  assert.equal(response.status, 200, url);
  assert.deepEqual(await response.json(), steps, url);
}

test("directory middleware inherits root-to-leaf with full params before route and method validation", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "../middleware.js": 'throw new Error("ancestor above apiDir loaded");',
    "middleware.ts": `
      exports.middleware = [
        async (req, res, next) => {
          await Promise.resolve();
          req.steps.push('root async');
          req.directoryParams = { ...req.params };
          req.directoryBody = req.body;
          res.set('x-directory', 'root');
          next();
        },
        (req, _res, next) => { req.steps.push('root'); next(); },
      ];
      exports.default = () => { throw new Error('named middleware must win'); };
    `,
    "route.js": handler,
    "teams/middleware.jsx": "exports.default = (req, _res, next) => { req.steps.push('teams'); next(); };",
    "teams/route.js": handler,
    "teams/[team]/users/middleware.tsx": "exports.default = [(req, _res, next) => { req.steps.push('users'); next(); }];",
    "teams/[team]/users/[id]/route.js": `
      const validators = prefix => Object.fromEntries(['params', 'query', 'body'].map(name => [name, async req => {
        await Promise.resolve(); req.steps.push(prefix + '.' + name);
      }]));
      exports.middleware = (req, _res, next) => { req.steps.push('route'); next(); };
      exports.validate = validators('shared');
      exports.POST = {
        middleware: (req, _res, next) => { req.steps.push('method'); next(); },
        validate: validators('method'),
        handler: [
          async (req, _res, next) => { await Promise.resolve(); req.steps.push('first handler'); next(); },
          (req, res) => {
            req.steps.push('last handler');
            res.json({ steps: req.steps, params: req.directoryParams, body: req.directoryBody });
          },
        ],
      };
    `,
    "sibling/route.js": handler,
  });
  const request = await f.serve(await f.mount({
    routePrefix: "/api",
    globalMiddleware: [(req, _res, next) => { req.steps = [req.body?.ready ? "global parsed" : "global"]; next(); }],
  }));
  const response = await request("/api/teams/acme/users/7", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ready: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    steps: [
      "global parsed", "root async", "root", "teams", "users", "route", "method",
      "shared.params", "shared.query", "shared.body", "method.params", "method.query", "method.body",
      "first handler", "last handler",
    ],
    params: { team: "acme", id: "7" }, body: { ready: true },
  });
  await expectSteps(request, "/api", ["global", "root async", "root"]);
  await expectSteps(request, "/api/teams", ["global", "root async", "root", "teams"]);
  await expectSteps(request, "/api/sibling", ["global", "root async", "root"]);
  for (const [url, method, status] of [
    ["/api/missing", "GET", 404], ["/api/sibling", "POST", 404],
    ["/api/sibling", "OPTIONS", 200], ["/", "GET", 404],
  ]) {
    const unmatched = await request(url, { method });
    assert.equal(unmatched.status, status);
    assert.equal(unmatched.headers.get("x-directory"), null);
  }
  assert.equal((await request("/api/sibling", { method: "HEAD" })).headers.get("x-directory"), "root");
});

test("child and method middleware cannot bypass an ancestor's denial", { timeout: 5000 }, async t => {
  const f = await fixture(t, {
    "middleware.js": `exports.middleware = async (req, res, next) => {
      await Promise.resolve();
      if (req.get('authorization') !== 'allowed') return res.status(401).json({ error: 'ancestor denied' });
      next();
    };`,
    "child/middleware.js": "exports.middleware = (_req, res, next) => { res.set('x-child', 'ran'); next(); };",
    "child/route.js": `exports.GET = {
      middleware: (_req, _res, next) => next(),
      validate: {}, handler: (_req, res) => res.send('allowed'),
    };`,
  });
  const request = await f.serve(await f.mount());
  const denied = await request("/child");
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "ancestor denied" });
  assert.equal(denied.headers.get("x-child"), null);
  const allowed = await request("/child", { headers: { authorization: "allowed" } });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "allowed");
  assert.equal(allowed.headers.get("x-child"), "ran");
});

test("directory middleware throws and promise rejections reach Express error handlers", { timeout: 8000 }, async t => {
  for (const [name, source, error] of [
    ["sync", "() => { throw new Error('directory failed'); }", "directory failed"],
    ["async", "async () => { throw new Error('directory failed'); }", "directory failed"],
    ["no rejection reason", "async () => Promise.reject()", "Rejected promise"],
  ]) {
    await t.test(name, async subtest => {
      const f = await fixture(subtest, { "child/middleware.js": `exports.default = ${source};`, "child/route.js": handler });
      const request = await f.serve(await f.mount());
      const response = await request("/child");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error });
    });
  }
});

test("invalid directory exports reject without mounting any routes", { timeout: 10000 }, async t => {
  for (const [name, source] of [
    ["bare CommonJS function", "module.exports = (_req, _res, next) => next();"],
    ["null module", "module.exports = null;"],
    ["missing export", "exports.handler = (_req, _res, next) => next();"],
    ["empty named array", "exports.middleware = [];"],
    ["empty default array", "exports.default = [];"],
    ["mixed array", "exports.middleware = [(_req, _res, next) => next(), false];"],
    ["invalid named with valid default", "exports.middleware = null; exports.default = (_req, _res, next) => next();"],
  ]) {
    await t.test(name, async subtest => {
      const f = await fixture(subtest, { "route.js": handler, "child/route.js": handler, "child/middleware.js": source });
      const app = express();
      app.get("/unrelated", (_req, res) => res.send("unrelated"));
      const before = app._router.stack.slice();
      await assert.rejects(mountDirectoryRoutes(app, { apiDir: f.apiDir, logger: message => f.logs.push(message) }), error => {
        assert.ok(error instanceof TypeError);
        assert.ok(error.message.includes(path.join(f.apiDir, "child/middleware.js")), error.message);
        return true;
      });
      assert.deepEqual(app._router.stack, before);
      const request = await f.serve(app);
      assert.equal((await request("/")).status, 404);
      assert.equal((await request("/child")).status, 404);
      assert.equal(await (await request("/unrelated")).text(), "unrelated");
      assert.equal(f.logs.length, 0);
    });
  }
});

test("invalid initial directory middleware closes its watcher", { timeout: 8000 }, async t => {
  const f = await fixture(t, { "middleware.js": "exports.middleware = [];", "route.js": handler });
  await promisify(execFile)(process.execPath, ["-e", `
    require(process.argv[1]).createNextishRouter({ apiDir: process.argv[2], watch: true, logger: () => {} }).then(
      () => { process.exitCode = 1; },
      error => { if (!error.message.includes('middleware.js')) process.exitCode = 1; },
    );
  `, path.resolve(__dirname, "../dist/src"), f.apiDir], { timeout: 5000 });
});

test("middleware discovery and watching ignore hidden paths, symlinks and unconfigured extensions", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "middleware.js": middleware("root"), "route.js": handler, "plain/route.js": handler,
    "middleware.ts": 'throw new Error("unconfigured middleware loaded");',
    ".hidden/middleware.js": 'throw new Error("hidden middleware loaded");',
    "../foreign/middleware.js": 'throw new Error("symlink middleware loaded");',
    "../foreign/route.js": handler,
  });
  await fs.symlink(path.join(f.apiDir, "../foreign/middleware.js"), path.join(f.apiDir, "plain/middleware.js"));
  const request = await f.serve(await f.mount({ extensions: ["js"], watch: true }));
  await expectSteps(request, "/plain", ["root"]);
  await f.write("middleware.ts", 'throw new Error("unconfigured update loaded");');
  await f.write(".hidden/middleware.js", 'throw new Error("hidden update loaded");');
  await f.write("middleware.js.map", 'throw new Error("source map loaded");');
  await fs.symlink(path.join(f.apiDir, "../foreign"), path.join(f.apiDir, "linked"), "dir");
  await update(f.logs, () => f.write("middleware.js", middleware("updated")));
  await expectSteps(request, "/", ["updated"]);
  await expectSteps(request, "/plain", ["updated"]);
  assert.equal((await request("/linked")).status, 404);
  assert.equal(f.logs.length, 2);
});

test("middleware add, change and removal update descendants without rerunning unrelated modules", { timeout: 15000 }, async t => {
  const route = `require('../state.js').routes++; ${handler}`;
  const root = version => `require('./state.js').root++; ${middleware(version)}`;
  const child = `require('../state.js').child++; ${middleware("child")}`;
  const f = await fixture(t, {
    "state.js": "module.exports = { routes: 0, root: 0, child: 0 };",
    "a/route.js": route, "b/route.js": route,
  });
  const request = await f.serve(await f.mount({ watch: true }));
  const state = require(path.join(f.apiDir, "state.js"));
  await expectSteps(request, "/a", []);
  await update(f.logs, () => f.write("middleware.js", root("root one")));
  await expectSteps(request, "/a", ["root one"]);
  await expectSteps(request, "/b", ["root one"]);
  await update(f.logs, () => f.write("a/middleware.js", child));
  await expectSteps(request, "/a", ["root one", "child"]);
  await expectSteps(request, "/b", ["root one"]);
  await update(f.logs, () => f.write("middleware.js", root("root two")));
  await expectSteps(request, "/a", ["root two", "child"]);
  await expectSteps(request, "/b", ["root two"]);
  assert.deepEqual(state, { routes: 2, root: 2, child: 1 });
  await update(f.logs, () => f.remove("a/middleware.js"));
  await expectSteps(request, "/a", ["root two"]);
  await update(f.logs, () => f.remove("middleware.js"));
  await expectSteps(request, "/a", []);
  await expectSteps(request, "/b", []);
  assert.deepEqual(state, { routes: 2, root: 2, child: 1 });
});

test("malformed middleware reloads retain all working protection and handlers until recovery", { timeout: 15000 }, async t => {
  // Recovery assertions use polling; native discovery is covered separately.
  const watch = chokidar.watch;
  t.mock.method(chokidar, "watch", (directory, options) => watch(directory, { ...options, usePolling: true }));
  const guard = version => `exports.middleware = (req, res, next) => {
    if (req.get('authorization') !== 'allowed') return res.status(401).send('denied');
    req.steps = [${JSON.stringify(version)}]; next();
  };`;
  const route = `${handler} exports.POST = exports.GET;`;
  const f = await fixture(t, { "middleware.js": guard("old"), "a/route.js": route, "b/route.js": route });
  const request = await f.serve(await f.mount({ watch: true }));
  for (const source of ["exports.middleware = [];", 'throw new Error("middleware reload failed");']) {
    await update(f.logs, () => f.write("middleware.js", source), "Error reloading ");
    for (const url of ["/a", "/b"]) {
      for (const method of ["GET", "POST"]) {
        assert.equal((await request(url, { method })).status, 401);
        await expectSteps(request, url, ["old"], { method, headers: { authorization: "allowed" } });
      }
    }
  }
  assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 1);
  await update(f.logs, () => f.write("new/route.js", route));
  assert.equal((await request("/new")).status, 401);
  await expectSteps(request, "/new", ["old"], { headers: { authorization: "allowed" } });
  await update(f.logs, () => f.write("middleware.js", guard("recovered")));
  for (const url of ["/a", "/b", "/new"]) {
    assert.equal((await request(url)).status, 401);
    await expectSteps(request, url, ["recovered"], { headers: { authorization: "allowed" } });
  }
});

test("conflicting middleware extensions identify both files and recover after removal", { timeout: 10000 }, async t => {
  const f = await fixture(t, { "middleware.js": middleware("old"), "middleware.ts": middleware("conflict"), "route.js": handler });
  const identifiesBothFiles = error => {
    const message = typeof error === "string" ? error : error.message;
    assert.ok(message.includes(path.join(f.apiDir, "middleware.js")), message);
    assert.ok(message.includes(path.join(f.apiDir, "middleware.ts")), message);
    return true;
  };
  await assert.rejects(f.mount(), identifiesBothFiles);
  await f.remove("middleware.ts");
  const request = await f.serve(await f.mount({ watch: true }));
  await update(f.logs, () => f.write("middleware.ts", middleware("conflict")), "Error reloading ");
  identifiesBothFiles(f.logs.at(-1));
  await expectSteps(request, "/", ["old"]);
  await update(f.logs, () => f.remove("middleware.ts"));
  await expectSteps(request, "/", ["old"]);
  await update(f.logs, () => f.write("middleware.js", middleware("recovered")));
  await expectSteps(request, "/", ["recovered"]);
});

test("a request paused inside directory middleware keeps its old chain across reloads", { timeout: 10000 }, async t => {
  const f = await fixture(t, {
    "state.js": "module.exports = {};",
    "middleware.js": `const state = require('./state.js'); exports.middleware = (req, _res, next) => {
      req.steps = ['root'];
      if (req.get('x-pause') !== 'yes') return next();
      state.resume = next; state.paused();
    };`,
    "child/middleware.js": middleware("old child"), "child/route.js": handler,
  });
  const state = require(path.join(f.apiDir, "state.js"));
  const paused = new Promise(resolve => { state.paused = resolve; });
  t.after(() => state.resume?.());
  const request = await f.serve(await f.mount({ watch: true }));
  const pending = request("/child", { headers: { "x-pause": "yes" } });
  pending.catch(() => {});
  await paused;
  await update(f.logs, () => f.write("child/middleware.js", middleware("new child")));
  await expectSteps(request, "/child", ["root", "new child"]);
  state.resume();
  delete state.resume;
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ["root", "old child"]);
});

test("next('router') in directory middleware exits its caller's router before and after reload", { timeout: 8000 }, async t => {
  const f = await fixture(t, { "middleware.js": "exports.middleware = (_req, _res, next) => next('router');", "route.js": handler });
  const parent = express.Router();
  f.disposers.push(await mountDirectoryRoutes(parent, { apiDir: f.apiDir, watch: true, logger: message => f.logs.push(message) }));
  parent.get("/", (_req, res) => res.send("inside"));
  const app = express();
  app.use(parent);
  app.use((_req, res) => res.status(401).send("outside"));
  const request = await f.serve(app);
  for (const reload of [false, true]) {
    if (reload) await update(f.logs, () => f.write("middleware.js", "exports.middleware = async (_req, _res, next) => next('router');"));
    const response = await request("/");
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "outside");
  }
});

test("close stops middleware reloads while leaving its mounted chain available", { timeout: 8000 }, async t => {
  const f = await fixture(t, { "middleware.js": middleware("frozen"), "route.js": handler });
  const frozen = await f.mount({ watch: true });
  await frozen.close();
  const initialLogs = f.logs.length;
  const liveLogs = [];
  const live = await f.mount({ watch: true, logger: message => liveLogs.push(message) });
  const app = express();
  app.use("/frozen", frozen);
  app.use("/live", live);
  const request = await f.serve(app);
  await update(liveLogs, () => f.write("middleware.js", middleware("changed")));
  await expectSteps(request, "/live", ["changed"]);
  await expectSteps(request, "/frozen", ["frozen"]);
  assert.equal(f.logs.length, initialLogs);
});
