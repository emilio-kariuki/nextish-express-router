const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const chokidar = require("chokidar").default;
const express = require("express");
const { createNextishRouter, mountDirectoryRoutes, generateOpenAPI } = require("../dist/src");

const handler = value => `exports.GET = (_req, res) => res.send(${JSON.stringify(value)});`;

async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function fixture(t, files) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nextish-reload-")));
  const apiDir = path.join(directory, "api");
  const logs = [];
  const closers = [];
  const servers = [];
  const watchers = [];
  const watch = chokidar.watch;
  // These assertions concern reload transactions; native discovery has separate coverage.
  t.mock.method(chokidar, "watch", (files, options) => {
    const watcher = watch(files, { ...options, usePolling: true });
    watchers.push(watcher);
    return watcher;
  });
  t.after(async () => {
    for (const close of closers) await close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const file of Object.keys(require.cache)) if (file.startsWith(directory + path.sep)) delete require.cache[file];
    await fs.rm(directory, { recursive: true, force: true });
  });
  const write = async (name, source) => {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), ".nextish-write.tmp");
    await fs.writeFile(temporary, source);
    await fs.rename(temporary, file);
  };
  await fs.mkdir(apiDir);
  for (const [file, source] of Object.entries(files)) await write(file, source);
  const update = async (change, prefix = "Loaded routes:\n") => {
    const before = logs.length;
    await change();
    await until(() => logs.slice(before).some(message => message.startsWith(prefix)), `Missing ${prefix}: ${logs.slice(before).join("\n")}`);
  };
  return {
    apiDir, directory, logs, watchers, closers, write, update,
    remove: name => fs.rm(path.join(directory, name)),
    async mount(options = {}) {
      const api = await createNextishRouter({ apiDir, watch: true, logger: message => logs.push(message), ...options });
      closers.push(api.close);
      return api;
    },
    async serve(router) {
      const app = express();
      app.use(router);
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return (url = "/", init = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        ...init, signal: AbortSignal.timeout(5000),
      });
    },
  };
}

test("inspection publishes detached, sorted route metadata only after successful reloads", async t => {
  const route = `
    exports.docs = { tags: ["shared"], schemas: {query: {type: "object", properties: { q: {type: "string"} }}} };
    exports.GET = { handler: (_req, res) => res.send("get"), docs: {summary: "Read", responses: {200: {description: "Found"}}} };
    exports.POST = { handler: (_req, res) => res.send("post"), docs: {tags: ["write"], schemas: {body: {type: "object"}}} };
  `;
  const f = await fixture(t, { "api/z/[name]/route.cjs": handler("z"), "api/a/[id]/route.cjs": route });
  const api = await f.mount({ routePrefix: "/v1" });
  const initial = api.getRoutes();
  assert.deepEqual(initial.map(({ method, path }) => [method, path]), [["GET", "/v1/a/:id"], ["POST", "/v1/a/:id"], ["GET", "/v1/z/:name"]]);
  assert.equal(initial[0].file, path.join(f.apiDir, "a/[id]/route.cjs"));
  assert.deepEqual(initial[1].docs.tags, ["write"]);
  assert.ok(initial[1].docs.schemas.query);
  assert.ok(initial[1].docs.schemas.body);
  initial[0].docs.tags.push("mutated");
  initial.pop();
  assert.deepEqual(api.getRoutes()[0].docs.tags, ["shared"]);
  assert.equal(api.getRoutes().length, 3);
  const before = api.getRoutes();
  await f.update(() => f.write("api/a/[id]/route.cjs", "exports.GET = {handler: null};"), "Error reloading ");
  assert.deepEqual(api.getRoutes(), before);
  await f.update(() => f.write("api/a/[id]/route.cjs", 'exports.DELETE = (_req, res) => res.end();'));
  assert.deepEqual(api.getRoutes().map(route => route.method), ["DELETE", "GET"]);
  assert.equal(before[0].method, "GET");
  const spec = generateOpenAPI(api.getRoutes(), { title: "Example", version: "1" });
  assert.ok(spec.paths["/v1/a/{id}"].delete);
  await f.update(() => f.remove("api/z/[name]/route.cjs"));
  assert.equal(api.getRoutes().length, 1);
  await api.close();
  const closed = api.getRoutes();
  await f.write("api/a/[id]/route.cjs", handler("closed"));
  assert.deepEqual(api.getRoutes(), closed);
  assert.ok(f.watchers.every(watcher => Object.keys(watcher.getWatched()).length === 0));
});

