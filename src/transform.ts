import path from "path";

export function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** Convert a route file's directory into the receiving Express version's syntax. */
export function dirPathToRoute(pagesDir: string, filePath: string, express5 = false): { route: string } {
  const relDir = path.relative(pagesDir, path.dirname(filePath));
  if (relDir === ".." || relDir.startsWith(`..${path.sep}`) || path.isAbsolute(relDir)) {
    throw new Error(`Route file must be inside ${pagesDir}: ${filePath}`);
  }

  const segments = relDir.split(path.sep).filter(segment => segment && !isRouteGroup(segment));
  const nameFor = (name: string) => {
    if (!name.trim() || name === "..." || /[{}\\]/.test(name)) {
      throw new Error(`Invalid route parameter: ${name}`);
    }
    if (!express5 && !/^\w+$/.test(name)) {
      throw new Error(`Invalid route parameter: ${name}; Express 4's path-to-regexp 0.1.x only supports letters, digits, and underscores in parameter names`);
    }
    return express5 && !/^[A-Za-z_$][\w$]*$/.test(name) ? JSON.stringify(name) : name;
  };
  const transformedSegments = segments.map(seg => {
    const optionalCatchAll = seg.match(/^\[\[\.\.\.([^[\]]+)\]\]$/);
    if (optionalCatchAll) return express5 ? `{*${nameFor(optionalCatchAll[1])}}` : `:${nameFor(optionalCatchAll[1])}(*)?`;

    const dynamic = seg.match(/^\[(\.\.\.)?([^[\]]+)\]$/);
    if (dynamic) return express5
      ? `${dynamic[1] ? "*" : ":"}${nameFor(dynamic[2])}`
      : `:${nameFor(dynamic[2])}${dynamic[1] ? "(.+)" : ""}`;

    if (seg.includes("[") || seg.includes("]")) {
      throw new Error(`Invalid route parameter: ${seg}`);
    }

    if (!express5 && seg.includes("?")) {
      throw new Error(`Invalid static route segment in ${filePath}: Express 4 cannot match a literal ? because it separates the URL query`);
    }
    return express5 ? seg.replace(/[(){}?+!*:\\]/g, "\\$&") : seg.replace(/[(){}+*:\\^$|]/g, "\\$&");
  });

  const route = "/" + transformedSegments.join("/");
  return { route: express5
    ? route.replace(/\/\{\*([^}]+)\}/g, (match, name: string, offset: number) => offset === 0 ? match : `{/*${name}}`)
    : route };
}
