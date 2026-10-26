const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const chokidar = require("chokidar").default;
const express = require("express");
const express5 = require("express5");
const { createNextishRouter, mountDirectoryRoutes, generateOpenAPI } = require("../dist/src");
const { dirPathToRoute } = require("../dist/src/transform");

const handler = value => `exports.GET = (_req, res) => res.send(${JSON.stringify(value)});`;
const documented = value => `${handler(value)} exports.docs = { summary: ${JSON.stringify(value)} };`;

async function fixture(t, files) {
  const apiDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nextish-loader-fixes-")));
  const logs = [];
  const disposers = [];
  const servers = [];
  const watch = chokidar.watch;
  // These tests concern reload transactions, not native watcher delivery.
  t.mock.method(chokidar, "watch", (files, options) => watch(files, { ...options, usePolling: true }));
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const file of Object.keys(require.cache)) if (file.startsWith(apiDir + path.sep)) delete require.cache[file];
    await fs.rm(apiDir, { recursive: true, force: true });
  });
  const write = async (relative, source) => {
    const file = path.join(apiDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), ".nextish-update.tmp");
    await fs.writeFile(temporary, source);
    await fs.rename(temporary, file);
  };
  for (const [file, source] of Object.entries(files)) await write(file, source);
  return {
    apiDir, logs, write,
    async mount(parent, options = {}) {
      const settings = { apiDir, logger: message => logs.push(message), ...options };
      const mounted = parent ? await mountDirectoryRoutes(parent, settings) : await createNextishRouter(settings);
      disposers.push(parent ? mounted : mounted.close);
      return mounted;
    },
    async update(change, prefix = "Loaded routes:\n") {
      const before = logs.length;
      await change();
      const deadline = Date.now() + 5000;
      while (!logs.slice(before).some(message => message.startsWith(prefix))) {
        assert.ok(Date.now() < deadline, `Missing ${prefix}: ${logs.slice(before).join("\n")}`);
        await delay(10);
      }
    },
    async serve(parent, factory = express) {
      const app = parent.listen ? parent : factory().use(parent);
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return (url, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        ...options, signal: AbortSignal.timeout(5000),
      });
    },
  };
}

for (const [version, factory] of [[4, express], [5, express5]]) {
  test(`Express ${version} normalizes route prefixes before publishing`, async t => {
    const f = await fixture(t, { "route.cjs": handler("root"), "a/route.cjs": handler("a") });
    for (const routePrefix of ["v1", "/v1", "/v1/", "", "/"]) {
      const app = factory();
      const mounted = await f.mount(app, { routePrefix });
      const base = routePrefix && routePrefix !== "/" ? "/v1" : "";
      assert.deepEqual(mounted.getRoutes().map(route => route.path), [`${base}/`, `${base}/a`]);
      const request = await f.serve(app, factory);
      for (const [url, expected] of [[`${base}/`, "root"], [`${base}/a`, "a"]]) {
        const response = await request(url);
        assert.equal(response.status, 200, `${routePrefix}: ${url}`);
        assert.equal(await response.text(), expected);
      }
      if (base) assert.equal((await request("/a")).status, 404);
    }
  });
}

for (const kind of ["application", "router"]) {
  test(`an Express 5 ${kind} uses its own layers when this package resolves Express 4`, async t => {
    assert.match(require("express/package.json").version, /^4\./);
    const f = await fixture(t, {
      "item/[id]/route.cjs": "exports.GET = (req, res) => res.json({ id: req.params.id, calls: req.calls });",
      "files/[...rest]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
      "docs/[[...rest]]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
    });
    const parent = kind === "application" ? express5() : express5.Router({ caseSensitive: true, strict: true });
    if (kind === "application") {
      parent.enable("case sensitive routing");
      parent.enable("strict routing");
    }
    parent.use((req, _res, next) => { req.calls = 0; next(); });
    parent.param("id", (req, _res, next, id) => { req.calls++; req.params.id = id.toUpperCase(); next(); });
    const mounted = await f.mount(parent, { routePrefix: "v1" });
    assert.ok(mounted.getRoutes().some(route => route.path === "/v1/files/*rest"));
    assert.ok(mounted.getRoutes().some(route => route.path === "/v1/docs{/*rest}"));
    parent.post("/v1/item/:id", (_req, res) => res.send("caller"));
    const request = await f.serve(parent, express5);
    for (const [url, expected] of [
      ["/v1/item/abc", { id: "ABC", calls: 1 }],
      ["/v1/files/one/two", { rest: ["one", "two"] }],
      ["/v1/docs", {}],
      ["/v1/docs/one/two", { rest: ["one", "two"] }],
    ]) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.deepEqual(await response.json(), expected);
    }
    assert.equal((await request("/v1/item/abc/")).status, 404);
    assert.equal((await request("/v1/ITEM/abc")).status, 404);
    const options = await request("/v1/item/abc", { method: "OPTIONS" });
    assert.equal(options.status, 200);
    assert.deepEqual(new Set(options.headers.get("allow").split(/,\s*/)), new Set(["GET", "HEAD", "POST"]));
  });
}

test("a throwing logger cannot abort startup or reload publication", { timeout: 10000 }, async t => {
  const f = await fixture(t, { "route.cjs": documented("old") });
  const mounted = await f.mount(express(), { watch: true, logger: message => {
    f.logs.push(message);
    throw new Error("logger failed");
  } });
  assert.equal(mounted.getRoutes()[0].docs.summary, "old");
  await f.update(() => f.write("route.cjs", documented("new")));
  assert.equal(mounted.getRoutes()[0].docs.summary, "new");
  assert.equal(f.logs.some(message => message.startsWith("Error reloading ")), false);
});

