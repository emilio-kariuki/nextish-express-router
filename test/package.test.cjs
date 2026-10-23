const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const manifest = require("../package.json");
const built = require("../dist/src");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");

test("package entry resolves to the built router", () => {
  assert.equal(typeof built.createNextishRouter, "function");
  assert.equal(require("..").createNextishRouter, built.createNextishRouter);
});

test("package ships its entry points and self-contained source maps", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { cwd: root, timeout: 30_000 },
  );
  const [packed] = JSON.parse(stdout);
  const files = packed.files.map(({ path }) => path);

  assert.ok(files.includes(manifest.main), "runtime entry must be published");
  assert.ok(files.includes(manifest.types), "declarations must be published");
  for (const file of files) {
    assert.match(file, /^(dist\/src\/.+\.(js|d\.ts|js\.map)|package\.json|README\.md|LICENSE)$/);
    if (file.endsWith(".js.map")) {
      const map = JSON.parse(await readFile(path.join(root, file), "utf8"));
      assert.equal(map.sourcesContent.length, map.sources.length);
      assert.ok(map.sourcesContent.every(source => typeof source === "string"));
    }
  }
});