test("direct mounts expose only their own manifest through their callable cleanup", async t => {
  const f = await fixture(t, { "api/route.cjs": handler("root") });
  const app = express();
  app.get("/caller", (_req, res) => res.send("caller"));
  const close = await mountDirectoryRoutes(app, { apiDir: f.apiDir, routePrefix: "/api", logger: () => {} });
  f.closers.push(close);
  assert.equal(typeof close, "function");
  assert.deepEqual(close.getRoutes().map(({ method, path }) => [method, path]), [["GET", "/api/"]]);
  await close();
  assert.equal(close.getRoutes().length, 1);
});

test("transitive helper edits outside apiDir refresh every affected route and preserve unrelated modules", async t => {
  const key = `nextish_counter_${Math.random()}`;
  t.after(() => delete globalThis[key]);
  const route = 'const service = require("../../services/service.cjs"); exports.GET = (_req, res) => res.send(service.value);';
  const f = await fixture(t, {
    "api/a/route.cjs": route,
    "api/b/route.cjs": route,
    "api/other/route.cjs": `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] || 0) + 1; ${handler("other")}`,
    "services/service.cjs": 'exports.value = require("./leaf.cjs").value;',
    "services/leaf.cjs": 'exports.value = "old";',
  });
  const api = await f.mount();
  const request = await f.serve(api);
  assert.equal(await (await request("/a")).text(), "old");
  await f.update(() => f.write("services/leaf.cjs", 'exports.value = "new";'));
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "new");
  assert.equal(await (await request("/other")).text(), "other");
  assert.equal(globalThis[key], 1);
  await api.close();
  assert.ok(f.watchers.every(watcher => Object.keys(watcher.getWatched()).length === 0));
});

test("CommonJS routes imported by other routes share one module instance per publication", async t => {
  const key = `nextish_route_instance_${Math.random()}`;
  globalThis[key] = 0;
  t.after(() => delete globalThis[key]);
  const dependency = `
    globalThis[${JSON.stringify(key)}]++;
    const generation = globalThis[${JSON.stringify(key)}];
    exports.GET = (_req, res) => res.send(String(generation));
  `;
  const f = await fixture(t, {
    "api/a/route.cjs": 'exports.GET = require("../b/route.cjs").GET;',
    "api/b/route.cjs": dependency,
  });
  const request = await f.serve(await f.mount());
  assert.equal(globalThis[key], 1, "A discovered route must not be reevaluated after another route already imported it");
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "1");
  await f.update(() => f.write("api/b/route.cjs", dependency + "\n// Changed dependency"));
  assert.equal(globalThis[key], 2, "The changed route should be evaluated once in the next publication");
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "2");
});

