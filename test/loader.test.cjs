const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const express = require("express");
const { createNextishRouter, mountDirectoryRoutes } = require("../dist/src");

const handler = (body, method = "GET") => `exports.${method} = (_req, res) => res.send(${JSON.stringify(body)});`;

async function fixture(t, files = {}, name = "api") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-loader-"));
  const realDirectory = await fs.realpath(directory);
  const apiDir = path.join(directory, name);
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
  await fs.mkdir(apiDir, { recursive: true });

  const write = async (relative, source) => {
    const file = path.join(apiDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), ".nextish-route.tmp");
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
    async serve(appOrRouter) {
      const app = express();
      app.use(appOrRouter);
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

async function expectText(request, url, body, method = "GET") {
  const response = await request(url, { method });
  assert.equal(response.status, 200, `${method} ${url}`);
  assert.equal(await response.text(), body, `${method} ${url}`);
}

test("default discovery loads exact route filenames, excludes hidden paths and symlinks, and logs once", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "route.js": handler("root"),
    "ts/route.ts": handler("ts"),
    "tsx/route.tsx": handler("tsx"),
    "jsx/route.jsx": handler("jsx"),
    "cjs/route.cjs": handler("cjs"),
    "mjs/route.mjs": 'export const GET = (_req, res) => res.send("mjs");',
    ".hidden/route.js": 'throw new Error("hidden route loaded");',
    "extra/route.js.map": 'throw new Error("map loaded");',
    "extra/route.mts": 'throw new Error("unconfigured extension loaded");',
    "extra/helper.js": 'throw new Error("helper loaded");',
    "../foreign/route.js": 'throw new Error("symlink target loaded");',
  });
  await fs.symlink(path.join(f.apiDir, "../foreign"), path.join(f.apiDir, "linked"), "dir");
  await fs.mkdir(path.join(f.apiDir, "file-link"));
  await fs.symlink(path.join(f.apiDir, "../foreign/route.js"), path.join(f.apiDir, "file-link/route.js"));
  const request = await f.serve(await f.mount());
  for (const [url, body] of [["/", "root"], ["/ts", "ts"], ["/tsx", "tsx"], ["/jsx", "jsx"], ["/cjs", "cjs"], ["/mjs", "mjs"]]) {
    await expectText(request, url, body);
  }
  for (const url of ["/.hidden", "/extra", "/linked", "/file-link"]) {
    assert.equal((await request(url)).status, 404);
  }
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /^Loaded routes:\n/);
  assert.equal(f.logs[0].split("\n").length, 7);
});

for (const extension of [".js", "js"]) {
  test(`one configured extension ${extension} loads routes`, { timeout: 5000 }, async t => {
    const f = await fixture(t, {
      "route.js": handler("single extension"),
      "ignored/route.ts": 'throw new Error("wrong extension loaded");',
    });
    const request = await f.serve(await f.mount({ extensions: [extension] }));
    await expectText(request, "/", "single extension");
    assert.equal((await request("/ignored")).status, 404);
  });
}

for (const [name, sibling] of [["api[ab]", "apia"], ["api{one,two}", "apione"]]) {
  test(`discovery and watching treat ${name} literally`, { timeout: 8000 }, async t => {
    const f = await fixture(t, {
      "route.js": handler("literal"),
      [`../${sibling}/route.js`]: 'throw new Error("sibling loaded");',
    }, name);
    const router = await f.mount({ watch: true, extensions: [".js"] });
    await update(f.logs, () => f.write("route.js", handler("immediate change")));
    const request = await f.serve(router);
    await expectText(request, "/", "immediate change");
    await update(f.logs, () => f.write("new/route.js", handler("added")));
    await expectText(request, "/new", "added");
    assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 3);
  });
}

