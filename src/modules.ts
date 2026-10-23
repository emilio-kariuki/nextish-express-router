import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Module, { register } from "node:module";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { INSPECT_QUERY, MODULE_QUERY, readModuleRevision } from "./esm-hooks";
import type { HookRequest, HookSnapshot, ModuleRevision } from "./esm-hooks";

export { readModuleRevision };
export type { ModuleRevision };
export type LoadedModule = {
  exports: unknown;
  dependencies: Set<string>;
  revisions: Map<string, ModuleRevision | null>;
};
export type ModuleLoadError = Error & Pick<LoadedModule, "dependencies" | "revisions">;

// TypeScript's CommonJS emit rewrites import(), so preserve the native ESM loader.
const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, unknown>>;

async function importModule(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([nativeImport(url), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort!);
  }
}

const localFile = (file: string) => !file.split(path.sep).includes("node_modules") && path.extname(file) !== ".node";

type CommonJSGraph = Map<string, Set<string>>;
type CommonJSObservation = { graph: CommonJSGraph; modules: Map<string, NodeJS.Module> };
const observations = new Set<CommonJSObservation>();
const commonJSRevisions = new WeakMap<NodeJS.Module, ModuleRevision | null>();
let stopObserving: (() => void) | undefined;
// shortcut: The minimum Node version has no synchronous hooks; replace this observer when registerHooks is the baseline.
const commonJSPrototype = Module.prototype as NodeJS.Module & { load(file: string): void };

function observeCommonJS() {
  const observation: CommonJSObservation = { graph: new Map(), modules: new Map() };
  if (!observations.size) {
    const original = commonJSPrototype.load;
    // Failed evaluation removes modules from require.cache before we can inspect their children.
    const load = function(this: NodeJS.Module, file: string) {
      const parent = this.parent?.filename;
      if (localFile(file)) {
        commonJSRevisions.set(this, readModuleRevision(file));
        for (const observation of observations) {
          observation.modules.set(file, this);
          if (parent && localFile(parent)) {
            const children = observation.graph.get(parent) ?? new Set<string>();
            children.add(file);
            observation.graph.set(parent, children);
          }
        }
      }
      return original.call(this, file);
    };
    commonJSPrototype.load = load;
    stopObserving = () => {
      if (commonJSPrototype.load === load) commonJSPrototype.load = original;
    };
  }
  observations.add(observation);
  return {
    ...observation,
    close() {
      observations.delete(observation);
      if (!observations.size) stopObserving?.();
    },
  };
}

const canonicalFile = (file: string): string => {
  const absolute = path.resolve(file);
  let parent = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(parent), path.relative(parent, absolute));
    } catch {
      const next = path.dirname(parent);
      if (next === parent) return absolute;
      parent = next;
    }
  }
};

type HookMessage = Omit<HookRequest, "request">;
type HookBridge = { request(message: HookMessage): Promise<HookSnapshot> };
let hooks: HookBridge | undefined;

