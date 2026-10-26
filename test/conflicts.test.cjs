const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const chokidar = require("chokidar").default;
const express = require("express");
const { createNextishRouter, mountDirectoryRoutes } = require("../dist/src");
const { assertNoRouteConflicts } = require("../dist/src/conflicts");
const { dirPathToRoute } = require("../dist/src/transform");

const handler = (body, method = "GET") => `exports.${method} = (_req, res) => res.send(${JSON.stringify(body)});`;
const entries = routes => routes.map((route, index) => ({ file: `/api/${index}/route.js`, route }));

test("conflicts identify both files and routes while ignoring parameter names", () => {
  for (const routes of [
    ["/users/:id", "/users/:slug"],
    ["/files/:path(.+)", "/files/:rest(.+)"],
    ["/docs/:path(*)?", "/docs/:rest(*)?"],
    ["/:user/orders/:id", "/:account/orders/:order"],
    ["/:id(foo:bar)", "/:slug(foo:bar)"],
  ]) {
    const files = entries(routes);
    assert.throws(() => assertNoRouteConflicts(files), error => {
      assert.match(error.message, /^Route conflict:/);
      for (const entry of files) {
        assert.ok(error.message.includes(entry.file));
        assert.ok(error.message.includes(entry.route));
      }
      return true;
    });
  }
});

test("duplicate route extensions conflict and repeated entries for one file do not", () => {
  const apiDir = path.resolve("api");
  const files = ["route.js", "route.ts"].map(name => {
    const file = path.join(apiDir, "users", name);
    return { file, ...dirPathToRoute(apiDir, file) };
  });
  assert.throws(() => assertNoRouteConflicts(files), /Route conflict:/);
  assert.doesNotThrow(() => assertNoRouteConflicts([files[0], files[0]]));
});

test("conflicts respect Express case sensitivity without folding distinct Unicode characters", () => {
  for (const routes of [["/Users/:id", "/users/:slug"], ["/CAFÉ", "/café"]]) {
    assert.throws(() => assertNoRouteConflicts(entries(routes)), /Route conflict:/);
    assert.doesNotThrow(() => assertNoRouteConflicts(entries(routes), true));
  }
  for (const routes of [["/K", "/k"], ["/İ", "/i̇"], ["/straße", "/strasse"]]) {
    assert.doesNotThrow(() => assertNoRouteConflicts(entries(routes)));
  }
});

test("specificity overlaps and distinct custom regex patterns remain valid", () => {
  assert.doesNotThrow(() => assertNoRouteConflicts(entries([
    "/files/fixed", "/files/:id", "/files/:rest(.+)", "/files/:optional(*)?",
    "/:id/foo", "/:slug/bar", "/:id(foo:bar)", "/:slug(foo:baz)",
    "/value/:id(\\d+)", "/value/:slug(\\D+)",
    "/word/:id(\\w+)", "/word/:slug(\\W+)",
  ])));
});

