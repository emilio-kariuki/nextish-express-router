import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InitializeHook, LoadHook, ResolveHook } from "node:module";
import type { MessagePort } from "node:worker_threads";

export const MODULE_QUERY = "__nextish_module";
export const INSPECT_QUERY = "__nextish_format";

export interface ModuleRevision {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

export const readModuleRevision = (file: string): ModuleRevision | null => {
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile()) return null;
    const { mtimeMs, ctimeMs, size, ino } = stats;
    return { mtimeMs, ctimeMs, size, ino };
  } catch {
    return null;
  }
};

export type HookRequest = {
  request: number;
  namespace: string;
  operation: "open" | "snapshot" | "close";
  generation?: number;
  entry?: string;
};

export type HookSnapshot = {
  dependencies: string[];
  revisions: Map<string, ModuleRevision | null>;
};

type Graph = Map<string, Set<string>>;
type Generation = { graph: Graph; revisions: HookSnapshot["revisions"] };
const namespaces = new Map<string, Map<number, Generation>>();

const localFile = (url: string): string | undefined => {
  if (!url.startsWith("file:")) return;
  const file = fileURLToPath(url);
  if (!file.split(path.sep).includes("node_modules") && path.extname(file) !== ".node") return file;
};

const contextFor = (url: string | undefined) => {
  if (!url?.startsWith("file:")) return;
  const token = new URL(url).searchParams.get(MODULE_QUERY);
  if (!token) return;
  const separator = token.lastIndexOf(":");
  const namespace = token.slice(0, separator);
  const generations = namespaces.get(namespace);
  if (!generations) return;
  const generation = Number(token.slice(separator + 1));
  let state = generations.get(generation);
  if (!state) generations.set(generation, state = { graph: new Map(), revisions: new Map() });
  return { token, ...state };
};

const record = (graph: Graph, parent: string | undefined, child: string) => {
  if (!parent) return;
  const children = graph.get(parent) ?? new Set<string>();
  children.add(child);
  graph.set(parent, children);
};

export const initialize: InitializeHook<{ port: MessagePort }> = ({ port }) => {
  port.on("message", (message: HookRequest) => {
    let dependencies: string[] = [];
    const revisions: HookSnapshot["revisions"] = new Map();
    if (message.operation === "open") namespaces.set(message.namespace, new Map());
    else if (message.operation === "close") namespaces.delete(message.namespace);
    else {
      const state = namespaces.get(message.namespace)?.get(message.generation!);
      const seen = new Set<string>();
      const queue = message.entry ? [message.entry] : [];
      for (const file of queue) {
        if (seen.has(file)) continue;
        seen.add(file);
        if (state?.revisions.has(file)) revisions.set(file, state.revisions.get(file)!);
        for (const dependency of state?.graph.get(file) ?? []) queue.push(dependency);
      }
      dependencies = [...seen];
    }
    port.postMessage({ request: message.request, dependencies, revisions });
  });
  port.unref();
};

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const scope = contextFor(context.parentURL) ?? contextFor(specifier);
  if (!scope) return nextResolve(specifier, context);
  const parent = context.parentURL && localFile(context.parentURL);
  try {
    const result = await nextResolve(specifier, context);
    const file = localFile(result.url);
    if (!file) return result;
    record(scope.graph, parent || undefined, file);
    const url = new URL(result.url);
    url.searchParams.set(MODULE_QUERY, scope.token);
    return { ...result, url: url.href };
  } catch (error) {
    if (parent) {
      const failedURL = error instanceof Error && "url" in error && typeof error.url === "string"
        ? error.url : undefined;
      const candidate = failedURL ?? (/^(\.{1,2}\/|\/|file:)/.test(specifier)
        ? new URL(specifier, context.parentURL).href : undefined);
      const file = candidate && localFile(candidate);
      if (file) {
        record(scope.graph, parent, file);
        if (!scope.revisions.has(file)) scope.revisions.set(file, null);
      }
    }
    throw error;
  }
};

export const load: LoadHook = async (url, context, nextLoad) => {
  const scope = contextFor(url);
  const inspect = scope && new URL(url).searchParams.has(INSPECT_QUERY);
  const file = scope && localFile(url);
  // Top-level await can outlast watcher setup, so preserve the revision from before Node reads the source.
  if (scope && file && !inspect && !scope.revisions.has(file)) scope.revisions.set(file, readModuleRevision(file));
  const result = await nextLoad(url, context);
  if (!inspect) return result;
  return { ...result, format: "module", source: `export default ${JSON.stringify(result.format)};` };
};
