const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { createTodoApp } = require("../dist/example/todo/app");

const userUrl = "/api/users/demo-user";
const projectUrl = `${userUrl}/projects/demo-project`;
const todoUrl = `${projectUrl}/todos/demo-todo`;

async function fixture(t) {
  const { app, api } = await createTodoApp();
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await api.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (resource, method = "GET", body, status = 200) => {
    const response = await fetch(url + resource, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, status, `${method} ${resource}`);
    return response;
  };
  return { url, request, json: async (...args) => (await request(...args)).json() };
}

test("todo example supports the user, project, and todo CRUD workflow", async t => {
  const f = await fixture(t);
  assert.equal((await f.json("/api/users"))[0].id, "demo-user");
  const createdUser = await f.request("/api/users", "POST", { name: " Grace ", email: " GRACE@EXAMPLE.TEST " }, 201);
  const user = await createdUser.json();
  const owner = createdUser.headers.get("location");
  assert.equal(owner, `/api/users/${user.id}`);
  assert.deepEqual(user, { id: user.id, name: "Grace", email: "grace@example.test" });
  assert.equal((await f.json("/api/users")).length, 2);
  assert.deepEqual(await f.json(owner), user);
  assert.deepEqual(await f.json(owner, "PATCH", { name: "Grace Hopper" }), { ...user, name: "Grace Hopper" });

  const createdProject = await f.request(`${owner}/projects`, "POST", { name: " Work " }, 201);
  const project = await createdProject.json();
  const work = createdProject.headers.get("location");
  assert.equal(work, `${owner}/projects/${project.id}`);
  assert.deepEqual(project, { id: project.id, userId: user.id, name: "Work" });
  assert.deepEqual(await f.json(`${owner}/projects`), [project]);
  assert.deepEqual(await f.json(work), project);
  assert.equal((await f.json(work, "PATCH", { name: "Release" })).name, "Release");

  const createdTodo = await f.request(`${work}/todos`, "POST", { title: " Write tests " }, 201);
  const todo = await createdTodo.json();
  const task = createdTodo.headers.get("location");
  assert.equal(task, `${work}/todos/${todo.id}`);
  assert.deepEqual(todo, { id: todo.id, projectId: project.id, title: "Write tests", completed: false });
  assert.deepEqual(await f.json(task), todo);
  assert.deepEqual(await f.json(`${work}/todos?completed=false`), [todo]);
  assert.equal((await f.json(task, "PATCH", { completed: true })).completed, true);
  const renamed = await f.json(task, "PATCH", { title: "Run tests" });
  assert.equal(renamed.completed, true);
  assert.equal(renamed.title, "Run tests");
  assert.deepEqual(await f.json(`${work}/todos?completed=true`), [renamed]);
  assert.deepEqual(await f.json(`${work}/todos?completed=false`), []);
  assert.equal((await f.json(task, "PATCH", { completed: false })).completed, false);
  assert.equal(await (await f.request(task, "DELETE", undefined, 204)).text(), "");
  await f.request(task, "GET", undefined, 404);
  assert.deepEqual(await f.json(`${work}/todos`), []);

  await f.request(work, "DELETE", undefined, 204);
  await f.request(work, "GET", undefined, 404);
  assert.deepEqual(await f.json(`${owner}/projects`), []);
  await f.request(owner, "DELETE", undefined, 204);
  await f.request(owner, "GET", undefined, 404);
  assert.equal((await f.json("/api/users")).length, 1);
});

test("todo example rejects mismatched parents for reads and every mutation", async t => {
  const f = await fixture(t);
  const other = await f.json("/api/users", "POST", { name: "Other", email: "other@example.test" }, 201);
  const otherProject = await f.json(`${userUrl}/projects`, "POST", { name: "Another project" }, 201);
  const wrongOwner = `/api/users/${other.id}/projects/demo-project`;
  const wrongProjectTodo = `${userUrl}/projects/${otherProject.id}/todos/demo-todo`;
  for (const [url, method, body] of [
    [wrongOwner, "GET"], [wrongOwner, "PATCH", { name: "Changed" }], [wrongOwner, "DELETE"],
    [`${wrongOwner}/todos`, "GET"], [`${wrongOwner}/todos`, "POST", { title: "Wrong owner" }],
    [`${wrongOwner}/todos/demo-todo`, "GET"],
    [`${wrongOwner}/todos/demo-todo`, "PATCH", { completed: true }],
    [`${wrongOwner}/todos/demo-todo`, "DELETE"],
    [wrongProjectTodo, "GET"], [wrongProjectTodo, "PATCH", { title: "Wrong project" }], [wrongProjectTodo, "DELETE"],
    ["/api/users/missing/projects", "POST", { name: "Orphan" }],
    [`${userUrl}/projects/missing/todos`, "POST", { title: "Orphan" }],
  ]) {
    await f.request(url, method, body, 404);
  }
  assert.equal((await f.json(projectUrl)).name, "Learn Nextish");
  assert.equal((await f.json(todoUrl)).completed, false);
  assert.deepEqual(await f.json(`/api/users/${other.id}/projects`), []);
  assert.deepEqual(await f.json(`${userUrl}/projects/${otherProject.id}/todos`), []);
});