test("watching ignores unrelated extensions, hidden paths and symlinks added after readiness", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "route.js": handler("root"),
    "../foreign/route.js": 'throw new Error("symlink target loaded");',
  });
  const request = await f.serve(await f.mount({ watch: true, extensions: [".js"] }));
  await f.write("ignored/route.ts", 'throw new Error("unconfigured extension loaded");');
  await f.write(".hidden/route.js", 'throw new Error("hidden route loaded");');
  await f.write("helper.js", 'throw new Error("helper loaded");');
  await fs.symlink(path.join(f.apiDir, "../foreign"), path.join(f.apiDir, "linked"), "dir");
  await fs.mkdir(path.join(f.apiDir, "file-link"));
  await fs.symlink(path.join(f.apiDir, "../foreign/route.js"), path.join(f.apiDir, "file-link/route.js"));
  await update(f.logs, () => f.write("route.js", handler("barrier")));
  await expectText(request, "/", "barrier");
  for (const url of ["/ignored", "/.hidden", "/linked", "/file-link"]) {
    assert.equal((await request(url)).status, 404);
  }
  assert.equal(f.logs.length, 2);
});

test("a missing API directory can be created after watching is ready", { timeout: 8000 }, async t => {
  // Missing-directory discovery should not depend on native event delivery under load.
  const chokidar = require("chokidar").default;
  const watch = chokidar.watch;
  t.mock.method(chokidar, "watch", (directory, options) => watch(directory, { ...options, usePolling: true }));
  const f = await fixture(t);
  await f.remove(".");
  const request = await f.serve(await f.mount({ watch: true }));
  assert.equal((await request("/")).status, 404);
  await update(f.logs, () => f.write("route.js", handler("created later")));
  await expectText(request, "/", "created later");
});

test("default and handler exports accept functions and arrays for every HTTP method", { timeout: 5000 }, async t => {
  const f = await fixture(t, {
    "route.js": 'exports.default = (req, res) => res.send(req.method);',
    "array/route.js": `
      exports.middleware = [async (req, _res, next) => { req.prefix = 'array '; next(); }];
      exports.handler = [(_req, _res, next) => next(), (req, res) => res.send(req.prefix + req.method)];
    `,
  });
  const request = await f.serve(await f.mount());
  await expectText(request, "/", "PATCH", "PATCH");
  await expectText(request, "/array", "array DELETE", "DELETE");
});

test("explicit HEAD wins over GET, including lowercase exports, and GET still supplies implicit HEAD", { timeout: 5000 }, async t => {
  const source = `
    exports.GET = (_req, res) => res.set('x-handler', 'get').send('get body');
    exports.HEAD = (_req, res) => res.set('x-handler', 'head').status(204).end();
  `;
  const f = await fixture(t, {
    "route.js": source,
    "lower/route.js": source.replaceAll("exports.GET", "exports.get").replaceAll("exports.HEAD", "exports.head"),
    "implicit/route.js": "exports.GET = (_req, res) => res.set('x-handler', 'implicit').send('body');",
  });
  const request = await f.serve(await f.mount());
  for (const url of ["/", "/lower"]) {
    const head = await request(url, { method: "HEAD" });
    assert.equal(head.status, 204);
    assert.equal(head.headers.get("x-handler"), "head");
    assert.equal(await head.text(), "");
    await expectText(request, url, "get body");
  }
  const implicit = await request("/implicit", { method: "HEAD" });
  assert.equal(implicit.status, 200);
  assert.equal(implicit.headers.get("x-handler"), "implicit");
  assert.equal(await implicit.text(), "");
});

