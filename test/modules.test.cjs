const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const Module = require("node:module");
const { createModuleLoader, readModuleRevision } = require("../dist/src/modules");

async function fixture(t, files) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nextish-modules-")));
  const loaders = [];
  const write = async (name, source) => {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    return file;
  };
  t.after(async () => {
    for (const loader of loaders) await loader.close();
    for (const file of Object.keys(require.cache)) {
      if (file.startsWith(directory + path.sep)) delete require.cache[file];
    }
    await fs.rm(directory, { force: true, recursive: true });
  });
  for (const [name, source] of Object.entries(files)) await write(name, source);
  return {
    directory,
    file: name => path.join(directory, name),
    write,
    loader() {
      const loader = createModuleLoader();
      loaders.push(loader);
      return loader;
    },
  };
}

const revisionOf = async file => {
  const { mtimeMs, ctimeMs, size, ino } = await fs.stat(file);
  return { mtimeMs, ctimeMs, size, ino };
};

test("fresh route entries reuse CommonJS modules evaluated in their current generation", async t => {
  const f = await fixture(t, {
    "a.cjs": 'exports.state = require("./b.cjs").state;',
    "b.cjs": 'exports.state = {};',
  });
  const loader = f.loader();
  const a = await loader.load(f.file("a.cjs"), true);
  const b = await loader.load(f.file("b.cjs"), true);
  assert.strictEqual(a.exports.state, b.exports.state);
  assert.notStrictEqual((await loader.load(f.file("b.cjs"), true)).exports.state, b.exports.state);
  loader.invalidate([f.file("b.cjs")]);
  const newA = await loader.load(f.file("a.cjs"), true);
  const newB = await loader.load(f.file("b.cjs"), true);
  assert.strictEqual(newA.exports.state, newB.exports.state);
  assert.notStrictEqual(newA.exports.state, a.exports.state);
});

for (const extension of ["cjs", "mjs"]) {
  test(`${extension} cached shared helpers retain the revision that produced their exports`, async t => {
    const source = extension === "cjs" ? 'exports.value = require("./helper.cjs").value;'
      : 'export {value} from "./helper.mjs";';
    const helper = value => extension === "cjs" ? `exports.value = ${JSON.stringify(value)};`
      : `export const value = ${JSON.stringify(value)};`;
    const f = await fixture(t, {
      [`a.${extension}`]: source,
      [`b.${extension}`]: source,
      [`helper.${extension}`]: helper("old"),
    });
    const loader = f.loader();
    const originalRevision = await revisionOf(f.file(`helper.${extension}`));
    await loader.load(f.file(`a.${extension}`));
    await f.write(`helper.${extension}`, helper("changed"));
    const b = await loader.load(f.file(`b.${extension}`));
    assert.equal(b.exports.value, "old");
    assert.deepEqual(b.revisions.get(f.file(`helper.${extension}`)), originalRevision);
    assert.notDeepEqual(b.revisions.get(f.file(`helper.${extension}`)), await revisionOf(f.file(`helper.${extension}`)));
  });
}

test("CommonJS revisions are captured before evaluation can edit an imported helper", async t => {
  const f = await fixture(t, {
    "route.cjs": 'exports.value = require("./helper.cjs").value; require("node:fs").writeFileSync(require.resolve("./helper.cjs"), \'exports.value = "changed";\');',
    "helper.cjs": 'exports.value = "old";',
  });
  const originalRevision = await revisionOf(f.file("helper.cjs"));
  const loaded = await f.loader().load(f.file("route.cjs"));
  assert.equal(loaded.exports.value, "old");
  assert.deepEqual(loaded.revisions.get(f.file("helper.cjs")), originalRevision);
  assert.notDeepEqual(loaded.revisions.get(f.file("helper.cjs")), await revisionOf(f.file("helper.cjs")));
});