test("delayed unchanged startup notifications do not reevaluate routes or directory middleware", async t => {
  const key = `nextish_duplicate_event_${Math.random()}`;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  globalThis[key] = { routes: 0, middleware: 0, enter, promise: new Promise(resolve => { release = resolve; }) };
  t.after(() => { release(); delete globalThis[key]; });
  const middleware = `globalThis[${JSON.stringify(key)}].middleware++; exports.middleware = (_req, _res, next) => next();`;
  const f = await fixture(t, {
    "api/middleware.cjs": middleware,
    "api/a/route.cjs": `globalThis[${JSON.stringify(key)}].routes++; ${handler("a")}`,
    "api/z/route.mjs": `const gate = globalThis[${JSON.stringify(key)}]; gate.enter(); await gate.promise; export const GET = (_req, res) => res.send("z");`,
  });
  const mounting = f.mount();
  await entered;
  // Native watchers can deliver initial rename notifications after the modules were read.
  f.watchers[0].emit("all", "change", path.join(f.apiDir, "a/route.cjs"));
  f.watchers[0].emit("all", "add", path.join(f.apiDir, "middleware.cjs"));
  release();
  const request = await f.serve(await mounting);
  assert.equal(globalThis[key].routes, 1);
  assert.equal(globalThis[key].middleware, 1);
  assert.equal(f.logs.length, 1, "Unchanged notifications must not publish a redundant route set");
  assert.equal(await (await request("/a")).text(), "a");
  await f.update(() => f.write("api/middleware.cjs", middleware + "\n// Actual edit"));
  assert.equal(globalThis[key].routes, 1);
  assert.equal(globalThis[key].middleware, 2);
});

test("a route edited after being imported during startup is refreshed in every consumer", async t => {
  const key = `nextish_imported_route_edit_${Math.random()}`;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  globalThis[key] = { evaluations: 0, enter, promise: new Promise(resolve => { release = resolve; }) };
  t.after(() => { release(); delete globalThis[key]; });
  const dependency = value => `globalThis[${JSON.stringify(key)}].evaluations++; ${handler(value)}`;
  const f = await fixture(t, {
    "api/a/route.mjs": `
      import {GET as imported} from "../b/route.cjs";
      const gate = globalThis[${JSON.stringify(key)}];
      gate.enter();
      await gate.promise;
      export const GET = imported;
    `,
    "api/b/route.cjs": dependency("old"),
  });
  const mounting = f.mount();
  await entered;
  const changed = once(f.watchers[0], "all");
  await f.write("api/b/route.cjs", dependency("new"));
  await changed;
  release();
  const request = await f.serve(await mounting);
  for (const route of ["/a", "/b"]) assert.equal(await (await request(route)).text(), "new", route);
  assert.equal(globalThis[key].evaluations, 2, "The real queued edit must evaluate the imported route once more");
});

test("native ESM route and middleware helpers reload after errors and deletion without losing working handlers", async t => {
  const route = 'import {value} from "../../services/leaf.mjs"; await Promise.resolve(); export const GET = (_req, res) => res.send(value);';
  const f = await fixture(t, {
    "api/a/route.mjs": route,
    "api/b/route.mjs": route,
    "api/middleware.mjs": 'import {guard} from "../services/guard.mjs"; export const middleware = (_req, res, next) => { res.set("x-guard", guard); next(); };',
    "services/leaf.mjs": 'export const value = "old";',
    "services/guard.mjs": 'export const guard = "old guard";',
  });
  const request = await f.serve(await f.mount());
  await f.update(() => f.write("services/leaf.mjs", 'export const value = "new";'));
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "new");
  await f.update(() => f.write("services/guard.mjs", 'export const guard = "new guard";'));
  assert.equal((await request("/a")).headers.get("x-guard"), "new guard");
  await f.update(() => f.write("services/leaf.mjs", 'throw new Error("bad helper"); export const value = "bad";'), "Error reloading ");
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "new");
  await f.update(() => f.remove("services/leaf.mjs"), "Error reloading ");
  assert.equal(await (await request("/a")).text(), "new");
  await f.update(() => f.write("services/leaf.mjs", 'export const value = "restored";'));
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "restored");
});