test("async params, query and body validators are awaited, stop on failure, and catch rejection", { timeout: 8000 }, async t => {
  const f = await fixture(t, {
    "[id]/route.js": `
      exports.middleware = (req, _res, next) => { req.steps = ['middleware']; next(); };
      exports.validate = Object.fromEntries(['params', 'query', 'body'].map(name => [name, async req => {
        await Promise.resolve();
        req.steps.push(name);
        if (req.query.fail !== name) return;
        if (req.query.throw === 'yes') throw new Error('bad ' + name);
        if (req.query.custom === 'yes') return { ok: false, status: 422, body: { failed: name } };
        return { ok: false };
      }]));
      exports.POST = [
        (req, _res, next) => { req.steps.push('handler'); next(); },
        (req, res) => res.json({ steps: req.steps, id: req.params.id, body: req.body }),
      ];
    `,
  });
  const request = await f.serve(await f.mount());
  for (const name of ["params", "query", "body"]) {
    for (const [suffix, status, body] of [
      ["", 400, { error: `Invalid ${name}` }],
      ["&custom=yes", 422, { failed: name }],
      ["&throw=yes", 400, { error: `bad ${name}` }],
    ]) {
      const response = await request(`/value?fail=${name}${suffix}`, { method: "POST" });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), body);
    }
  }
  const response = await request("/value", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    steps: ["middleware", "params", "query", "body", "handler"],
    id: "value",
    body: { input: true },
  });
});

test("initial require and invalid export failures reject without partially mounting an application", { timeout: 10000 }, async t => {
  for (const [name, source] of [
    ["require error", 'throw new Error("initial boom");'],
    ["syntax error", "exports.GET = ("],
    ["later invalid method", `${handler("partial")} exports.POST = {};`],
    ["empty handler array", "exports.GET = [];"],
    ["null handler", "exports.GET = null;"],
    ["invalid default", "exports.default = {};"],
    ["invalid middleware", `${handler("partial")} exports.middleware = [false];`],
    ["invalid validator", `${handler("partial")} exports.validate = { body: 123 };`],
    ["no handler", "exports.config = {};"],
    ["null module", "module.exports = null;"],
  ]) {
    await t.test(name, async subtest => {
      const f = await fixture(subtest, { "route.js": source, "first/route.js": handler("also partial") });
      await assert.rejects(f.mount());
      const app = express();
      app.get("/unrelated", (_req, res) => res.send("unrelated"));
      const before = app._router.stack.slice();
      await assert.rejects(mountDirectoryRoutes(app, { apiDir: f.apiDir, logger: message => f.logs.push(message) }));
      assert.deepEqual(app._router.stack, before);
      const request = await f.serve(app);
      await expectText(request, "/unrelated", "unrelated");
      assert.equal((await request("/")).status, 404);
      assert.equal((await request("/first")).status, 404);
      assert.equal(f.logs.length, 0);
    });
  }
});

test("an initialization failure closes its started watcher so the process exits naturally", { timeout: 8000 }, async t => {
  const f = await fixture(t, { "route.js": 'throw new Error("initial boom");' });
  await promisify(execFile)(process.execPath, ["-e", `
    require(process.argv[1]).createNextishRouter({ apiDir: process.argv[2], watch: true, logger: () => {} }).then(
      () => { process.exitCode = 1; },
      error => { if (!error.message.includes('initial boom')) process.exitCode = 1; },
    );
  `, path.resolve(__dirname, "../dist/src"), f.apiDir], { timeout: 5000 });
});

for (const [failure, source] of [
  ["require error", 'throw new Error("reload boom");'],
  ["invalid later method", `${handler("must not replace GET")} exports.POST = {};`],
]) {
  test(`a ${failure} on reload preserves all old handlers and a later valid reload works`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { "route.js": `${handler("old get")} ${handler("old post", "POST")}` });
    const request = await f.serve(await f.mount({ watch: true }));
    await update(f.logs, () => f.write("route.js", source), "Error reloading ");
    await expectText(request, "/", "old get");
    await expectText(request, "/", "old post", "POST");
    assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 1);
    await update(f.logs, () => f.write("route.js", `${handler("new get")} ${handler("new post", "POST")}`));
    await expectText(request, "/", "new get");
    await expectText(request, "/", "new post", "POST");
  });
}