test("native ESM revisions precede helper edits while an entry awaits startup", { timeout: 5000 }, async t => {
  let started;
  let release;
  const beginning = new Promise(resolve => { started = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const key = `nextish-module-revisions-${Math.random()}`;
  globalThis[key] = { started, pause };
  t.after(() => { release(); delete globalThis[key]; });
  const f = await fixture(t, {
    "route.mjs": `import {value} from "./helper.mjs"; globalThis[${JSON.stringify(key)}].started(); await globalThis[${JSON.stringify(key)}].pause; export {value};`,
    "helper.mjs": 'export const value = "old";',
  });
  const originalRevision = await revisionOf(f.file("helper.mjs"));
  const loading = f.loader().load(f.file("route.mjs"));
  await beginning;
  await f.write("helper.mjs", 'export const value = "changed";');
  release();
  const loaded = await loading;
  assert.equal(loaded.exports.value, "old");
  assert.deepEqual(loaded.revisions.get(f.file("helper.mjs")), originalRevision);
  assert.notDeepEqual(loaded.revisions.get(f.file("helper.mjs")), await revisionOf(f.file("helper.mjs")));
});

for (const extension of ["cjs", "mjs"]) {
  test(`${extension} imports preserve application-cached CommonJS identity and watch from attachment`, async t => {
    const f = await fixture(t, {
      [`route.${extension}`]: extension === "cjs" ? 'exports.helper = require("./helper.cjs"); exports.value = exports.helper.value;'
        : 'import helper from "./helper.cjs"; export {helper}; export const value = helper.value;',
      "helper.cjs": 'exports.value = "old";',
    });
    const cached = require(f.file("helper.cjs"));
    await f.write("helper.cjs", 'exports.value = "changed";');
    const baseline = await revisionOf(f.file("helper.cjs"));
    const loaded = await f.loader().load(f.file(`route.${extension}`));
    assert.equal(loaded.exports.value, "old");
    assert.strictEqual(loaded.exports.helper, cached);
    assert.deepEqual(loaded.revisions.get(f.file("helper.cjs")), baseline);
  });
}

test("readModuleRevision only fingerprints files", async t => {
  const f = await fixture(t, { "file.json": "{}" });
  assert.deepEqual(readModuleRevision(f.file("file.json")), await revisionOf(f.file("file.json")));
  assert.equal(readModuleRevision(f.directory), null);
  assert.equal(readModuleRevision(f.file("missing")), null);
});

test("CommonJS reload follows transitive helpers outside apiDir and preserves unrelated exports", async t => {
  const f = await fixture(t, {
    "api/route.cjs": 'const service = require("../services/service.cjs"); exports.GET = () => service.value;',
    "api/other.cjs": 'exports.state = require("../services/unrelated.cjs");',
    "services/service.cjs": 'exports.value = require("./data.json").value; require("node:path"); require("../node_modules/external.cjs");',
    "services/data.json": '{"value":"old"}',
    "services/unrelated.cjs": 'module.exports = {};',
    "node_modules/external.cjs": 'module.exports = {};',
  });
  const loader = f.loader();
  const old = await loader.load(f.file("api/route.cjs"));
  const other = await loader.load(f.file("api/other.cjs"));
  assert.equal(old.exports.GET(), "old");
  assert.deepEqual([...old.dependencies].sort(), ["api/route.cjs", "services/service.cjs", "services/data.json"].map(f.file).sort());
  await f.write("services/data.json", '{"value":"new"}');
  loader.invalidate([f.file("services/data.json")]);
  const replacement = await loader.load(f.file("api/route.cjs"));
  assert.equal(replacement.exports.GET(), "new");
  assert.equal(old.exports.GET(), "old");
  assert.strictEqual((await loader.load(f.file("api/other.cjs"))).exports, other.exports);
  assert.strictEqual(require(f.file("services/unrelated.cjs")), other.exports.state);
});

test("CommonJS circular helpers invalidate their affected ancestors", async t => {
  const f = await fixture(t, {
    "route.cjs": 'exports.read = require("./a.cjs").read;',
    "a.cjs": 'exports.marker = "a"; const b = require("./b.cjs"); exports.read = () => b.value;',
    "b.cjs": 'require("./a.cjs"); exports.value = "old";',
  });
  const loader = f.loader();
  const old = await loader.load(f.file("route.cjs"));
  await f.write("b.cjs", 'require("./a.cjs"); exports.value = "new";');
  loader.invalidate([f.file("b.cjs")]);
  assert.equal((await loader.load(f.file("route.cjs"))).exports.read(), "new");
  assert.equal(old.exports.read(), "old");
});

test("native ESM awaits top-level await and reloads a transitive graph shared by route entries", async t => {
  const f = await fixture(t, {
    "api/a.mjs": 'import {value, state} from "../services/service.mjs"; export const read = () => value; export {state};',
    "api/b.mjs": 'export {value, state} from "../services/service.mjs";',
    "api/other.mjs": 'export const state = {};',
    "services/service.mjs": 'await Promise.resolve(); export {value} from "./leaf.mjs"; export const state = {};',
    "services/leaf.mjs": 'export const value = "old";',
  });
  const loader = f.loader();
  const oldA = await loader.load(f.file("api/a.mjs"));
  const oldB = await loader.load(f.file("api/b.mjs"));
  const other = await loader.load(f.file("api/other.mjs"));
  assert.equal(oldA.exports.read(), "old");
  assert.strictEqual(oldA.exports.state, oldB.exports.state);
  assert.deepEqual([...oldA.dependencies].sort(), ["api/a.mjs", "services/service.mjs", "services/leaf.mjs"].map(f.file).sort());
  await f.write("services/leaf.mjs", 'export const value = "new";');
  loader.invalidate([f.file("services/leaf.mjs")]);
  const newA = await loader.load(f.file("api/a.mjs"), true);
  const newB = await loader.load(f.file("api/b.mjs"), true);
  assert.equal(newA.exports.read(), "new");
  assert.equal(newB.exports.value, "new");
  assert.strictEqual(newA.exports.state, newB.exports.state);
  assert.notStrictEqual(newA.exports.state, oldA.exports.state);
  assert.equal(oldA.exports.read(), "old");
  assert.strictEqual((await loader.load(f.file("api/other.mjs"))).exports, other.exports);
});

test("package type module .js entries use native ESM, including top-level await", async t => {
  const f = await fixture(t, {
    "package.json": '{"type":"module"}',
    "route.js": 'import value from "./helper.js"; await Promise.resolve(); export const read = () => value;',
    "helper.js": 'export default "old";',
  });
  const loader = f.loader();
  assert.equal((await loader.load(f.file("route.js"))).exports.read(), "old");
  await f.write("helper.js", 'export default "new";');
  loader.invalidate([f.file("helper.js")]);
  assert.equal((await loader.load(f.file("route.js"))).exports.read(), "new");
});

test("CommonJS .js exports retain computed method exports and function identity", async t => {
  const f = await fixture(t, {
    "route.js": 'module.exports = { ["G" + "ET"]: () => "old" };',
  });
  const loader = f.loader();
  const old = await loader.load(f.file("route.js"));
  assert.equal(old.exports.GET(), "old");
  assert.strictEqual(old.exports, require(f.file("route.js")));
  await f.write("route.js", 'module.exports = { ["G" + "ET"]: () => "new" };');
  loader.invalidate([f.file("route.js")]);
  const replacement = await loader.load(f.file("route.js"), true);
  assert.equal(replacement.exports.GET(), "new");
  assert.equal(old.exports.GET(), "old");
});

test("syntax-detected .js ESM executes once and awaits top-level await", async t => {
  const f = await fixture(t, {
    "route.js": 'import {value} from "./helper.mjs"; import state from "./state.cjs"; state.loads++; await Promise.resolve(); export const read = () => [value, state.loads];',
    "helper.mjs": 'export const value = "detected";',
    "state.cjs": 'exports.loads = 0;',
  });
  assert.deepEqual((await f.loader().load(f.file("route.js"))).exports.read(), ["detected", 1]);
});

for (const extension of ["cjs", "js"]) {
  for (const [name, source] of [["throw", 'throw new Error("entry failed");'], ["syntax", "exports.GET = (;"]]) {
    test(`${extension} ${name} failure is caught once and entry edits recover`, async t => {
      const f = await fixture(t, { [`route.${extension}`]: source });
      const loader = f.loader();
      await assert.rejects(loader.load(f.file(`route.${extension}`)), error => {
        assert.ok(error.dependencies.has(f.file(`route.${extension}`)));
        if (name === "throw") assert.equal(error.message, "entry failed");
        else assert.ok(error instanceof SyntaxError);
        return true;
      });
      await f.write(`route.${extension}`, 'exports.value = "recovered";');
      loader.invalidate([f.file(`route.${extension}`)]);
      assert.equal((await loader.load(f.file(`route.${extension}`))).exports.value, "recovered");
    });
  }
}

test("native ESM cycles and imported URL queries retain consistent module identities", async t => {
  const f = await fixture(t, {
    "route.mjs": 'import {read, state} from "./a.mjs?flavor=test"; export {read, state};',
    "a.mjs": 'import {value} from "./b.mjs"; export const state = {}; export const read = () => value;',
    "b.mjs": 'import {state} from "./a.mjs?flavor=test"; export const getState = () => state; export const value = "old";',
  });
  const loader = f.loader();
  const old = await loader.load(f.file("route.mjs"));
  assert.equal(old.exports.read(), "old");
  await f.write("b.mjs", 'import {state} from "./a.mjs?flavor=test"; export const getState = () => state; export const value = "new";');
  loader.invalidate([f.file("b.mjs")]);
  assert.equal((await loader.load(f.file("route.mjs"))).exports.read(), "new");
  assert.equal(old.exports.read(), "old");
});

test("ESM imports reload CommonJS helpers and their JSON dependencies", async t => {
  const f = await fixture(t, {
    "route.mjs": 'import service from "./service.cjs"; export const read = () => service.value;',
    "service.cjs": 'exports.value = require("./data.json").value;',
    "data.json": '{"value":"old"}',
  });
  const loader = f.loader();
  const old = await loader.load(f.file("route.mjs"));
  assert.ok(old.dependencies.has(f.file("data.json")));
  await f.write("data.json", '{"value":"new"}');
  loader.invalidate([f.file("data.json")]);
  assert.equal((await loader.load(f.file("route.mjs"))).exports.read(), "new");
  assert.equal(old.exports.read(), "old");
});

test("native ESM JSON import attributes survive dependency reload", async t => {
  const f = await fixture(t, {
    "route.mjs": 'import data from "./data.json" with {type:"json"}; export const read = () => data.value;',
    "data.json": '{"value":"old"}',
  });
  const loader = f.loader();
  const old = await loader.load(f.file("route.mjs"));
  await f.write("data.json", '{"value":"new"}');
  loader.invalidate([f.file("data.json")]);
  assert.equal((await loader.load(f.file("route.mjs"))).exports.read(), "new");
  assert.equal(old.exports.read(), "old");
});

for (const extension of ["cjs", "mjs"]) {
  test(`${extension} deleted helpers recover and failed loads report watched dependencies`, async t => {
    const route = extension === "cjs" ? 'exports.read = require("./helper.cjs").read;'
      : 'export {read} from "./helper.mjs";';
    const helper = value => extension === "cjs" ? `exports.read = () => ${JSON.stringify(value)};`
      : `export const read = () => ${JSON.stringify(value)};`;
    const f = await fixture(t, { [`route.${extension}`]: route, [`helper.${extension}`]: helper("old") });
    const loader = f.loader();
    const old = await loader.load(f.file(`route.${extension}`));
    await fs.rm(f.file(`helper.${extension}`));
    loader.invalidate([f.file(`helper.${extension}`)]);
    await assert.rejects(loader.load(f.file(`route.${extension}`)), error => {
      assert.ok(error.dependencies.has(f.file(`helper.${extension}`)));
      return true;
    });
    assert.equal(old.exports.read(), "old");
    await f.write(`helper.${extension}`, helper("restored"));
    loader.invalidate([f.file(`helper.${extension}`)]);
    assert.equal((await loader.load(f.file(`route.${extension}`))).exports.read(), "restored");
  });
}

test("missing new CommonJS dependencies report extension and directory candidates", async t => {
  const f = await fixture(t, {
    "api/route.cjs": 'module.exports = require("../services/new.cjs");',
    "services/new.cjs": 'module.exports = require("../missing/helper");',
  });
  const loader = f.loader();
  await assert.rejects(loader.load(f.file("api/route.cjs")), error => {
    assert.equal(error.code, "MODULE_NOT_FOUND");
    for (const file of ["api/route.cjs", "services/new.cjs", "missing/helper.js", "missing/helper/index.js"]) {
      assert.ok(error.dependencies.has(f.file(file)), file);
      assert.ok(error.revisions.has(f.file(file)), file);
    }
    assert.equal(error.revisions.get(f.file("missing/helper.js")), null);
    assert.equal(error.dependencies.has(require.resolve("../dist/src/modules")), false);
    return true;
  });
  await f.write("missing/helper.js", 'exports.value = "created";');
  loader.invalidate([f.file("missing/helper.js")]);
  assert.equal((await loader.load(f.file("api/route.cjs"))).exports.value, "created");
});

test("missing new ESM dependencies report their exact target and recover after creation", async t => {
  const f = await fixture(t, {
    "api/route.mjs": 'export {value} from "../services/new.mjs";',
    "services/new.mjs": 'export {value} from "../missing/helper.mjs";',
  });
  const loader = f.loader();
  await assert.rejects(loader.load(f.file("api/route.mjs")), error => {
    assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
    for (const file of ["api/route.mjs", "services/new.mjs", "missing/helper.mjs"]) {
      assert.ok(error.dependencies.has(f.file(file)), file);
      assert.ok(error.revisions.has(f.file(file)), file);
    }
    assert.equal(error.revisions.get(f.file("missing/helper.mjs")), null);
    return true;
  });
  await f.write("missing/helper.mjs", 'export const value = "created";');
  loader.invalidate([f.file("missing/helper.mjs")]);
  assert.equal((await loader.load(f.file("api/route.mjs"))).exports.value, "created");
});

for (const extension of ["cjs", "js", "mjs"]) {
  test(`${extension} failed CommonJS helper evaluation retains the partial dependency graph`, async t => {
    const source = extension === "mjs" ? 'import helper from "./helper.cjs"; export const value = helper.value;'
      : 'exports.value = require("./helper.cjs").value;';
    const f = await fixture(t, {
      [`route.${extension}`]: source,
      "helper.cjs": 'exports.value = require("./broken.cjs").value;',
      "broken.cjs": 'throw Object.freeze(new Error("broken helper"));',
    });
    const loader = f.loader();
    const originalLoad = Module.prototype.load;
    await assert.rejects(loader.load(f.file(`route.${extension}`)), error => {
      assert.equal(error.message, "broken helper");
      assert.ok(error.dependencies.has(f.file("helper.cjs")));
      assert.ok(error.dependencies.has(f.file("broken.cjs")));
      assert.ok(error.revisions.get(f.file("broken.cjs")));
      return true;
    });
    assert.strictEqual(Module.prototype.load, originalLoad);
    await f.write("broken.cjs", 'exports.value = "fixed";');
    loader.invalidate([f.file("broken.cjs")]);
    assert.equal((await loader.load(f.file(`route.${extension}`))).exports.value, "fixed");
    assert.strictEqual(Module.prototype.load, originalLoad);
  });
}

test("CommonJS syntax in configured TypeScript and JSX extensions preserves legacy loading", async t => {
  const f = await fixture(t, Object.fromEntries(["ts", "tsx", "jsx"].map(extension => [
    `route.${extension}`, `exports.value = ${JSON.stringify(extension)};`,
  ])));
  const loader = f.loader();
  for (const extension of ["ts", "tsx", "jsx"]) {
    assert.equal((await loader.load(f.file(`route.${extension}`))).exports.value, extension);
  }
});

test("installed tsx hooks compile native ESM TypeScript routes and helper reloads", async t => {
  const f = await fixture(t, {
    "package.json": '{"type":"module"}',
    "route.ts": 'import {value} from "./helper.ts"; await Promise.resolve(); export const read = (): string => value;',
    "helper.ts": 'export const value: string = "old";',
  });
  const source = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const {createModuleLoader} = require(${JSON.stringify(require.resolve("../dist/src/modules"))});
    (async () => {
      const loader = createModuleLoader();
      try {
        const old = await loader.load(${JSON.stringify(f.file("route.ts"))});
        assert.equal(old.exports.read(), 'old');
        await fs.writeFile(${JSON.stringify(f.file("helper.ts"))}, 'export const value: string = "new";');
        loader.invalidate([${JSON.stringify(f.file("helper.ts"))}]);
        assert.equal((await loader.load(${JSON.stringify(f.file("route.ts"))})).exports.read(), 'new');
        assert.equal(old.exports.read(), 'old');
      } finally { await loader.close(); }
      process.stdout.write('typed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", require.resolve("tsx"), "-e", source], { timeout: 10000 });
  assert.equal(stdout, "typed");
});

test("native ESM loading is isolated from ordinary application imports and other loaders", async t => {
  const f = await fixture(t, {
    "route.mjs": 'export {value} from "./helper.mjs";',
    "helper.mjs": 'export const value = "old";',
  });
  const first = f.loader();
  const second = f.loader();
  const ordinary = await import(pathToFileURL(f.file("route.mjs")).href);
  const previousSecond = await second.load(f.file("route.mjs"));
  await first.load(f.file("route.mjs"));
  await f.write("helper.mjs", 'export const value = "new";');
  first.invalidate([f.file("helper.mjs")]);
  assert.equal((await first.load(f.file("route.mjs"))).exports.value, "new");
  assert.strictEqual(await import(pathToFileURL(f.file("route.mjs")).href), ordinary);
  assert.equal(ordinary.value, "old");
  assert.strictEqual((await second.load(f.file("route.mjs"))).exports, previousSecond.exports);
  await first.close();
  second.invalidate([f.file("helper.mjs")]);
  assert.equal((await second.load(f.file("route.mjs"))).exports.value, "new");
});

test("module loader close is idempotent and ports never keep a child process running", async t => {
  const f = await fixture(t, { "route.mjs": 'await Promise.resolve(); export const GET = () => "ready";' });
  const source = `
    const assert = require('node:assert/strict');
    const {createModuleLoader} = require(${JSON.stringify(require.resolve("../dist/src/modules"))});
    (async () => {
      const loader = createModuleLoader();
      assert.equal((await loader.load(${JSON.stringify(f.file("route.mjs"))})).exports.GET(), 'ready');
      const closing = loader.close();
      assert.strictEqual(loader.close(), closing);
      await closing;
      await assert.rejects(loader.load(${JSON.stringify(f.file("route.mjs"))}), /closed/);
      process.stdout.write('closed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", source], { timeout: 5000 });
  assert.equal(stdout, "closed");
});

for (const lateRejection of [false, true]) {
  test(`close promptly stops waiting for ${lateRejection ? "late-rejecting" : "unsettled"} top-level await`, async t => {
    const source = `globalThis.nextishModuleStarted = true;
      await new Promise(resolve => { globalThis.nextishReleaseModule = resolve; });
      ${lateRejection ? 'throw new Error("late module failure");' : 'export const value = "finished";'}`;
    const f = await fixture(t, { "route.mjs": source });
    const script = `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const {setTimeout: delay} = require('node:timers/promises');
      const {createModuleLoader} = require(${JSON.stringify(require.resolve("../dist/src/modules"))});
      (async () => {
        const originalLoad = Module.prototype.load;
        const loader = createModuleLoader();
        const loading = assert.rejects(loader.load(${JSON.stringify(f.file("route.mjs"))}), /closed/);
        while (!globalThis.nextishModuleStarted) await new Promise(setImmediate);
        await Promise.race([loader.close(), delay(1000).then(() => {throw new Error('close hung');})]);
        await loading;
        assert.strictEqual(Module.prototype.load, originalLoad);
        if (${lateRejection}) { globalThis.nextishReleaseModule(); await delay(20); }
        process.stdout.write('stopped');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", script], { timeout: 5000 });
    assert.equal(stdout, "stopped");
  });
}
