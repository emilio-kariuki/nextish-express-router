import fs from "fs";
import path from "path";
import express from "express";
import chokidar from "chokidar";
import { dirPathToRoute } from "./transform";
import { assertNoRouteConflicts } from "./conflicts";
import { getHandlers, registerRouteHandlers } from "./handlers";
import { createModuleLoader, readModuleRevision } from "./modules";
import type { LoadedModule, ModuleLoadError, ModuleRevision } from "./modules";
import type { CreateRouterOptions, RouteDefinition, RouteInfo, RouteModule, RouteMount } from "./types";

const DEFAULT_EXT = [".ts", ".js", ".tsx", ".jsx", ".cjs", ".mjs"];
const express5 = Number((require("express/package.json") as { version: string }).version.split(".")[0]) >= 5;
const sameRevision = (a: ModuleRevision | null | undefined, b: ModuleRevision | null | undefined) =>
  a?.mtimeMs === b?.mtimeMs && a?.ctimeMs === b?.ctimeMs && a?.size === b?.size && a?.ino === b?.ino;

type RouterInternals = express.Router & {
  caseSensitive?: boolean;
  strict?: boolean;
};

type MountedInfo = {
  file: string;
  layers: express.Router["stack"];
  route: string;
  methods: string[];
  specificity: number[];
  manifest: RouteInfo[];
};

