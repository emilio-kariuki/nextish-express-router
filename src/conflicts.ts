import express from "express";
import { pathToRegexp } from "path-to-regexp";

export function assertNoRouteConflicts(
  routes: Iterable<{ file: string; route: string }>,
  caseSensitive = false
): void {
  const patterns = new Map<string, { file: string; route: string }>();
  for (const entry of routes) {
    const router = express.Router({ caseSensitive });
    router.route(entry.route);
    const regexp = (router.stack[0].regexp as RegExp | undefined)
      ?? pathToRegexp(entry.route, { sensitive: caseSensitive }).regexp;
    // Express 4 uses non-Unicode case folding; escapes such as \D must keep their meaning.
    const pattern = caseSensitive ? regexp.source : regexp.source.replace(/\\.|./g, character => {
      if (character.startsWith("\\")) return character;
      const upper = character.toUpperCase();
      return upper.length === 1 && (character.charCodeAt(0) < 128 || upper.charCodeAt(0) >= 128)
        ? upper : character;
    });
    const previous = patterns.get(pattern);
    if (previous && previous.file !== entry.file) {
      throw new Error(`Route conflict: ${previous.file} (${previous.route}) and ${entry.file} (${entry.route}) match the same route pattern`);
    }
    patterns.set(pattern, entry);
  }
}