test("a publication error leaves routes unchanged, including on the next unrelated reload", { timeout: 10000 }, async t => {
  const f = await fixture(t, { "route.js": handler("old") });
  const app = express();
  let failPublish = true;
  const options = { apiDir: f.apiDir, watch: true, logger: message => {
    if (failPublish && message.startsWith("Loaded routes:")) {
      failPublish = false;
      throw new Error("publication failed");
    }
    f.logs.push(message);
  } };
  await assert.rejects(mountDirectoryRoutes(app, options), /publication failed/);
  assert.equal(app._router, undefined);
  f.disposers.push(await mountDirectoryRoutes(app, options));
  const request = await f.serve(app);
  failPublish = true;
  await update(f.logs, () => f.write("route.js", handler("rejected")), "Error reloading ");
  await expectText(request, "/", "old");
  await update(f.logs, () => f.write("other/route.js", handler("other")));
  await expectText(request, "/other", "other");
  await expectText(request, "/", "old");
  await update(f.logs, () => f.write("route.js", handler("recovered")));
  await expectText(request, "/", "recovered");
});

test("route specificity survives initialization, edits, additions and deletions", { timeout: 15000 }, async t => {
  const f = await fixture(t, {
    "[[...optional]]/route.js": handler("optional"),
    "[...rest]/route.js": handler("catch-all"),
    "[id]/route.js": handler("dynamic"),
    "fixed/route.js": handler("static"),
    "[z]/fixed/route.js": handler("deep static"),
    "[a]/[other]/route.js": handler("deep dynamic"),
  });
  const request = await f.serve(await f.mount({ watch: true }));
  for (const [url, body] of [
    ["/", "optional"], ["/fixed", "static"], ["/value", "dynamic"],
    ["/value/fixed", "deep static"], ["/value/other", "deep dynamic"], ["/one/two/three", "catch-all"],
  ]) await expectText(request, url, body);

  await update(f.logs, () => f.write("[id]/route.js", handler("dynamic changed")));
  await expectText(request, "/fixed", "static");
  await expectText(request, "/value", "dynamic changed");
  await update(f.logs, () => f.write("fixed/route.js", handler("static changed")));
  await expectText(request, "/fixed", "static changed");
  await update(f.logs, () => f.write("added/route.js", handler("added")));
  await expectText(request, "/added", "added");
  await update(f.logs, () => f.remove("fixed/route.js"));
  await expectText(request, "/fixed", "dynamic changed");
  await update(f.logs, () => f.remove("[id]/route.js"));
  await expectText(request, "/fixed", "catch-all");
  await update(f.logs, () => f.remove("[...rest]/route.js"));
  await expectText(request, "/fixed", "optional");
  await update(f.logs, () => f.remove("added"));
  await expectText(request, "/added", "optional");
  assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 8);
});