async function fixture(t, files = {}) {
  // Polling avoids dropped native events immediately after watcher startup.
  const watch = chokidar.watch;
  t.mock.method(chokidar, "watch", (directory, options) => watch(directory, { ...options, usePolling: true }));
  const apiDir = await fs.mkdtemp(path.join(os.tmpdir(), "nextish-conflicts-"));
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
    apiDir, logs, disposers, write,
    remove: relative => fs.rm(path.join(apiDir, relative), { recursive: true }),
    async mount(parent, options = {}) {
      const settings = { apiDir, logger: message => logs.push(message), ...options };
      if (parent) {
        disposers.push(await mountDirectoryRoutes(parent, settings));
        return parent;
      }
      const router = await createNextishRouter(settings);
      disposers.push(router.close);
      return router;
    },
    async serve(parent) {
      const app = express();
      app.use(parent);
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return (url, method = "GET") => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method, signal: AbortSignal.timeout(3000),
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

for (const [name, files] of [
  ["parameter aliases with disjoint methods", {
    "users/[id]/route.js": handler("get", "GET"),
    "users/[slug]/route.js": handler("post", "POST"),
  }],
  ["duplicate extensions", { "users/route.js": handler("js"), "users/route.ts": handler("ts") }],
  ["conflicting modules that must not be loaded", {
    "users/[id]/route.js": 'throw new Error("route module loaded before conflict check");',
    "users/[slug]/route.js": 'throw new Error("route module loaded before conflict check");',
  }],
]) {
  test(`initial ${name} reject without publishing routes or changing caller routes`, async t => {
    const f = await fixture(t, { "safe/route.js": handler("partial"), ...files });
    await assert.rejects(f.mount(), /Route conflict:/);
    const app = express();
    app.get("/caller", (_req, res) => res.send("caller"));
    const before = app._router.stack.slice();
    await assert.rejects(f.mount(app, { routePrefix: "/api", watch: true }), error => {
      assert.match(error.message, /^Route conflict:/);
      for (const file of Object.keys(files)) assert.ok(error.message.includes(path.join(f.apiDir, file)));
      assert.ok(error.message.includes("/api/users"));
      return true;
    });
    assert.deepEqual(app._router.stack, before);
    const request = await f.serve(app);
    assert.equal(await (await request("/caller")).text(), "caller");
    assert.equal((await request("/api/safe")).status, 404);
    assert.equal((await request("/api/users/value")).status, 404);
    assert.deepEqual(f.logs, []);
  });
}

for (const resolution of ["removal", "rename"]) {
  test(`a watched conflicting addition preserves working routes and recovers after ${resolution}`, { timeout: 12000 }, async t => {
    const f = await fixture(t, { "users/[id]/route.js": handler("old") });
    const app = express();
    app.get("/caller", (_req, res) => res.send("caller"));
    const request = await f.serve(await f.mount(app, { watch: true, routePrefix: "/api" }));
    await update(f.logs, () => f.write("users/[slug]/route.js", handler("added", "POST")), "Error reloading ");
    assert.ok(f.logs.some(message => message.includes("Route conflict:") && message.includes("/api/users/:id") && message.includes("/api/users/:slug")));
    assert.equal(await (await request("/api/users/value")).text(), "old");
    assert.equal((await request("/api/users/value", "POST")).status, 404);
    assert.equal(await (await request("/caller")).text(), "caller");
    assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 1);

    if (resolution === "removal") {
      await update(f.logs, () => f.remove("users/[slug]"));
      assert.equal(await (await request("/api/users/value")).text(), "old");
      await update(f.logs, () => f.write("users/[id]/route.js", handler("recovered")));
      assert.equal(await (await request("/api/users/value")).text(), "recovered");
    } else {
      await update(f.logs, () => fs.rename(path.join(f.apiDir, "users/[slug]"), path.join(f.apiDir, "users/renamed")));
      assert.equal(await (await request("/api/users/value")).text(), "old");
      const response = await request("/api/users/renamed", "POST");
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "added");
    }
  });
}

test("route and directory middleware edits blocked by a conflict apply after its removal", { timeout: 12000 }, async t => {
  const middleware = value => `exports.middleware = (_req, res, next) => { res.set("x-version", ${JSON.stringify(value)}); next(); };`;
  const f = await fixture(t, {
    "users/[id]/route.js": handler("old"),
    "users/middleware.js": middleware("old"),
  });
  const request = await f.serve(await f.mount(undefined, { watch: true }));
  const current = async () => {
    const response = await request("/users/value");
    assert.equal(response.status, 200);
    return { body: await response.text(), middleware: response.headers.get("x-version") };
  };
  assert.deepEqual(await current(), { body: "old", middleware: "old" });
  await update(f.logs, () => f.write("users/[slug]/route.js", handler("conflict")), "Error reloading ");
  await update(f.logs, () => f.write("users/[id]/route.js", handler("new")), "Error reloading ");
  assert.deepEqual(await current(), { body: "old", middleware: "old" });
  await update(f.logs, () => f.write("users/middleware.js", middleware("new")), "Error reloading ");
  assert.deepEqual(await current(), { body: "old", middleware: "old" });
  assert.equal(f.logs.filter(message => message.startsWith("Loaded routes:")).length, 1);

  await update(f.logs, () => f.remove("users/[slug]"));
  assert.deepEqual(await current(), { body: "new", middleware: "new" });
});

for (const kind of ["application", "router"]) {
  test(`conflict detection honors the caller Express ${kind}'s case sensitivity`, async t => {
    const f = await fixture(t, {
      "(upper)/users/ABC/route.js": handler("upper"),
      "(lower)/users/abc/route.js": handler("lower"),
    });
    await assert.rejects(f.mount(kind === "application" ? express() : express.Router()), /Route conflict:/);
    const parent = kind === "application" ? express() : express.Router({ caseSensitive: true });
    if (kind === "application") parent.enable("case sensitive routing");
    const request = await f.serve(await f.mount(parent));
    assert.equal(await (await request("/users/ABC")).text(), "upper");
    assert.equal(await (await request("/users/abc")).text(), "lower");
    assert.equal((await request("/users/Abc")).status, 404);
  });
}

test("caller routes and separate directory mounts may share a route pattern", async t => {
  const first = await fixture(t, { "[id]/route.js": handler("first", "GET") });
  const second = await fixture(t, { "[slug]/route.js": handler("second", "POST") });
  const app = express();
  app.put("/:caller", (_req, res) => res.send("caller"));
  await first.mount(app);
  await second.mount(app);
  const request = await first.serve(app);
  for (const [method, body] of [["PUT", "caller"], ["GET", "first"], ["POST", "second"]]) {
    const response = await request("/shared", method);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
  }
});