for (const field of ["shared", "method"]) {
  test(`uncloneable ${field} docs identify their route file before publication`, async t => {
    for (const docs of [
      "{ summary: () => 'invalid' }",
      "{ schemas: { body: new class { validate = () => true; }() } }",
    ]) {
      const source = field === "shared" ? `${handler("invalid")} exports.docs = ${docs};`
        : `exports.GET = { handler: (_req, res) => res.end(), docs: ${docs} };`;
      const f = await fixture(t, { "broken/route.cjs": source });
      const app = express();
      app.get("/caller", (_req, res) => res.end());
      const previous = app._router.stack.slice();
      await assert.rejects(f.mount(app), error => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /Invalid docs.*clone/i);
        assert.ok(error.message.includes(path.join(f.apiDir, "broken/route.cjs")), error.message);
        return true;
      });
      assert.deepEqual(app._router.stack, previous);
      assert.deepEqual(f.logs, []);
    }
  });
}

test("uncloneable docs preserve the last published routes and recover on reload", { timeout: 10000 }, async t => {
  const f = await fixture(t, { "route.cjs": documented("old") });
  const mounted = await f.mount(undefined, { watch: true });
  const previous = mounted.getRoutes();
  await f.update(() => f.write("route.cjs", `${handler("invalid")} exports.docs = { summary: () => 'invalid' };`), "Error reloading ");
  assert.deepEqual(mounted.getRoutes(), previous);
  assert.ok(f.logs.some(message => /Invalid docs.*clone/i.test(message) && message.includes(path.join(f.apiDir, "route.cjs"))));
  await f.update(() => f.write("other/route.cjs", handler("other")));
  assert.equal(mounted.getRoutes()[0].docs.summary, "old");
  await f.update(() => f.write("route.cjs", documented("recovered")));
  assert.equal(mounted.getRoutes()[0].docs.summary, "recovered");
});

test("Express 5 quotes non-identifier parameter names in routes and OpenAPI", async t => {
  const f = await fixture(t, {
    "users/[user-id]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
    "files/[...file-path]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
    "docs/[[...doc-path]]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
    "names/[given name]/route.cjs": "exports.GET = (req, res) => res.json(req.params);",
    'quoted/[say"hi]/route.cjs': "exports.GET = (req, res) => res.json(req.params);",
  });
  const app = express5();
  const mounted = await f.mount(app, { routePrefix: "v1" });
  const document = generateOpenAPI(mounted.getRoutes(), { title: "Quoted names", version: "1" });
  for (const route of ["/v1/users/{user-id}", "/v1/files/{file-path}", "/v1/docs", "/v1/docs/{doc-path}", "/v1/names/{given name}", '/v1/quoted/{say"hi}']) {
    assert.ok(document.paths[route], route);
  }
  const request = await f.serve(app, express5);
  for (const [url, expected] of [
    ["/v1/users/42", { "user-id": "42" }],
    ["/v1/files/a/b", { "file-path": ["a", "b"] }],
    ["/v1/docs", {}],
    ["/v1/docs/a/b", { "doc-path": ["a", "b"] }],
    ["/v1/names/Ada", { "given name": "Ada" }],
    ["/v1/quoted/hello", { 'say"hi': "hello" }],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.deepEqual(await response.json(), expected);
  }
});

test("Express 4 explains unsupported parameter names while Express 5 quotes them", () => {
  const apiDir = path.resolve("api");
  for (const [directory, expected] of [
    ["[user-id]", '/:"user-id"'],
    ["[...file-path]", '/*"file-path"'],
    ["[[...doc-path]]", '/{*"doc-path"}'],
    ["[given name]", '/:"given name"'],
    ["[café]", '/:"café"'],
    ['[say"hi]', '/:"say\\"hi"'],
  ]) {
    const file = path.join(apiDir, directory, "route.cjs");
    assert.throws(() => dirPathToRoute(apiDir, file), /Invalid route parameter.*Express 4/);
    assert.equal(dirPathToRoute(apiDir, file, true).route, expected);
  }
  for (const directory of ["[]", "[...]", "[[...]]", "[id", "[bad{name]"]) {
    assert.throws(() => dirPathToRoute(apiDir, path.join(apiDir, directory, "route.cjs"), true), /Invalid route parameter/);
  }
});

test("Express 5 detects conflicting quoted parameter names using the caller's matcher", async t => {
  const f = await fixture(t, {
    "[user-id]/route.cjs": 'throw new Error("must not load conflicting modules");',
    "[user_name]/route.cjs": 'throw new Error("must not load conflicting modules");',
  });
  await assert.rejects(f.mount(express5()), error => {
    assert.match(error.message, /^Route conflict:/);
    for (const directory of ["[user-id]", "[user_name]"]) assert.ok(error.message.includes(path.join(f.apiDir, directory, "route.cjs")));
    return true;
  });
});

test("Express 4 static pattern characters match literally without false conflicts", async t => {
  const names = ["a+b", "ab", "a*b", "a(b)", "a:b", "a$b", "a^b", "a|b", "a.b", "axb", ":upper(ABC)", ":lower(abc)"];
  const f = await fixture(t, Object.fromEntries(names.map(name => [`${name}/route.cjs`, handler(name)])));
  const router = await f.mount();
  const request = await f.serve(router);
  for (const name of names) {
    const response = await request(`/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), name);
  }
  for (const url of ["/aaab", "/aXYZb", "/abc", "/ABC", "/a", "/b", "/a/b"]) {
    assert.equal((await request(url)).status, 404, url);
  }
});

test("Express 4 rejects question marks in static folders with a clear diagnostic", async t => {
  const f = await fixture(t, { "a?b/route.cjs": handler("ambiguous") });
  await assert.rejects(f.mount(), /Express 4.*\?.*query/i);
});