function getHooks(): HookBridge {
  if (hooks) return hooks;
  const { port1, port2 } = new MessageChannel();
  const pending = new Map<number, (snapshot: HookSnapshot) => void>();
  let sequence = 0;
  port1.on("message", (message: HookSnapshot & { request: number }) => {
    pending.get(message.request)?.(message);
    pending.delete(message.request);
    if (!pending.size) port1.unref();
  });
  try {
    register(pathToFileURL(require.resolve("./esm-hooks")), { data: { port: port2 }, transferList: [port2] });
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  port1.unref();
  return hooks = {
    request: message => new Promise(resolve => {
      const request = ++sequence;
      pending.set(request, resolve);
      port1.ref();
      port1.postMessage({ ...message, request });
    }),
  };
}

const usesNativeImport = (file: string): boolean => {
  const extension = path.extname(file);
  if ([".mjs", ".mts", ".js"].includes(extension)) return true;
  if ([".cjs", ".cts"].includes(extension)) return false;
  let directory = path.dirname(file);
  for (;;) {
    const packageFile = path.join(directory, "package.json");
    if (fs.existsSync(packageFile)) {
      return JSON.parse(fs.readFileSync(packageFile, "utf8")).type === "module";
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
};

const commonJSDependencies = (files: Iterable<string>, dependencies: Set<string>, graph: CommonJSGraph) => {
  // shortcut: Synchronous require(ESM) bypasses these hooks; revisit with synchronous ESM resolution hooks.
  const seen = new Set<string>();
  const queue = [...files];
  for (const file of queue) {
    if (seen.has(file) || !localFile(file)) continue;
    seen.add(file);
    dependencies.add(file);
    for (const child of require.cache[file]?.children ?? []) queue.push(child.filename);
    for (const child of graph.get(file) ?? []) queue.push(child);
  }
};

const failedCommonJSDependencies = (error: unknown, entry: string, dependencies: Set<string>) => {
  if (!(error instanceof Error)) return;
  const failure = error as NodeJS.ErrnoException & { requireStack?: string[]; path?: string };
  const stack = failure.requireStack ?? [];
  for (const file of stack) {
    if (localFile(file)) dependencies.add(canonicalFile(file));
    if (canonicalFile(file) === entry) break;
  }
  if (failure.code !== "MODULE_NOT_FOUND") return;
  const specifier = /^Cannot find module '([^']+)'/.exec(failure.message)?.[1];
  if (failure.path && localFile(failure.path)) dependencies.add(canonicalFile(failure.path));
  if (!specifier || (!path.isAbsolute(specifier) && !specifier.startsWith("."))) return;
  const candidate = canonicalFile(path.resolve(path.dirname(stack[0] ?? entry), specifier));
  if (!localFile(candidate)) return;
  dependencies.add(candidate);
  if (!path.extname(candidate)) {
    const extensions = new Set([...Object.keys(require.extensions), ".js", ".json", ".ts", ".tsx", ".jsx", ".cjs", ".mjs"]);
    for (const extension of extensions) {
      if (extension === ".node") continue;
      dependencies.add(candidate + extension);
      dependencies.add(path.join(candidate, "index" + extension));
    }
    dependencies.add(path.join(candidate, "package.json"));
  }
};

export function createModuleLoader() {
  const namespace = randomUUID();
  let generation = 0;
  const loaded = new Map<string, LoadedModule>();
  const attempted = new Map<string, number>();
  const invalidated = new Set<string>();
  const knownDependencies = new Set<string>();
  const evaluatedCommonJS = new WeakMap<NodeJS.Module, number>();
  const shutdown = new AbortController();
  let session: Promise<HookBridge> | undefined;
  let closing: Promise<void> | undefined;

  const startHooks = () => session ??= (async () => {
    const bridge = getHooks();
    await bridge.request({ operation: "open", namespace });
    return bridge;
  })();

  const invalidate = (files: Iterable<string>) => {
    const affected = new Set([...files].map(canonicalFile).filter(localFile));
    if (!affected.size) return;
    generation++;
    for (const [entry, result] of loaded) {
      if ([...result.dependencies].some(file => affected.has(canonicalFile(file)))) invalidated.add(entry);
    }
    let previousSize;
    do {
      previousSize = affected.size;
      for (const file of knownDependencies) {
        if (require.cache[file]?.children.some(child => affected.has(child.filename))) affected.add(file);
      }
    } while (affected.size !== previousSize);
    for (const file of affected) delete require.cache[file];
  };

  const loadFile = async (file: string, fresh: boolean): Promise<LoadedModule> => {
    const entry = canonicalFile(file);
    const previous = loaded.get(entry);
    if (!fresh && !invalidated.has(entry) && previous) return previous;
    if (attempted.get(entry) === generation) generation++;
    const revision = generation;
    attempted.set(entry, revision);
    const cached = require.cache[entry];
    if ((fresh || invalidated.has(entry)) && (!cached || evaluatedCommonJS.get(cached) !== revision)) delete require.cache[entry];
    const dependencies = new Set([path.resolve(file), entry]);
    const revisions: LoadedModule["revisions"] = new Map();
    const cachedBefore = new WeakMap<NodeJS.Module, ModuleRevision | null>();
    for (const [file, mod] of Object.entries(require.cache)) {
      if (mod && localFile(file) && !commonJSRevisions.has(mod)) cachedBefore.set(mod, readModuleRevision(file));
    }
    const observation = observeCommonJS();
    let bridge: HookBridge | undefined;
    const snapshot = async () => {
      if (!bridge || shutdown.signal.aborted) return;
      const captured = await bridge.request({ operation: "snapshot", namespace, generation: revision, entry });
      for (const dependency of captured.dependencies) dependencies.add(dependency);
      for (const [file, value] of captured.revisions) revisions.set(canonicalFile(file), value);
    };
    const collectCommonJS = () => {
      commonJSDependencies(dependencies, dependencies, observation.graph);
      for (const dependency of dependencies) {
        const file = canonicalFile(dependency);
        const observed = observation.modules.get(dependency) ?? observation.modules.get(file);
        const mod = observed ?? require.cache[dependency] ?? require.cache[file];
        if (mod) {
          if (observed) evaluatedCommonJS.set(mod, revision);
          if (commonJSRevisions.has(mod)) revisions.set(file, commonJSRevisions.get(mod)!);
          else {
            // External application modules keep their identity; watch from attachment when their original read is unknown.
            if (!revisions.has(file)) revisions.set(file, cachedBefore.has(mod) ? cachedBefore.get(mod)! : readModuleRevision(file));
            commonJSRevisions.set(mod, revisions.get(file)!);
          }
        }
        if (!revisions.has(file)) revisions.set(file, null);
      }
    };
    try {
      let exports: unknown;
      if (usesNativeImport(entry)) {
        bridge = await startHooks();
        const url = pathToFileURL(entry);
        // shortcut: Node retains ESM generations until exit; replace tagging when native cache eviction is available.
        url.searchParams.set(MODULE_QUERY, `${namespace}:${revision}`);
        let commonJS = false;
        if (path.extname(entry) === ".js") {
          // Ask Node for the format without evaluating a potentially CommonJS module through its ESM wrapper.
          url.searchParams.set(INSPECT_QUERY, "1");
          commonJS = (await importModule(url.href, shutdown.signal)).default === "commonjs";
          url.searchParams.delete(INSPECT_QUERY);
        }
        if (commonJS) exports = require(entry);
        else {
          const mod = await importModule(url.href, shutdown.signal);
          const cached = require.cache[entry];
          exports = cached?.loaded && mod.default === cached.exports ? cached.exports : mod;
        }
        await snapshot();
      } else {
        exports = require(entry);
      }
      shutdown.signal.throwIfAborted();
      collectCommonJS();
      for (const dependency of dependencies) knownDependencies.add(dependency);
      const result = { exports, dependencies, revisions };
      loaded.set(entry, result);
      invalidated.delete(entry);
      return result;
    } catch (error) {
      for (const dependency of previous?.dependencies ?? []) dependencies.add(dependency);
      for (const [file, value] of previous?.revisions ?? []) revisions.set(file, value);
      await snapshot();
      failedCommonJSDependencies(error, entry, dependencies);
      collectCommonJS();
      if (!shutdown.signal.aborted) {
        for (const dependency of dependencies) knownDependencies.add(dependency);
        invalidated.add(entry);
      }
      let failure = error instanceof Error ? error : new Error(String(error));
      try {
        Object.defineProperties(failure, {
          dependencies: { value: dependencies, configurable: true },
          revisions: { value: revisions, configurable: true },
        });
      } catch {
        failure = Object.assign(new Error(failure.message), { cause: error, dependencies, revisions });
      }
      throw failure;
    } finally {
      observation.close();
    }
  };

  return {
    invalidate,
    load(file: string, fresh = false) {
      if (closing || shutdown.signal.aborted) return Promise.reject(new Error("Module loader is closed"));
      return loadFile(file, fresh);
    },
    close() {
      return closing ??= (async () => {
        shutdown.abort(new Error("Module loader is closed"));
        const bridge = await session?.catch(() => undefined);
        if (bridge) await bridge.request({ operation: "close", namespace });
        loaded.clear();
        attempted.clear();
        invalidated.clear();
        knownDependencies.clear();
      })();
    },
  };
}