for (const kind of ["application", "router"]) {
  test(`mounting on an Express ${kind} preserves explicit and automatic OPTIONS dispatch`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { "route.js": handler("get"), "automatic/route.js": handler("get") });
    const parent = kind === "application" ? express() : express.Router();
    parent.post("/automatic", (_req, res) => res.send("post"));
    f.disposers.push(await mountDirectoryRoutes(parent, { apiDir: f.apiDir, logger: message => f.logs.push(message) }));
    parent.options("/", (_req, res) => res.set("access-control-allow-origin", "https://example.com").status(204).end());
    parent.put("/automatic", (_req, res) => res.send("put"));
    const request = await f.serve(parent);
    const response = await request("/", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
    const automatic = await request("/automatic", { method: "OPTIONS" });
    assert.equal(automatic.status, 200);
    assert.deepEqual(new Set(automatic.headers.get("allow").split(",")), new Set(["POST", "GET", "HEAD", "PUT"]));
  });

  test(`next('router') in a mounted route exits the caller's Express ${kind}`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { "route.js": "exports.GET = (_req, _res, next) => next('router');" });
    const parent = kind === "application" ? express() : express.Router();
    f.disposers.push(await mountDirectoryRoutes(parent, { apiDir: f.apiDir, logger: message => f.logs.push(message) }));
    parent.get("/", (_req, res) => res.send("inside"));
    const outer = express();
    outer.use(parent);
    outer.use((_req, res) => res.status(401).send("outside"));
    const request = await f.serve(outer);
    const response = await request("/");
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "outside");
  });

  test(`mounted routes share the Express ${kind} param callback cache with earlier routes`, { timeout: 5000 }, async t => {
    const f = await fixture(t, {
      "[id]/route.js": "exports.GET = (req, res) => res.json({ calls: req.paramCalls, id: req.params.id });",
    });
    const parent = kind === "application" ? express() : express.Router();
    parent.use((req, _res, next) => { req.paramCalls = 0; next(); });
    parent.param("id", (req, _res, next, id) => { req.paramCalls++; req.params.id = id.toUpperCase(); next(); });
    parent.get("/:id", (_req, _res, next) => next());
    f.disposers.push(await mountDirectoryRoutes(parent, { apiDir: f.apiDir, logger: message => f.logs.push(message) }));
    const request = await f.serve(parent);
    const response = await request("/value");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { calls: 1, id: "VALUE" });
  });

  test(`mounting on an Express ${kind} preserves middleware, params, matching settings and unrelated routes`, { timeout: 10000 }, async t => {
    const source = version => `exports.GET = (req, res) => res.json({
      version: ${version}, steps: req.steps, id: req.params.id, tenant: req.params.tenant, baseUrl: req.baseUrl,
    });`;
    const f = await fixture(t, {
      "item/[id]/route.js": source(1),
      "after/route.js": "exports.GET = (_req, _res, next) => next();",
    });
    const app = express();
    const parent = kind === "application" ? app : express.Router({ mergeParams: true, caseSensitive: true, strict: true });
    if (kind === "application") {
      app.enable("case sensitive routing");
      app.enable("strict routing");
    } else {
      app.use("/tenants/:tenant", parent);
    }
    parent.use((req, _res, next) => { req.steps = ["middleware"]; next(); });
    parent.param("id", (req, _res, next) => { req.steps.push("first param"); next(); });
    parent.get("/unrelated", (_req, res) => res.send("unrelated"));
    const dispose = await mountDirectoryRoutes(parent, { apiDir: f.apiDir, watch: true, logger: message => f.logs.push(message) });
    f.disposers.push(dispose);
    parent.param("id", (req, _res, next, id) => { req.steps.push("later param"); req.params.id = id.toUpperCase(); next(); });
    parent.get("/after", (_req, res) => res.send("after"));
    const request = await f.serve(app);
    const base = kind === "application" ? "" : "/tenants/acme";
    const expected = {
      version: 1, steps: ["middleware", "first param", "later param"], id: "ABC", baseUrl: base,
      ...(kind === "router" ? { tenant: "acme" } : {}),
    };
    assert.deepEqual(await (await request(`${base}/item/abc`)).json(), expected);
    assert.equal((await request(`${base}/Item/abc`)).status, 404);
    assert.equal((await request(`${base}/item/abc/`)).status, 404);
    await update(f.logs, () => f.write("item/[id]/route.js", source(2)));
    assert.deepEqual(await (await request(`${base}/item/abc`)).json(), { ...expected, version: 2 });
    await update(f.logs, () => f.remove("item/[id]/route.js"));
    assert.equal((await request(`${base}/item/abc`)).status, 404);
    await expectText(request, `${base}/unrelated`, "unrelated");
    await expectText(request, `${base}/after`, "after");
  });

  test(`empty mounts retain their Express ${kind} positions through independent reloads and removal of all routes`, { timeout: 15000 }, async t => {
    // Polling keeps mount-order assertions independent of native startup event loss.
    const chokidar = require("chokidar").default;
    const watch = chokidar.watch;
    t.mock.method(chokidar, "watch", (directory, options) => watch(directory, { ...options, usePolling: true }));
    const first = await fixture(t);
    const second = await fixture(t);
    const source = name => `exports.GET = (req, res) => res.json({ name: ${JSON.stringify(name)}, steps: req.steps });`;
    const parent = kind === "application" ? express() : express.Router();
    parent.use((req, _res, next) => { req.steps = ["before"]; next(); });
    first.disposers.push(await mountDirectoryRoutes(parent, { apiDir: first.apiDir, watch: true, logger: message => first.logs.push(message) }));
    parent.use((req, _res, next) => { req.steps.push("between"); next(); });
    second.disposers.push(await mountDirectoryRoutes(parent, { apiDir: second.apiDir, watch: true, logger: message => second.logs.push(message) }));
    parent.use((req, res) => res.json({ name: "after", steps: req.steps }));
    const request = await first.serve(parent);
    const expectRoute = async (name, steps) => {
      const response = await request("/shared");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { name, steps });
    };
    await expectRoute("after", ["before", "between"]);
    await update(second.logs, () => second.write("shared/route.js", source("second")));
    await expectRoute("second", ["before", "between"]);
    await update(first.logs, () => first.write("extra/route.js", handler("extra")));
    await update(second.logs, () => second.write("shared/route.js", source("second changed")));
    await expectRoute("second changed", ["before", "between"]);
    await update(first.logs, () => first.write("shared/route.js", source("first")));
    await expectRoute("first", ["before"]);
    await update(first.logs, () => first.remove("extra/route.js"));
    await update(first.logs, () => first.remove("shared/route.js"));
    await expectRoute("second changed", ["before", "between"]);
    await update(first.logs, () => first.write("shared/route.js", source("first restored")));
    await expectRoute("first restored", ["before"]);
  });

  test(`reloading an Express ${kind} leaves paused requests on their captured stack`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { "route.js": handler("old") });
    const parent = kind === "application" ? express() : express.Router();
    let resume;
    const paused = new Promise(resolve => {
      parent.use((req, _res, next) => {
        if (req.get("x-pause") !== "yes") return next();
        resume = next;
        resolve();
      });
    });
    t.after(() => resume?.());
    f.disposers.push(await mountDirectoryRoutes(parent, { apiDir: f.apiDir, watch: true, logger: message => f.logs.push(message) }));
    const request = await f.serve(parent);
    const pending = request("/", { headers: { "x-pause": "yes" } });
    await paused;
    await update(f.logs, () => f.write("route.js", handler("new")));
    await expectText(request, "/", "new");
    resume();
    resume = undefined;
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "old");
  });
}