test("todo example validates bodies and queries and prevents partial changes on conflicts", async t => {
  const f = await fixture(t);
  for (const [url, method, body] of [
    ["/api/users", "POST", { name: " ", email: "invalid" }],
    ["/api/users", "POST", { name: "New", email: "new@example.test", id: "demo-user" }],
    ["/api/users", "POST"], [userUrl, "PATCH", {}],
    [`${userUrl}/projects`, "POST", { name: "New", userId: "another-user" }],
    [projectUrl, "PATCH", { name: "x".repeat(101) }],
    [`${projectUrl}/todos`, "POST", { title: "New", completed: true }],
    [todoUrl, "PATCH", { completed: "true" }], [todoUrl, "PATCH", {}],
    [todoUrl, "PATCH", { projectId: "another-project" }],
    [todoUrl, "PATCH", { title: "x".repeat(201) }],
    [`${projectUrl}/todos?completed=maybe`, "GET"],
    [`${projectUrl}/todos?completed=true&completed=false`, "GET"],
  ]) {
    const failure = await f.json(url, method, body, 400);
    assert.equal(typeof failure.error, "string");
    assert.ok(Array.isArray(failure.issues));
  }
  await f.request("/api/users", "POST", { name: "Duplicate", email: " ADA@EXAMPLE.TEST " }, 409);
  const other = await f.json("/api/users", "POST", { name: "Other", email: "other@example.test" }, 201);
  await f.request(`/api/users/${other.id}`, "PATCH", { name: "Changed", email: "ada@example.test" }, 409);
  assert.deepEqual(await f.json(`/api/users/${other.id}`), other);
  assert.deepEqual(await f.json(`/api/users/${other.id}`, "PATCH", { email: "other@example.test" }), other);
  assert.equal((await f.json("/api/users")).length, 2);
  assert.equal((await f.json(`${projectUrl}/todos`)).length, 1);
  assert.equal((await f.json(todoUrl)).completed, false);

  for (const [body, status] of [["{", 400], [JSON.stringify({ name: "x".repeat(110000) }), 413]]) {
    const response = await fetch(f.url + "/api/users", {
      method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  }
  assert.deepEqual(await f.json("/missing", "GET", undefined, 404), { error: "Not found" });
});

test("todo example cascades deletions and keeps application stores independent", async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const otherProject = await first.json(`${userUrl}/projects`, "POST", { name: "Keep this project" }, 201);
  const otherTodo = await first.json(`${userUrl}/projects/${otherProject.id}/todos`, "POST", { title: "Keep this task" }, 201);
  await first.request(projectUrl, "DELETE", undefined, 204);
  await first.request(todoUrl, "GET", undefined, 404);
  assert.deepEqual(await first.json(`${userUrl}/projects/${otherProject.id}/todos`), [otherTodo]);
  await first.request(userUrl, "DELETE", undefined, 204);
  await first.request(`${userUrl}/projects/${otherProject.id}`, "GET", undefined, 404);
  await first.request(`${userUrl}/projects/${otherProject.id}/todos/${otherTodo.id}`, "GET", undefined, 404);
  assert.deepEqual(await first.json("/api/users"), []);
  assert.equal((await second.json(todoUrl)).title, "Try the todo API");
  assert.equal((await second.json(`${userUrl}/projects`)).length, 1);
});

test("todo example exposes OpenAPI contracts and inherits group middleware without a URL prefix", async t => {
  const f = await fixture(t);
  const document = await f.json("/openapi.json");
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.servers, [{ url: "/api" }]);
  assert.equal(Object.keys(document.paths).length, 6);
  assert.equal(Object.values(document.paths).flatMap(value => Object.keys(value)).length, 15);
  assert.ok(Object.keys(document.paths).every(path => !path.includes("(workspace)")));
  assert.equal(document.paths["/users"].post.requestBody.required, true);
  assert.equal(document.paths["/users"].post.requestBody.content["application/json"].schema.additionalProperties, false);
  const task = document.paths["/users/{userId}/projects/{projectId}/todos/{todoId}"];
  assert.deepEqual(task.patch.tags, ["Todos"]);
  assert.equal(task.patch.requestBody.required, true);
  assert.equal(task.patch.requestBody.content["application/json"].schema.properties.completed.type, "boolean");
  assert.ok(task.delete.responses["204"]);
  const query = document.paths["/users/{userId}/projects/{projectId}/todos"].get.parameters;
  assert.deepEqual(query.find(parameter => parameter.name === "completed").schema.enum, ["true", "false"]);
  for (const url of ["/api/users", projectUrl, todoUrl]) {
    assert.equal((await f.request(url)).headers.get("cache-control"), "no-store");
  }
  await f.request("/api/(workspace)/users", "GET", undefined, 404);
});

test("todo server binds to localhost and shuts down on SIGTERM", { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ["-e", `
    const express = require('express');
    const listen = express.application.listen;
    express.application.listen = function (...args) {
      const server = listen.apply(this, args);
      server.once('listening', () => process.send(server.address()));
      return server;
    };
    require(${JSON.stringify(require.resolve("../dist/example/todo/server"))});
  `], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  const [address] = await once(child, "message");
  assert.equal(address.address, "127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${address.port}${todoUrl}`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "demo-todo");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
});

test("todo server reports invalid ports and listen errors without hanging", async t => {
  const f = await fixture(t);
  for (const [port, error] of [["invalid", /PORT must be an integer/], [new URL(f.url).port, /EADDRINUSE/]]) {
    const child = spawnSync(process.execPath, [require.resolve("../dist/example/todo/server")], {
      env: { ...process.env, PORT: port }, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, error);
    assert.doesNotMatch(child.stderr, /UnhandledPromiseRejection/);
  }
});
