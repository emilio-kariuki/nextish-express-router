const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { createNextishRouter } = require("../dist/src");
const exampleRoute = require("../dist/example/api/blog/route");
const exampleServer = require.resolve("../dist/example/server");

test("the example serves every method and rejects invalid POSTs before its handler", async t => {
  let postCalls = 0;
  const originalPost = exampleRoute.POST.handler;
  exampleRoute.POST.handler = (...args) => {
    postCalls++;
    return originalPost(...args);
  };
  t.after(() => { exampleRoute.POST.handler = originalPost; });

  const apiRouter = await createNextishRouter({
    apiDir: path.resolve(__dirname, "../dist/example/api"),
    extensions: [".js"],
    logger: () => {}
  });
  t.after(() => apiRouter.close());
  const app = express();
  app.use("/api", apiRouter);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/blog`;

  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(url, { method });
    assert.equal(response.status, 200, method);
    assert.equal((await response.json()).method, method);
  }
  for (const body of [{}, { name: "" }, { name: 42 }]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal(postCalls, 0);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ada" })
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.method, "POST");
  assert.equal(result.user.name, "Ada");
  assert.equal(typeof result.user.id, "number");
  assert.equal(postCalls, 1);
});

test("the example reports router startup failures", () => {
  const child = spawnSync(process.execPath, ["--unhandled-rejections=warn", "-e", `
    const routerModule = require(${JSON.stringify(require.resolve("../dist/src"))});
    routerModule.createNextishRouter = async () => { throw new Error("Intentional startup failure"); };
    require(${JSON.stringify(exampleServer)});
  `], { encoding: "utf8", timeout: 5000 });

  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Intentional startup failure/);
  assert.doesNotMatch(child.stderr, /UnhandledPromiseRejectionWarning/);
});

test("the development example releases its server and watcher on SIGTERM", { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ["-e", `
    const express = require("express");
    const listen = express.application.listen;
    express.application.listen = function () {
      const server = listen.call(this, 0, "127.0.0.1");
      server.once("listening", () => process.send(server.address().port));
      return server;
    };
    require(${JSON.stringify(exampleServer)});
  `], {
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  const [port] = await once(child, "message");
  const response = await fetch(`http://127.0.0.1:${port}/api/blog`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).method, "GET");

  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
});
