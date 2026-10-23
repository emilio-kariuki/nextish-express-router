const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { dirPathToRoute } = require("../dist/src/transform");

const apiDir = path.resolve("api");
const routeFor = directory => dirPathToRoute(apiDir, path.join(apiDir, directory, "route.js")).route;

test("root, static, and dynamic directories preserve their routes", async t => {
  const app = express();
  app.get(routeFor(""), (_req, res) => res.send("root"));
  app.get(routeFor("about/team"), (_req, res) => res.send("team"));
  app.get(routeFor("blog/[id]"), (req, res) => res.json(req.params));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;

  assert.equal(await (await fetch(url)).text(), "root");
  assert.equal(await (await fetch(`${url}/about/team`)).text(), "team");
  assert.deepEqual(await (await fetch(`${url}/blog/hello%20world`)).json(), { id: "hello world" });
  assert.equal((await fetch(`${url}/blog`)).status, 404);
  assert.equal((await fetch(`${url}/blog/a/b`)).status, 404);
});

test("required catch-alls reject empty paths and optional catch-alls match the base", async t => {
  const app = express();
  for (const directory of ["required/[...rest]", "docs/[[...rest]]"]) {
    app.get(routeFor(directory), (req, res) => res.json({ rest: req.params.rest ?? "" }));
  }
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;

  for (const pathname of ["/required", "/required/"]) {
    assert.equal((await fetch(`${url}${pathname}`)).status, 404, pathname);
  }
  for (const pathname of ["/docs", "/docs/"]) {
    const response = await fetch(`${url}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.deepEqual(await response.json(), { rest: "" });
  }
  for (const base of ["required", "docs"]) {
    for (const rest of ["one", "one/two"]) {
      const response = await fetch(`${url}/${base}/${rest}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { rest });
    }
  }
});

test("invalid parameters and files outside the API directory fail clearly", () => {
  for (const directory of ["[]", "[bad-name]", "[...bad-name]", "[[...bad-name]]", "[id"]) {
    assert.throws(() => routeFor(directory), /Invalid route parameter/, directory);
  }
  assert.throws(
    () => dirPathToRoute(apiDir, path.join(apiDir, "..", "elsewhere", "route.js")),
    /Route file must be inside/
  );
});