test("close is idempotent, stops reloading, and preserves the mounted handlers and HTTP server", { timeout: 10000 }, async t => {
  const f = await fixture(t, { "route.js": handler("frozen") });
  const frozen = await f.mount({ watch: true });
  const closing = frozen.close();
  assert.equal(frozen.close(), closing);
  await closing;
  const initialLogs = f.logs.length;
  const controlLogs = [];
  const live = await f.mount({ watch: true, logger: message => controlLogs.push(message) });
  const app = express();
  app.use("/frozen", frozen);
  app.use("/live", live);
  const request = await f.serve(app);
  await update(controlLogs, () => f.write("route.js", handler("changed")));
  await expectText(request, "/live", "changed");
  await expectText(request, "/frozen", "frozen");
  assert.equal(f.logs.length, initialLogs);
  await frozen.close();
});

test("watcher errors reject initialization and are logged after readiness without removing routes", { timeout: 10000 }, async t => {
  const chokidar = require("chokidar").default;
  const watch = chokidar.watch;
  let watcher;
  let failInitialization = true;
  t.mock.method(chokidar, "watch", (...args) => {
    watcher = watch(...args);
    if (failInitialization) process.nextTick(() => watcher.emit("error", new Error("watch init failed")));
    return watcher;
  });
  const f = await fixture(t, { "route.js": handler("working") });
  await assert.rejects(f.mount({ watch: true }), /watch init failed/);
  assert.equal(watcher.closed, true);
  failInitialization = false;
  const request = await f.serve(await f.mount({ watch: true }));
  watcher.emit("error", new Error("watch runtime failed"));
  assert.ok(f.logs.some(message => message.startsWith("Error watching ") && message.includes("watch runtime failed")));
  await expectText(request, "/", "working");
  await update(f.logs, () => f.write("route.js", handler("recovered")));
  await expectText(request, "/", "recovered");
});