export async function mountDirectoryRoutes(
  appOrRouter: express.Application | express.Router,
  options: CreateRouterOptions = {}
): Promise<RouteMount> {
  const apiDir = path.resolve(options.apiDir ?? "api");
  const extensions = (options.extensions ?? DEFAULT_EXT).map(ext => ext.replace(/^\./, ""));
  const routeFilenames = new Set(extensions.map(ext => `route.${ext}`));
  const middlewareFilenames = new Set(extensions.map(ext => `middleware.${ext}`));
  const filenames = new Set([...routeFilenames, ...middlewareFilenames]);
  const prefix = options.routePrefix ?? "";
  const devMode = options.devMode ?? !!options.watch;
  const logger = options.logger ?? ((message: string) => console.log(message));
  let parentRouter = ("settings" in appOrRouter
    ? (express5 ? appOrRouter.router : appOrRouter._router)
    : appOrRouter) as RouterInternals | undefined;
  const routerOptions = {
    caseSensitive: parentRouter?.caseSensitive ?? ("settings" in appOrRouter && appOrRouter.enabled("case sensitive routing")),
    strict: parentRouter?.strict ?? ("settings" in appOrRouter && appOrRouter.enabled("strict routing")),
  };
  // Keep this mount's position even when it has no routes.
  const anchor = express.Router().use((_req, _res, next) => next()).stack[0];
  let published = new Set([anchor]);
  const moduleLoader = createModuleLoader();
  let modules = new Map<string, LoadedModule>();
  const unpublishedDependencies = new Map<string, Pick<LoadedModule, "dependencies" | "revisions">>();
  const pendingChanges = new Map<string, number>();
  let revision = 0;
  let manifest: RouteInfo[] = [];
  let initializing = true;
  let startupError: unknown;
  let closed = false;
  let closing: Promise<void> | undefined;
  let queued = false;
  let processing: Promise<void> | undefined;
  let latestChange = apiDir;
  const watchers = new Set<ReturnType<typeof chokidar.watch>>();
  let dependencyWatcher: ReturnType<typeof chokidar.watch> | undefined;
  let watchedDependencies = new Set<string>();
  const shutdown = new AbortController();

  const canonical = (file: string): string => {
    const absolute = path.resolve(file);
    try {
      return fs.realpathSync(absolute);
    } catch {
      const parent = path.dirname(absolute);
      return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
    }
  };

  const visiblePath = (file: string) => {
    const relative = path.relative(apiDir, path.resolve(file));
    return !path.isAbsolute(relative) && !relative.split(path.sep).some(segment => segment.startsWith("."));
  };

  const scan = (directory: string): string[] => {
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...scan(file));
      else if (entry.isFile() && filenames.has(entry.name)) files.push(file);
    }
    return files;
  };

  const buildFile = (file: string, fullRoute: string, mod: unknown, inherited: express.RequestHandler[]): MountedInfo => {
    const replacement = express.Router(routerOptions);
    const resource = replacement.route(fullRoute);
    const methods = registerRouteHandlers(resource, mod, file, inherited);
    const specificity = path.relative(apiDir, path.dirname(file)).split(path.sep).filter(Boolean).map(segment => {
      if (segment.startsWith("[[...")) return 3;
      if (segment.startsWith("[...")) return 2;
      return segment.startsWith("[") ? 1 : 0;
    });
    const routeModule = mod as RouteModule;
    const records = methods.map(method => {
      const value = method === "ALL"
        ? (routeModule.default ?? routeModule.handler)
        : (routeModule[method as keyof RouteModule] ?? routeModule[method.toLowerCase() as keyof RouteModule]);
      const definition = value && typeof value === "object" && !Array.isArray(value) ? value as RouteDefinition : undefined;
      for (const docs of [routeModule.docs, definition?.docs]) {
        if (docs !== undefined && (docs === null || typeof docs !== "object" || Array.isArray(docs))) {
          throw new TypeError(`Invalid docs export in ${file}`);
        }
      }
      const shared = routeModule.docs;
      const own = definition?.docs;
      const docs = shared || own ? {
        ...shared, ...own,
        ...(shared?.schemas || own?.schemas ? { schemas: { ...shared?.schemas, ...own?.schemas } } : {}),
        ...(shared?.responses || own?.responses ? { responses: { ...shared?.responses, ...own?.responses } } : {}),
      } : undefined;
      return { path: fullRoute, method: method as RouteInfo["method"], file, ...(docs ? { docs } : {}) };
    });
    return { file, layers: replacement.stack, route: fullRoute, methods, specificity, manifest: records };
  };

  const publish = (next: Map<string, MountedInfo>) => {
    const routes = [...next.values()].sort((a, b) => {
      for (let i = 0; i < Math.max(a.specificity.length, b.specificity.length); i++) {
        const difference = (a.specificity[i] ?? -1) - (b.specificity[i] ?? -1);
        if (difference) return difference;
      }
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    });
    const layers = [anchor, ...routes.flatMap(info => info.layers)];
    const nextManifest = structuredClone(routes.flatMap(info => info.manifest));
    logger("Loaded routes:\n" + routes.flatMap(info => info.methods.map(method => `${method.padEnd(6)} ${info.route}`)).join("\n"));
    if (closed) return;
    if (!parentRouter) {
      const app = appOrRouter as express.Application & { lazyrouter(): void };
      app.lazyrouter();
      parentRouter = app._router as RouterInternals;
    }
    const stack = parentRouter.stack;
    const position = stack.indexOf(anchor);
    const start = position < 0 ? stack.length : position;
    // Express captures the stack per request; replacing it leaves in-flight dispatch unchanged.
    parentRouter.stack = [
      ...stack.slice(0, start),
      ...layers,
      ...stack.slice(start).filter(layer => !published.has(layer)),
    ];
    published = new Set(layers);
    manifest = nextManifest;
  };

  const report = (message: string) => {
    // A failing diagnostic sink must not create an unhandled background rejection.
    try { logger(message); } catch { /* The mounted routes remain available. */ }
  };
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const waitForReady = (watcher: ReturnType<typeof chokidar.watch>) => new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      watcher.off("ready", ready);
      watcher.off("error", fail);
      shutdown.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const fail = (error: unknown) => finish(error || new Error("File watcher failed"));
    const abort = () => finish(new Error("Router closed"));
    watcher.once("ready", ready);
    watcher.once("error", fail);
    shutdown.signal.addEventListener("abort", abort, { once: true });
    if (closed) abort();
  });
  const listenForErrors = (watcher: ReturnType<typeof chokidar.watch>) => {
    watcher.on("error", error => {
      if (initializing) startupError ??= error || new Error("File watcher failed");
      else if (!closed) report(`Error watching ${apiDir}: ${describe(error)}`);
    });
  };

  const dependencyPaths = (entries: typeof modules) => {
    const paths = new Set<string>();
    const entryFiles = new Set([...entries.keys()].map(canonical));
    for (const { dependencies } of [...entries.values(), ...unpublishedDependencies.values()]) {
      for (const file of dependencies) {
        const normalized = canonical(file);
        const relative = path.relative(canonical(apiDir), normalized);
        const primary = !path.isAbsolute(relative) && !relative.split(path.sep).some(segment => segment.startsWith("."))
          && filenames.has(path.basename(file));
        if (!primary && !entryFiles.has(normalized)) paths.add(normalized);
      }
    }
    return paths;
  };

  const ensureDependencyWatch = async (entries: typeof modules): Promise<boolean> => {
    const dependencies = dependencyPaths(entries);
    const added = [...dependencies].filter(file => !watchedDependencies.has(file));
    if (!options.watch || closed || added.length === 0) return true;
    const paths = new Set([...watchedDependencies, ...dependencies]);
    const ancestors = new Set<string>();
    const roots = new Set<string>();
    for (const file of paths) {
      let directory = file;
      for (;;) {
        ancestors.add(directory);
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      directory = path.dirname(file);
      while (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      roots.add(directory);
    }
    // Watch existing ancestors so creating a missing helper's parent directory is visible.
    const watcher = chokidar.watch([...roots], {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (file, stats) => !!stats?.isSymbolicLink() || !ancestors.has(canonical(file)),
    });
    watchers.add(watcher);
    listenForErrors(watcher);
    watcher.on("all", (event, file) => {
      if (paths.has(canonical(file)) && (event === "add" || event === "change" || event === "unlink")) enqueue(file);
    });
    try {
      await waitForReady(watcher);
    } catch (error) {
      await watcher.close();
      watchers.delete(watcher);
      throw error;
    }
    if (closed) return true;
    const previous = dependencyWatcher;
    dependencyWatcher = watcher;
    watchedDependencies = paths;
    if (previous) {
      await previous.close();
      watchers.delete(previous);
    }
    if (!devMode || closed) return true;
    const current = new Map(added.map(file => [file, readModuleRevision(file)]));
    const changed = new Set<string>();
    const graphs = [...entries, ...unpublishedDependencies];
    for (const [, entry] of graphs) {
      for (const [file, revision] of current) {
        if (!entry.dependencies.has(file)) continue;
        if (!sameRevision(entry.revisions.get(file), revision)) changed.add(file);
      }
    }
    // An import can pause before its helpers are watched; retry any graph read before an edit.
    for (const file of changed) enqueue(file);
    for (const [file, entry] of graphs) {
      if ([...changed].some(dependency => entry.dependencies.has(dependency))) enqueue(file);
    }
    return changed.size === 0;
  };

  const rebuild = async (): Promise<boolean> => {
    const changes = new Map(pendingChanges);
    for (const [file, version] of changes) {
      if (![...modules.keys()].some(entry => canonical(entry) === file)) continue;
      const current = readModuleRevision(file);
      const consumers = [...modules.values()].filter(entry => entry.dependencies.has(file));
      // Native watchers may deliver startup notifications after the source was already read.
      if (consumers.every(entry => sameRevision(entry.revisions.get(file), current))) {
        changes.delete(file);
        if (pendingChanges.get(file) === version) pendingChanges.delete(file);
      }
    }
    if (!initializing && changes.size === 0) return true;
    const files = scan(apiDir).sort();
    const routes = files.filter(file => routeFilenames.has(path.basename(file))).map(file => {
      let route = path.posix.join(prefix, dirPathToRoute(apiDir, file, express5).route);
      route = express5
        ? route.replace(/\/\{\*([^}]+)\}/g, (match, name: string, offset: number) => offset === 0 ? match : `{/*${name}}`)
        : route.replace(/\\/g, "/");
      return { file, route };
    });
    assertNoRouteConflicts(routes, routerOptions.caseSensitive);
    const middlewareFiles = new Map<string, string>();
    for (const file of files.filter(file => middlewareFilenames.has(path.basename(file)))) {
      const directory = path.dirname(file);
      const previous = middlewareFiles.get(directory);
      if (previous) throw new Error(`Conflicting directory middleware files: ${previous} and ${file}`);
      middlewareFiles.set(directory, file);
    }

    if (devMode) moduleLoader.invalidate(changes.keys());
    const dependencyChanges = new Set([...changes.keys()].filter(changedFile =>
      [...modules].some(([file, mod]) => canonical(file) !== changedFile && mod.dependencies.has(changedFile))
      || [...unpublishedDependencies].some(([file, entry]) => canonical(file) !== changedFile && entry.dependencies.has(changedFile))
    ));
    const nextModules: typeof modules = new Map();
    const loaded = new Set<string>();
    const readModule = async (file: string) => {
      let mod = modules.get(file);
      const changed = [...changes.keys()].filter(changedFile => changedFile === canonical(file)
        || mod?.dependencies.has(changedFile) || unpublishedDependencies.get(file)?.dependencies.has(changedFile));
      if (changed.length || !mod) {
        // Consume only the attempted revision; an edit during an async import remains queued.
        for (const changedFile of changed) {
          if (!dependencyChanges.has(changedFile) && pendingChanges.get(changedFile) === changes.get(changedFile)) {
            pendingChanges.delete(changedFile);
          }
        }
        try {
          mod = await moduleLoader.load(file, devMode);
          unpublishedDependencies.set(file, { dependencies: mod.dependencies, revisions: mod.revisions });
          loaded.add(file);
        } catch (error) {
          const failure = error as Partial<ModuleLoadError> | null;
          if (failure?.dependencies) unpublishedDependencies.set(file, {
            dependencies: new Set([...failure.dependencies].map(canonical)),
            revisions: failure.revisions ?? new Map(),
          });
          throw error;
        }
      }
      nextModules.set(file, mod);
      return mod.exports;
    };
    const middleware = new Map<string, express.RequestHandler[]>();
    for (const [directory, file] of middlewareFiles) {
      const mod = await readModule(file);
      if (mod === null || (typeof mod !== "object" && typeof mod !== "function")) {
        throw new TypeError(`Invalid directory middleware module: ${file}`);
      }
      const exports = mod as { middleware?: unknown; default?: unknown };
      middleware.set(directory, getHandlers(
        exports.middleware === undefined ? exports.default : exports.middleware, file, "directory middleware"
      ));
    }

    const next = new Map<string, MountedInfo>();
    for (const { file, route } of routes) {
      let directory = apiDir;
      const inherited = [...(middleware.get(directory) ?? [])];
      for (const segment of path.relative(apiDir, path.dirname(file)).split(path.sep).filter(Boolean)) {
        directory = path.join(directory, segment);
        inherited.push(...(middleware.get(directory) ?? []));
      }
      next.set(file, buildFile(file, route, await readModule(file), inherited));
    }
    if (!await ensureDependencyWatch(nextModules)) return false;
    if (closed) return true;
    if (startupError) throw startupError;
    publish(next);
    if (closed) return true;
    // Cache only published modules so a failed reload cannot surface in an unrelated update.
    modules = nextModules;
    for (const [file, version] of changes) if (pendingChanges.get(file) === version) pendingChanges.delete(file);
    for (const file of unpublishedDependencies.keys()) {
      if (loaded.has(file) || !modules.has(file)) unpublishedDependencies.delete(file);
    }
    const dependencies = dependencyPaths(modules);
    const removed = [...watchedDependencies].filter(file => !dependencies.has(file));
    if (removed.length) await dependencyWatcher?.unwatch(removed);
    watchedDependencies = dependencies;
    return true;
  };

  const drain = (): Promise<void> => {
    if (processing) return processing;
    processing = (async () => {
      while (queued && !closed) {
        queued = false;
        if (!pendingChanges.size) continue;
        try {
          await rebuild();
        } catch (error) {
          if (!closed) {
            try { await ensureDependencyWatch(modules); }
            catch (watchError) { report(`Error watching ${apiDir}: ${describe(watchError)}`); }
            report(`Error reloading ${latestChange}: ${describe(error)}`);
          }
        }
      }
    })().finally(() => {
      processing = undefined;
      if (queued && !closed) void drain();
    });
    return processing;
  };
  const enqueue = (file: string) => {
    if (closed) return;
    latestChange = path.resolve(file);
    pendingChanges.set(canonical(file), ++revision);
    queued = true;
    if (!initializing) void drain();
  };
  const close = () => {
    closed = true;
    shutdown.abort();
    return closing ??= (async () => {
      await Promise.all([...watchers].map(watcher => watcher.close()));
      await moduleLoader.close();
    })();
  };

  try {
    if (options.watch) {
      const watcher = chokidar.watch(apiDir, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: (file, stats) => {
          // Chokidar needs the parent watcher when the API directory does not exist yet.
          const ancestor = path.relative(apiDir, path.resolve(file)).split(path.sep).every(segment => segment === "..");
          return (!visiblePath(file) && !ancestor) || !!stats?.isSymbolicLink()
            || (!!stats?.isFile() && !filenames.has(path.basename(file)));
        },
      });
      watchers.add(watcher);
      listenForErrors(watcher);
      watcher.on("all", (event, file) => {
        if (closed || !visiblePath(file) || !filenames.has(path.basename(file))) return;
        if (event !== "add" && event !== "change" && event !== "unlink") return;
        const abs = path.resolve(file);
        try {
          if (event !== "unlink" && !fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile()) return;
          enqueue(abs);
        } catch (error) {
          report(`Error reloading ${abs}: ${describe(error)}`);
        }
      });
      await waitForReady(watcher);
    }

    while (!await rebuild()) { /* Newly watched helpers changed during loading. */ }
    initializing = false;
    if (queued) await drain();
    return Object.assign(close, { getRoutes: () => structuredClone(manifest) });
  } catch (error) {
    await close();
    throw error;
  }
}
