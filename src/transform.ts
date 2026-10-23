import path from "path";

/** Convert a route file's directory into the receiving Express version's syntax. */
export function dirPathToRoute(pagesDir: string, filePath: string, express5 = false): { route: string } {
  const relDir = path.relative(pagesDir, path.dirname(filePath));
  if (relDir === ".." || relDir.startsWith(`..${path.sep}`) || path.isAbsolute(relDir)) {
    throw new Error(`Route file must be inside ${pagesDir}: ${filePath}`);
  }

  const segments = relDir.split(path.sep).filter(Boolean);
  const nameFor = (name: string) => express5 && /^\d/.test(name) ? JSON.stringify(name) : name;
  const transformedSegments = segments.map(seg => {
    const optionalCatchAll = seg.match(/^\[\[\.\.\.(\w+)\]\]$/);
    if (optionalCatchAll) return express5 ? `{*${nameFor(optionalCatchAll[1])}}` : `:${optionalCatchAll[1]}(*)?`;

    const dynamic = seg.match(/^\[(\.\.\.)?(\w+)\]$/);
    if (dynamic) return express5
      ? `${dynamic[1] ? "*" : ":"}${nameFor(dynamic[2])}`
      : `:${dynamic[2]}${dynamic[1] ? "(.+)" : ""}`;

    if (seg.includes("[") || seg.includes("]")) {
      throw new Error(`Invalid route parameter: ${seg}`);
    }

    return express5 ? seg.replace(/[(){}?+!*:\\]/g, "\\$&") : seg;
  });

  const route = "/" + transformedSegments.join("/");
  return { route: express5
    ? route.replace(/\/\{\*([^}]+)\}/g, (match, name: string, offset: number) => offset === 0 ? match : `{/*${name}}`)
    : route };
}