test("a failed shared-helper transaction retries consumers not reached before a route error", async t => {
  const normal = 'const helper = require("../../shared.cjs"); exports.GET = (_req, res) => res.send(helper.value);';
  const f = await fixture(t, {
    "api/a/route.cjs": 'const helper = require("../../shared.cjs"); exports.GET = helper.enabled ? (_req, res) => res.send(helper.value) : 42;',
    "api/b/route.cjs": normal,
    "shared.cjs": 'exports.enabled = true; exports.value = "old";',
  });
  const request = await f.serve(await f.mount());
  await f.update(() => f.write("shared.cjs", 'exports.enabled = false; exports.value = "new";'), "Error reloading ");
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "old");
  await f.update(() => f.write("api/a/route.cjs", normal));
  for (const url of ["/a", "/b"]) assert.equal(await (await request(url)).text(), "new");
});

for (const format of ["cjs", "mjs"]) {
  for (const failure of ["missing", "throwing"]) {
    test(`${format} reload recovers when a newly imported ${failure} helper is fixed`, async t => {
      const routeFile = `api/route.${format}`;
      const old = format === "cjs" ? handler("old") : 'export const GET = (_req, res) => res.send("old");';
      const load = format === "cjs"
        ? 'const {value} = require("../services/new.cjs"); exports.GET = (_req, res) => res.send(value);'
        : 'import {value} from "../services/new.mjs"; export const GET = (_req, res) => res.send(value);';
      const helper = `services/new.${format}`;
      const bad = format === "cjs" ? 'throw new Error("broken helper");' : 'throw new Error("broken helper"); export const value = "bad";';
      const f = await fixture(t, { [routeFile]: old, ...(failure === "throwing" ? { [helper]: bad } : {}) });
      const request = await f.serve(await f.mount());
      await f.update(() => f.write(routeFile, load), "Error reloading ");
      assert.equal(await (await request()).text(), "old");
      await f.update(() => f.write(helper, format === "cjs" ? 'exports.value = "recovered";' : 'export const value = "recovered";'));
      assert.equal(await (await request()).text(), "recovered");
    });
  }

  test(`${format} reload recovers when a newly imported helper's invalid handler is corrected`, async t => {
    const routeFile = `api/route.${format}`;
    const helperFile = `services/handler.${format}`;
    const old = format === "cjs" ? handler("old") : 'export const GET = (_req, res) => res.send("old");';
    const load = format === "cjs"
      ? 'exports.GET = require("../services/handler.cjs").handler;'
      : 'export {handler as GET} from "../services/handler.mjs";';
    const declaration = format === "cjs" ? "exports.handler = " : "export const handler = ";
    const f = await fixture(t, {
      [routeFile]: old,
      [helperFile]: declaration + "42;",
    });
    const api = await f.mount();
    const request = await f.serve(api);
    const previous = api.getRoutes();
    await f.update(() => f.write(routeFile, load), "Error reloading ");
    assert.equal(await (await request()).text(), "old");
    assert.deepEqual(api.getRoutes(), previous);
    await f.update(() => f.write(helperFile, declaration + '(_req, res) => res.send("recovered");'));
    assert.equal(await (await request()).text(), "recovered");
  });
}

test("changes arriving during a top-level await are not consumed by the earlier import", async t => {
  const key = `nextish_gate_${Math.random()}`;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  globalThis[key] = { enter, promise: new Promise(resolve => { release = resolve; }) };
  t.after(() => { release(); delete globalThis[key]; });
  const f = await fixture(t, { "api/route.mjs": 'export const GET = (_req, res) => res.send("old");' });
  const request = await f.serve(await f.mount());
  await f.write("api/route.mjs", `globalThis[${JSON.stringify(key)}].enter(); await globalThis[${JSON.stringify(key)}].promise; export const GET = (_req, res) => res.send("middle");`);
  await entered;
  const changed = once(f.watchers[0], "all");
  await f.write("api/route.mjs", 'export const GET = (_req, res) => res.send("new");');
  await changed;
  release();
  await until(async () => await (await request()).text() === "new", "Queued ESM edit did not load");
});

for (const phase of ["startup", "reload"]) {
  test(`a ${phase} helper edit during top-level await is reconciled after watcher readiness`, async t => {
    const key = `nextish_new_helper_${Math.random()}`;
    let enter;
    let release;
    const entered = new Promise(resolve => { enter = resolve; });
    globalThis[key] = { enter, promise: new Promise(resolve => { release = resolve; }) };
    t.after(() => { release(); delete globalThis[key]; });
    const waitingRoute = `
      import {value} from "../services/new.mjs";
      const gate = globalThis[${JSON.stringify(key)}];
      gate.enter();
      await gate.promise;
      export const GET = (_req, res) => res.send(value);
    `;
    const f = await fixture(t, {
      "api/route.mjs": phase === "startup" ? waitingRoute : 'export const GET = (_req, res) => res.send("original");',
      "services/new.mjs": 'export const value = "old";',
    });
    const mounting = f.mount();
    let request;
    if (phase === "reload") {
      request = await f.serve(await mounting);
      await f.write("api/route.mjs", waitingRoute);
    }
    await entered;
    await f.write("services/new.mjs", 'export const value = "new";');
    release();
    request ??= await f.serve(await mounting);
    await until(async () => await (await request()).text() === "new", "A newly imported helper edit was lost before dependency watches became ready");
  });
}

test("close stops watching and publication without waiting for pending user top-level await", async t => {
  const key = `nextish_close_gate_${Math.random()}`;
  let enter;
  let release;
  let evaluated;
  const entered = new Promise(resolve => { enter = resolve; });
  const finished = new Promise(resolve => { evaluated = resolve; });
  globalThis[key] = { enter, evaluated, promise: new Promise(resolve => { release = resolve; }) };
  t.after(() => { release(); delete globalThis[key]; });
  const f = await fixture(t, { "api/route.mjs": 'export const GET = (_req, res) => res.send("old");' });
  const api = await f.mount();
  const request = await f.serve(api);
  await f.write("api/route.mjs", `const gate = globalThis[${JSON.stringify(key)}]; gate.enter(); await gate.promise; gate.evaluated(); export const GET = (_req, res) => res.send("late");`);
  await entered;
  let closed = false;
  const closing = api.close().then(() => { closed = true; });
  try {
    await until(() => closed, "close waited for unresolved top-level await");
  } finally {
    release();
  }
  await closing;
  await finished;
  assert.equal(await (await request()).text(), "old");
  assert.ok(f.watchers.every(watcher => Object.keys(watcher.getWatched()).length === 0));
});

test("watcher errors during asynchronous startup reject before routes are published", async t => {
  const key = `nextish_start_gate_${Math.random()}`;
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  globalThis[key] = { enter, promise: new Promise(resolve => { release = resolve; }) };
  t.after(() => { release(); delete globalThis[key]; });
  const f = await fixture(t, { "api/route.mjs": `const gate = globalThis[${JSON.stringify(key)}]; gate.enter(); await gate.promise; export const GET = (_req, res) => res.send("partial");` });
  const app = express();
  app.get("/caller", (_req, res) => res.send("caller"));
  const previous = app._router.stack.slice();
  const starting = mountDirectoryRoutes(app, { apiDir: f.apiDir, watch: true, logger: message => f.logs.push(message) });
  await entered;
  f.watchers[0].emit("error", new Error("startup watcher failed"));
  release();
  await assert.rejects(starting, /startup watcher failed/);
  assert.deepEqual(app._router.stack, previous);
  assert.deepEqual(f.logs, []);
  assert.ok(f.watchers.every(watcher => Object.keys(watcher.getWatched()).length === 0));
});

test("devMode false retains cached helper exports", async t => {
  const f = await fixture(t, {
    "api/route.cjs": 'const helper = require("../helper.cjs"); exports.GET = (_req, res) => res.send(helper.value);',
    "helper.cjs": 'exports.value = "cached";',
  });
  const request = await f.serve(await f.mount({ devMode: false }));
  await f.update(() => f.write("helper.cjs", 'exports.value = "changed";'));
  assert.equal(await (await request()).text(), "cached");
});
